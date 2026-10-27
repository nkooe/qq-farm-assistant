const { setTimeout: delay } = require('node:timers/promises');
const { runWithRequestClass } = require('../utils/request-context');
const { isGatewayHealthyForBusiness, isGatewayYieldError } = require('../utils/request-queue');
const { dateKey } = require('./friend-pet-cache');
const { toNum } = require('../utils/utils');

const TUNING = { startup: 90000, check: 600000, continuation: 180000, retry: 60000,
    cooldown: 1800000, gap: 2000, batchGap: 3000, taskWait: 10000, poll: 250 };

// Each Worker owns one runner. Dependencies are injectable to verify stop/reconnect races locally.
function createFriendPetSync(deps, tuning = {}) {
    const t = { ...TUNING, ...tuning };
    let active = false, running = false, visiting = false, timer = null, controller = null;
    let generation = 0, quota = 10, rampLocked = false, pacingDay = '', blockedUntil = 0;
    const now = deps.now || Date.now;
    const pause = deps.pause || ((ms, signal) => delay(ms, undefined, { signal }));
    const valid = (token, signal) => active && generation === token && !signal.aborted;
    const canRun = () => deps.enabled() && deps.connected() && !deps.quiet();
    const deferReason = () => isGatewayHealthyForBusiness(deps.load()) ? 'contention' : 'gateway_busy';

    async function round(token = generation, signal = controller?.signal) {
        if (running || !signal || !valid(token, signal) || !canRun()) return { reason: 'skipped' };
        if (now() < blockedUntil) return { reason: 'cooldown' };
        if (pacingDay !== dateKey(now())) { pacingDay = dateKey(now()); quota = 10; rampLocked = false; }
        running = true;
        let checked = 0, failed = 0;
        try {
            if (!await deps.idle(signal)) return { reason: deferReason() };
            if (!valid(token, signal) || !canRun()) return { reason: 'stopped' };
            const friends = await deps.listFriends();
            if (!valid(token, signal)) return { reason: 'stopped' };
            const seen = new Set(), targets = [];
            for (const friend of friends || []) {
                const gid = toNum(friend.gid);
                if (gid <= 0 || gid === deps.myGid() || seen.has(gid)) continue;
                seen.add(gid);
                if (deps.excluded(gid) || deps.known(gid)) continue;
                targets.push({ gid, name: friend.remark || friend.name || `GID:${gid}` });
            }
            if (!targets.length) return { reason: 'fresh', checked, failed };
            for (const friend of targets.slice(0, quota)) {
                if (!valid(token, signal) || !canRun()) return { reason: 'stopped', checked, failed };
                const until = now() + t.taskWait;
                while (deps.friendBusy() && now() < until) await pause(t.poll, signal);
                if (deps.friendBusy()) return { reason: 'contention', checked, failed };
                if (!await deps.idle(signal)) return { reason: deferReason(), checked, failed };
                if (!valid(token, signal) || !canRun()) return { reason: 'stopped', checked, failed };
                // Recheck after waiting: ordinary visits may already have populated this entry.
                if (deps.known(friend.gid)) continue;
                if (deps.friendBusy()) return { reason: 'contention', checked, failed };
                visiting = true;
                let entered = false;
                try {
                    await deps.enter(friend.gid, { signal, requestClass: 'background' });
                    entered = true;
                    if (deps.known(friend.gid)) checked++; else failed++;
                } catch (err) {
                    if (signal.aborted) return { reason: 'stopped', checked, failed };
                    if (isGatewayYieldError(err)) return { reason: deferReason(), checked, failed };
                    if (/超时|timeout|ECONN|EOF/i.test(err.message || '')) return { reason: 'gateway_busy', checked, failed };
                    failed++;
                    deps.onError?.(friend, err);
                } finally {
                    // A successful Enter always gets its Leave, even if stop arrived between them.
                    try {
                        if (entered) await runWithRequestClass('friend', () => deps.leave(friend.gid, { requestClass: 'friend' }));
                    } finally { visiting = false; }
                }
                await pause(t.gap, signal);
                if ((checked + failed) % 5 === 0) await pause(t.batchGap, signal);
            }
            const remaining = targets.filter(f => !deps.known(f.gid) && !deps.excluded(f.gid)).length;
            return { reason: remaining > 0 ? (failed ? 'failed' : 'quota') : 'done', checked, failed, remaining };
        } catch (err) {
            if (signal.aborted || !valid(token, signal)) return { reason: 'stopped', checked, failed };
            return { reason: isGatewayYieldError(err) ? deferReason() : 'gateway_busy', checked, failed };
        } finally { running = false; deps.flush(); }
    }
    function schedule(ms, token) {
        if (!active || token !== generation) return;
        timer = setTimeout(async () => {
            const result = await run();
            if (!active || token !== generation) return;
            let wait = t.check;
            if (['contention', 'gateway_busy'].includes(result.reason)) {
                quota = 10; rampLocked = true;
                wait = result.reason === 'contention' ? t.retry : t.cooldown;
                if (result.reason === 'gateway_busy') blockedUntil = now() + t.cooldown;
            } else if (result.reason === 'quota') {
                if (!rampLocked) quota = Math.min(25, quota + 5);
                wait = t.continuation;
            }
            deps.onRound?.(result);
            schedule(wait, token);
        }, ms);
        timer.unref?.();
    }
    function run() {
        return runWithRequestClass('background', () => round(), { signal: controller?.signal });
    }
    function stop() {
        active = false; generation++; clearTimeout(timer); timer = null;
        controller?.abort(new Error('请求已中断: 宠物同步停止'));
        deps.flush();
    }
    function start() {
        stop(); active = true; controller = new AbortController();
        quota = 10; rampLocked = false; pacingDay = ''; blockedUntil = 0;
        schedule(t.startup, generation);
    }
    return { start, stop, run, isVisiting: () => visiting, isRunning: () => running };
}

let runtime = null;
let runtimeGuards = {};
function getRuntime() {
    if (runtime) return runtime;
    const net = require('../utils/network'), store = require('../models/store');
    const api = require('./friend-api'), cache = require('./friend-pet-cache');
    const orchestrator = require('./friend-orchestrator');
    const { inFriendQuietHours } = api;
    runtime = createFriendPetSync({
        enabled: () => { const a = store.getAutomation(); return a.friend && (a.friend_help || orchestrator.computeEffectiveTurbo()) && (runtimeGuards.enabled?.() ?? true); },
        connected: net.isConnected, quiet: inFriendQuietHours,
        myGid: () => toNum(net.getUserState().gid), load: net.getGatewayLoad,
        idle: signal => net.waitForGatewayIdle(8000, signal),
        listFriends: async () => (await api.getAllFriends(false)).game_friends || [],
        excluded: gid => store.getFriendBlacklist(process.env.FARM_ACCOUNT_ID || '').map(Number).includes(gid) || api.getInvalidKnownFriendGidSet().has(gid),
        known: gid => cache.getState(gid) !== 'unknown',
        friendBusy: () => orchestrator.isCheckingFriendsRunning() || !!runtimeGuards.friendBusy?.(),
        enter: api.enterFriendFarm, leave: api.leaveFriendFarm, flush: cache.flushAll,
        onError: (friend, err) => api.handleFriendEnterError(friend.gid, friend.name, err),
        onRound: result => {
            if (result.checked || result.failed) require('../utils/utils').log('好友',
                `空闲宠物同步：确认 ${result.checked || 0}，失败 ${result.failed || 0}${result.remaining != null ? `，待补 ${result.remaining}` : ''}`, {
                    module: 'friend', event: '宠物空闲同步', ...result,
                });
        },
    });
    return runtime;
}
module.exports = { createFriendPetSync, TUNING,
    startFriendPetSync: (guards = {}) => { runtimeGuards = guards; getRuntime().start(); },
    stopFriendPetSync: () => runtime?.stop(),
    isPetSyncVisiting: () => !!runtime?.isVisiting() };
