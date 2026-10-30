const { Buffer } = require('node:buffer');
const EventEmitter = require('node:events');
/**
 * WebSocket 网络层 - 连接/消息编解码/登录/心跳
 */

const process = require('node:process');
const { performance } = require('node:perf_hooks');
const { URL } = require('node:url');
const WebSocket = require('ws');
const { CONFIG } = require('../config/config');
const { AceService } = require('../services/ace-service');
const { createScheduler } = require('../services/scheduler');
const { updateStatusFromLogin, updateStatusGold, updateStatusLevel } = require('../services/status');
const { recordOperation, recordTongQiGift, getTongQiGiftCount } = require('../services/stats');
const { types } = require('./proto');
const { toLong, toNum, syncServerTime, log, logWarn } = require('./utils');
const cryptoWasm = require('./crypto-wasm');
const { createGatewayToken } = require('./gateway-token');
const { TsdkRuntime } = require('./tsdk-runtime');
const { GatewayRequestQueue, isGatewayHealthyForBusiness, isGatewayIdleForBackground } = require('./request-queue');
const { getAmbientRequestSignal } = require('./request-context');
const { createClientProfile, usesPlayerSceneLogin } = require('./client-profile');
const { createProxyAgent } = require('../services/account-proxy');

// 延迟加载 warehouse 模块避免循环依赖
let warehouseModule = null;
function getWarehouseModule() {
    if (!warehouseModule) {
        warehouseModule = require('../services/warehouse');
    }
    return warehouseModule;
}

// 延迟加载 store 模块避免循环依赖
let storeModule = null;
function getStoreModule() {
    if (!storeModule) {
        storeModule = require('../models/store');
    }
    return storeModule;
}

// ============ 事件发射器 (用于推送通知) ============
const networkEvents = new EventEmitter();

// ============ 内部状态 ============
let ws = null;
let clientSeq = 1;
let serverSeq = 0;
const pendingCallbacks = new Map();
const recentRequestDiagnostics = [];
let connectionGeneration = 0;
let currentSession = null;
const requestQueue = new GatewayRequestQueue({ healthy: () => isGatewayHealthyForBusiness(getGatewayLoad()) });
let wsErrorState = { code: 0, at: 0, message: '' };
const networkScheduler = createScheduler('network');
let tsdkRuntime = null;
let aceService = null;
let initialGamePackInfo = '';

function logAce(level, message) {
    if (level === 'warn' || level === 'error') logWarn('ACE', message);
    else log('ACE', message);
}

function createTsdkRuntime(deviceProtocol, profile) {
    return new TsdkRuntime({
        accountId: process.env.FARM_ACCOUNT_ID,
        platform: profile.platform,
        gameId: profile.tsdkGameId,
        appKey: profile.tsdkAppKey,
        deviceInfo: {
            deviceModel: deviceProtocol && deviceProtocol.deviceModel,
            deviceBrand: deviceProtocol && deviceProtocol.deviceBrand,
            deviceId: deviceProtocol && deviceProtocol.deviceId,
            platform: profile.os,
        },
        logger: logAce,
    });
}

async function startSecurityRuntime(deviceProtocol, session) {
    stopSecurityRuntime('重新初始化');
    if (!session.profile.tsdkAceEnabled) {
        throw new Error('TSDK/ACE 已通过 FARM_TSDK_ACE_ENABLED=false 关闭，网关请求不会使用伪造 Token');
    }
    const runtime = createTsdkRuntime(deviceProtocol, session.profile);
    tsdkRuntime = runtime;
    initialGamePackInfo = '';
    cryptoWasm.setRuntime(tsdkRuntime);
    await runtime.init();
}

function startAceService() {
    if (!tsdkRuntime || !tsdkRuntime.ready) throw new Error('TSDK 尚未就绪');
    if (aceService) aceService.stop('重新启动');
    aceService = new AceService({
        runtime: tsdkRuntime,
        sendRequest: (service, method, body, timeout) => sendMsgAsync(service, method, body, timeout, { criticalLane: 'ace' }),
        isConnected,
        types,
        logger: logAce,
    });
    aceService.start();
}

function stopSecurityRuntime(reason = '停止') {
    if (aceService) {
        aceService.stop(reason);
        aceService = null;
    }
    if (tsdkRuntime) {
        tsdkRuntime.destroy();
        tsdkRuntime = null;
    }
    initialGamePackInfo = '';
    cryptoWasm.setRuntime(null);
}

function rejectAllPendingRequests(reason = '请求被中断') {
    connectionGeneration++;
    requestQueue.rejectAll(reason);
    const entries = Array.from(pendingCallbacks.entries());
    for (const [, callback] of entries) {
        try {
            callback(new Error(reason));
        } catch {
            // ignore callback failure
        }
    }
    pendingCallbacks.clear();
    return entries.length;
}

// ============ 用户状态 (登录后设置) ============
const userState = {
    gid: 0,
    name: '',
    level: 0,
    gold: 0,
    exp: 0,
    coupon: 0, // 点券(ID:1002)
    goldBean: 0, // 金豆豆(ID:1005)
    openId: '',
    avatar: '',
};

function getUserState() { return userState; }
function getWsErrorState() { return { ...wsErrorState }; }
function setWsErrorState(code, message) {
    wsErrorState = { code: Number(code) || 0, at: Date.now(), message: message || '' };
}
function clearWsErrorState() {
    wsErrorState = { code: 0, at: 0, message: '' };
}

function logLoginSummary(loginTimeMs) {
    const lines = [
        `GID: ${userState.gid}`,
        `昵称: ${userState.name}`,
        `等级: ${userState.level}`,
        `金币: ${userState.gold}`,
    ];
    if (loginTimeMs) {
        lines.push(`时间: ${new Date(loginTimeMs).toLocaleString()}`);
    }
    log('系统', `登录摘要\n${lines.join('\n')}`);
}

// 登录后从背包获取金豆豆数量
async function fetchGoldBeanFromBag(session) {
    try {
        const warehouse = getWarehouseModule();
        const bagReply = await warehouse.getBag();
        if (!isCurrentSession(session)) return;
        const items = warehouse.getBagItems(bagReply);
        for (const item of (items || [])) {
            const id = toNum(item && item.id);
            const count = toNum(item && item.count);
            if (id === 1005 && count > 0) {
                userState.goldBean = count;
                log('系统', `金豆豆数量: ${count}`);
                break;
            }
        }
    // eslint-disable-next-line unused-imports/no-unused-vars
    } catch (e) {
        // 忽略获取失败
    }
}

function hasOwn(obj, key) {
    return !!obj && Object.hasOwn(obj, key);
}

// ============ 消息编解码 ============
function encodeMsg(serviceName, methodName, encryptedBody, clientSeqValue) {
    const gatewayToken = initialGamePackInfo || createGatewayToken();
    initialGamePackInfo = '';
    const msg = types.GateMessage.create({
        meta: {
            service_name: serviceName,
            method_name: methodName,
            message_type: 1,
            client_seq: toLong(clientSeqValue),
            server_seq: toLong(serverSeq),
        },
        body: encryptedBody,
        auth_token: gatewayToken,
    });
    return types.GateMessage.encode(msg).finish();
}

async function sendMsg(serviceName, methodName, bodyBytes, callback, signal) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        log('系统', '[WS] 连接未打开');
        return false;
    }
    // Encoding is tracked before an on-wire sequence can safely be assigned.
    let seq = Symbol('encoding');
    const socket = ws;
    const generation = connectionGeneration;
    const startedAt = performance.now();
    const diagnostic = { at: Date.now(), generation, method: /^[\w.]{1,100}$/.test(methodName) ? methodName : '[method]',
        phase: 'encoding', encodeMs: null, responseMs: null, totalMs: 0, socketState: socket.readyState, queued: requestQueue.getLoad().queued };
    let sentAt = null;
    const done = (err, body, meta) => {
        if (pendingCallbacks.get(seq) !== done) return;
        pendingCallbacks.delete(seq);
        signal?.removeEventListener('abort', abort);
        diagnostic.totalMs = Math.round(performance.now() - startedAt);
        diagnostic.responseMs = sentAt === null ? null : Math.round(performance.now() - sentAt);
        diagnostic.socketState = socket.readyState;
        diagnostic.outcome = err ? signal?.aborted ? 'aborted' : 'failed' : 'ok';
        recentRequestDiagnostics.push({ ...diagnostic });
        if (recentRequestDiagnostics.length > 20) recentRequestDiagnostics.shift();
        if (err && (methodName === 'Heartbeat' || methodName === 'AntiData')) {
            logWarn('连接诊断', JSON.stringify(diagnostic));
        }
        callback?.(err, body, meta);
    };
    done.expectedErrorCodes = callback?.expectedErrorCodes;
    done.diagnostic = diagnostic;
    done.startedAt = startedAt;
    const abort = () => done(signal.reason || new Error('请求已中断'));
    if (callback) pendingCallbacks.set(seq, done);
    if (callback) signal?.addEventListener('abort', abort, { once: true });
    try {
        if (signal?.aborted) { abort(); return false; }
        let encryptedBody = bodyBytes || Buffer.alloc(0);
        if (encryptedBody.length > 0) encryptedBody = await cryptoWasm.encryptBuffer(encryptedBody);
        // Encoding can finish after timeout, disconnect, stop, or a new connection.
        if (signal?.aborted || generation !== connectionGeneration || socket !== ws || socket.readyState !== WebSocket.OPEN) {
            done(new Error(`请求已中断: ${methodName}`));
            return false;
        }
        // Assign the sequence and send without yielding: a ready empty request
        // must not put a higher sequence on the wire ahead of a slow encoder.
        const wireSeq = clientSeq++;
        if (callback) {
            pendingCallbacks.delete(seq);
            pendingCallbacks.set(wireSeq, done);
        }
        seq = wireSeq;
        const encoded = encodeMsg(serviceName, methodName, encryptedBody, wireSeq);
        diagnostic.encodeMs = Math.round(performance.now() - startedAt);
        diagnostic.phase = 'sending';
        socket.send(encoded, error => { if (error) done(error); });
        sentAt = performance.now();
        diagnostic.phase = 'awaiting_response';
    } catch (err) {
        done(err);
        return false;
    }
    return true;
}


/** Gateway 业务错误：带 code，供调用方精确处理（对齐参考仓库）。 */
class GatewayError extends Error {
  constructor(meta) {
    const code = toNum(meta && meta.error_code);
    super(`${meta && meta.service_name}.${meta && meta.method_name} 错误: code=${code} ${(meta && meta.error_message) || ''}`);
    this.name = 'GatewayError';
    this.code = code;
    this.meta = meta;
  }
}

/** Promise 版发送 */

// opts.priority === 'high' 的请求（心跳、ACE 反作弊）拥有保留通道：
// 即使普通请求把 pending 堆到上限也不会被拒绝，确保连接健康上报永不被 turbo 淹没。
function sendMsgAsync(serviceName, methodName, bodyBytes, timeout = 20000, opts = {}) {
    // 【2026-08-15】对齐参考仓库：第4参可直接传 opts 对象（{expectedErrorCodes, timeoutMs, priority}）
    if (timeout && typeof timeout === 'object') {
        opts = { ...timeout, ...opts };
        timeout = Number(opts.timeoutMs) || 20000;
    }
    const expectedErrorCodes = new Set(
        ((opts && opts.expectedErrorCodes) || []).map(Number).filter(Number.isFinite)
    );
    if (!isConnected()) return Promise.reject(new Error(`连接未打开: ${methodName}`));
    const mutatesLand = serviceName === 'gamepb.plantpb.PlantService' && methodName !== 'AllLands';
    return requestQueue.enqueue(signal => {
        if (mutatesLand) require('../services/level-forecast').invalidateLandForecast();
        return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            reject(new Error(`连接未打开: ${methodName}`));
            return;
        }

        const _cb = (err, body, meta) => {
            if (mutatesLand) require('../services/level-forecast').invalidateLandForecast();
            if (err) reject(err);
            else resolve({ body, meta });
        };
        _cb.expectedErrorCodes = expectedErrorCodes;
        sendMsg(serviceName, methodName, bodyBytes, _cb, signal)
            .then(sent => { if (!sent) reject(new Error(`发送失败: ${methodName}`)); }, reject);
        });
    }, { ...opts, signal: opts.signal || getAmbientRequestSignal(), timeoutMs: timeout, label: methodName });
}

function sendMsgNoReply(serviceName, methodName, bodyBytes, opts = {}) {
    if (!isConnected()) return Promise.reject(new Error(`连接未打开: ${methodName}`));
    return requestQueue.enqueue(async signal => {
        if (!await sendMsg(serviceName, methodName, bodyBytes, undefined, signal)) throw new Error(`发送失败: ${methodName}`);
    }, { ...opts, signal: opts.signal || getAmbientRequestSignal(), timeoutMs: opts.timeoutMs || 20000, label: methodName });
}

// ============ 消息处理 ============
function handleMessage(data) {
    try {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const msg = types.GateMessage.decode(buf);
        const meta = msg.meta;
        if (!meta) return;

        if (meta.server_seq) {
            const seq = toNum(meta.server_seq);
            if (seq > serverSeq) serverSeq = seq;
        }

        const msgType = meta.message_type;

        // Notify
        if (msgType === 3) {
            handleNotify(msg);
            return;
        }

        // Response
        if (msgType === 2) {
            const errorCode = toNum(meta.error_code);
            const clientSeqVal = toNum(meta.client_seq);

            const cb = pendingCallbacks.get(clientSeqVal);
            if (cb) {
                if (errorCode !== 0) {
                    // 预期错误码：正常返回 body（调用方自行判断），不抛异常（对齐参考仓库）
                    if (cb.expectedErrorCodes && cb.expectedErrorCodes.has(errorCode)) {
                        cb(null, msg.body, meta);
                    } else {
                        cb(new GatewayError(meta));
                    }
                } else {
                    cb(null, msg.body, meta);
                }
                return;
            }

            if (errorCode !== 0) {
                logWarn('错误', `${meta.service_name}.${meta.method_name} code=${errorCode} ${meta.error_message || ''}`);
            }
        }
    } catch (err) {
        logWarn('解码', err.message);
    }
}

function handleNotify(msg) {
    if (!msg.body || msg.body.length === 0) return;
    try {
        const event = types.EventMessage.decode(msg.body);
        const type = event.message_type || '';
        const eventBody = event.body;
        if (type.includes('WeatherChangeNotify') || type.includes('ActiviesChangeNotify')) {
            try {
                const modernTypes = require('../modern/utils/proto').types;
                if (type.includes('WeatherChangeNotify') && modernTypes.WeatherChangeNotify)
                    networkEvents.emit('weatherChanged', modernTypes.WeatherChangeNotify.decode(eventBody));
                if (type.includes('ActiviesChangeNotify') && modernTypes.ActiviesChangeNotify)
                    networkEvents.emit('activitiesChanged', modernTypes.ActiviesChangeNotify.decode(eventBody));
            } catch { /* A malformed push must not break the live connection. */ }
            return;
        }

        // 被踢下线
        if (type.includes('Kickout')) {
            log('推送', `被踢下线! ${type}`);
            try {
                const notify = types.KickoutNotify.decode(eventBody);
                log('推送', `原因: ${notify.reason_message || '未知'}`);
                networkEvents.emit('kickout', {
                    type,
                    reason: notify.reason_message || '未知',
                });
            } catch { }
            return;
        }

        // 土地状态变化 (被放虫/放草/偷菜等)
        if (type.includes('LandsNotify')) {
            try {
                const notify = types.LandsNotify.decode(eventBody);
                const hostGid = toNum(notify.host_gid);
                const lands = notify.lands || [];
                if (lands.length > 0) {
                    // 如果是自己的农场，触发事件
                    if (hostGid === userState.gid || hostGid === 0) {
                        require('../services/level-forecast').invalidateLandForecast();
                        networkEvents.emit('landsChanged', lands);
                    }
                }
            } catch { }
            return;
        }

        // 物品变化通知 (经验/金币等)
        if (type.includes('ItemNotify')) {
            try {
                const notify = types.ItemNotify.decode(eventBody);
                const items = notify.items || [];
                for (const itemChg of items) {
                    const item = itemChg.item;
                    if (!item) continue;
                    const id = toNum(item.id);
                    const count = toNum(item.count);
                    const delta = toNum(itemChg.delta);

                    // 仅使用 ID=1101 作为经验值标准
                    if (id === 1101) {
                        // 优先使用总量；若仅有 delta 也可累加
                        if (count > 0) userState.exp = count;
                        else if (delta !== 0) userState.exp = Math.max(0, Number(userState.exp || 0) + delta);
                        // 这里调用 updateStatusLevel 会触发 status.js -> worker.js -> stats.js 的更新流程
                        updateStatusLevel(userState.level, userState.exp);
                    } else if (id === 1 || id === 1001) {
                        // 显式零余额也是总量；只有未携带 count 时才应用 delta。
                        if (hasOwn(item, 'count') && Number.isFinite(count) && count >= 0) {
                            userState.gold = count;
                        } else if (!hasOwn(item, 'count') && Number.isFinite(delta) && delta !== 0) {
                            userState.gold = Math.max(0, Number(userState.gold || 0) + delta);
                        }
                        updateStatusGold(userState.gold);
                    } else if (id === 1002) {
                        // 点券
                        if (count > 0) {
                            userState.coupon = count;
                        } else if (delta !== 0) {
                            userState.coupon = Math.max(0, Number(userState.coupon || 0) + delta);
                        }
                    } else if (id === 1005) {
                        // 金豆豆
                        if (count > 0) {
                            userState.goldBean = count;
                        } else if (delta !== 0) {
                            userState.goldBean = Math.max(0, Number(userState.goldBean || 0) + delta);
                        }
                    } else if (id === 101351) {
                        // 同气连枝礼包 - 帮忙好友时有概率获得
                        if (delta > 0 || count > 0) {
                            const giftDelta = delta > 0 ? delta : (count > 0 ? 1 : 0);
                            recordTongQiGift(giftDelta);
                            const currentCount = getTongQiGiftCount();
                            log('好友', `获得同气连枝礼包 +${giftDelta} (今日: ${currentCount})`, {
                                module: 'friend',
                                event: '同气连枝礼包',
                                result: 'ok',
                                count: giftDelta,
                                dailyTotal: currentCount,
                            });
                        }
                    }
                }
            } catch { }
            return;
        }

        // 基本信息变化 (升级等)
        if (type.includes('BasicNotify')) {
            try {
                const notify = types.BasicNotify.decode(eventBody);
                if (notify.basic) {
                    const oldLevel = userState.level;
                    if (hasOwn(notify.basic, 'level')) {
                        const nextLevel = toNum(notify.basic.level);
                        if (Number.isFinite(nextLevel) && nextLevel > 0) userState.level = nextLevel;
                    }
                    let shouldUpdateGoldView = false;
                    if (hasOwn(notify.basic, 'gold')) {
                        const nextGold = toNum(notify.basic.gold);
                        if (Number.isFinite(nextGold) && nextGold >= 0) {
                            userState.gold = nextGold;
                            shouldUpdateGoldView = true;
                        }
                    }
                    if (hasOwn(notify.basic, 'exp')) {
                        const exp = toNum(notify.basic.exp);
                        if (Number.isFinite(exp) && exp >= 0) {
                            userState.exp = exp;
                            updateStatusLevel(userState.level, exp);
                        }
                    }
                    if (shouldUpdateGoldView) {
                        updateStatusGold(userState.gold);
                    }
                    if (userState.level !== oldLevel) {
                        recordOperation('levelUp', 1);
                    }
                }
            } catch { }
            return;
        }

        // 好友申请通知 (微信同玩)
        if (type.includes('FriendApplicationReceivedNotify')) {
            try {
                const notify = types.FriendApplicationReceivedNotify.decode(eventBody);
                const applications = notify.applications || [];
                if (applications.length > 0) {
                    networkEvents.emit('friendApplicationReceived', applications);
                }
            } catch { }
            return;
        }

        // 好友添加成功通知
        if (type.includes('FriendAddedNotify')) {
            try {
                const notify = types.FriendAddedNotify.decode(eventBody);
                const friends = notify.friends || [];
                if (friends.length > 0) {
                    const names = friends.map(f => f.name || f.remark || `GID:${toNum(f.gid)}`).join(', ');
                    log('好友', `新好友: ${names}`);
                }
            } catch { }
            return;
        }

        // 商品解锁通知 (升级后解锁新种子等)
        if (type.includes('GoodsUnlockNotify')) {
            try {
                const notify = types.GoodsUnlockNotify.decode(eventBody);
                const goods = notify.goods_list || [];
                if (goods.length > 0) {
                    networkEvents.emit('goodsUnlockNotify', goods);
                }
            } catch { }
            return;
        }

        // 任务状态变化通知
        if (type.includes('TaskInfoNotify')) {
            try {
                const notify = types.TaskInfoNotify.decode(eventBody);
                if (notify.task_info) {
                    networkEvents.emit('taskInfoNotify', notify.task_info);
                }
            } catch { }

        }

        // 其他未处理的推送类型 (调试用)
        // log('推送', `未处理类型: ${type}`);
    } catch (e) {
        logWarn('推送', `解码失败: ${e.message}`);
    }
}

// ============ 登录 ============
function isCurrentSession(session) {
    return !!session && session === currentSession && session.socket === ws && !session.finalized && !networkStopped;
}

async function sendLogin(session, onLoginSuccess) {
    const { profile } = session;
    const modern = usesPlayerSceneLogin(profile.clientVersion);
    const requestType = modern ? types.PlayerLoginRequest : types.LoginRequest;
    const request = {
        sharer_id: toLong(0), sharer_open_id: '', device_info: profile.deviceInfo, share_cfg_id: toLong(0),
        ...(profile.platform === 'qq' ? { scene_id: '1234567' } : {}),
        report_data: {
            minigame_channel: profile.platform === 'wx' ? 'other' : 'other-qq', minigame_platid: 2,
            ...(!modern ? { callback: '', cd_extend_info: '', click_id: '', clue_token: '', req_id: '', trackid: '' } : {}),
        },
        ...(modern ? { share_key: '', game_scene_id: 1 } : { extra: Buffer.alloc(0) }),
    };
    session.phase = 'player_login';
    const { body } = await sendMsgAsync('gamepb.userpb.UserService', modern ? 'PlayerLogin' : 'Login',
        requestType.encode(requestType.create(request)).finish(), 20000, { requestClass: 'critical' });
    if (!isCurrentSession(session)) return;
    const reply = (modern ? types.PlayerLoginReply : types.LoginReply).decode(body);
    if (!reply.basic || toNum(reply.basic.gid) <= 0) throw new Error('登录回包缺少有效玩家信息');
    const openId = String(reply.basic.open_id || '').trim();
    if (session.identityOnly) {
        const identity = { gid: String(reply.basic.gid), openId };
        stopNetwork('身份核验完成');
        onLoginSuccess?.(identity);
        return;
    }
    if (tsdkRuntime && openId) {
        tsdkRuntime.bindUser(openId);
        initialGamePackInfo = tsdkRuntime.getEncryptedInitInfo();
        logAce('info', `ACE 用户身份已绑定：初始化凭据长度 ${initialGamePackInfo.length}`);
    }
    if (modern) {
        session.phase = 'scene_login';
        const sceneResponse = await sendMsgAsync('gamepb.globalscenepb.GlobalSceneService', 'PlayerSceneLogin',
            types.PlayerSceneLoginRequest.encode({ global_scene_id: 1 }).finish(), 20000, { requestClass: 'critical' });
        if (!isCurrentSession(session)) return;
        const scene = types.PlayerSceneLoginReply.decode(sceneResponse.body);
        if (scene.global_scene_id !== 1 || !scene.farm_scene_ext_data?.length) {
            throw new Error('农场场景登录失败：缺少有效场景数据');
        }
        log('登录', '农场场景登录成功 (global_scene_id=1)');
    }
    if (!isCurrentSession(session)) return;
    clearWsErrorState();
    Object.assign(userState, {
        gid: toNum(reply.basic.gid), name: reply.basic.name || '未知',
        level: toNum(reply.basic.level), gold: toNum(reply.basic.gold), exp: toNum(reply.basic.exp),
        openId, avatar: String(reply.basic.avatar_url || '').trim(),
    });
    updateStatusFromLogin({ ...userState });
    let loginTimeMs = 0;
    if (reply.time_now_millis) {
        const time = toNum(reply.time_now_millis);
        loginTimeMs = time > 1e12 ? time : time * 1000;
        syncServerTime(loginTimeMs);
    }
    session.phase = 'ready';
    session.readyAt = performance.now();
    networkScheduler.clear('connection_login_timeout');
    log('系统', `登录成功: ${userState.name} (Lv${userState.level})`);
    logLoginSummary(loginTimeMs);
    startHeartbeat(session);
    startAceService();
    fetchGoldBeanFromBag(session);
    if (onLoginSuccess) onLoginSuccess();
}

// ============ 心跳 ============
let lastHeartbeatResponse = performance.now();
let heartbeatMissCount = 0;
const HEARTBEAT_TIMEOUT = 30000;
// Preserve the existing tolerance for short network stalls (up to five misses).
const MAX_HEARTBEAT_MISS = 5;

function startHeartbeat(session) {
    networkScheduler.clear('heartbeat_interval');
    lastHeartbeatResponse = performance.now();
    heartbeatMissCount = 0;
    networkScheduler.setIntervalTask('heartbeat_interval', CONFIG.heartbeatInterval, () => {
        if (!isCurrentSession(session) || !userState.gid) return;
        const silence = performance.now() - lastHeartbeatResponse;
        if (silence > HEARTBEAT_TIMEOUT) {
            heartbeatMissCount++;
            logWarn('心跳', `连接可能已断开 (${Math.round(silence / 1000)}s 无响应, miss=${heartbeatMissCount}/${MAX_HEARTBEAT_MISS}, pending=${pendingCallbacks.size})`);
            if (heartbeatMissCount >= MAX_HEARTBEAT_MISS) {
                finishSession(session, 'heartbeat_timeout');
                return;
            }
        }
        const body = types.HeartbeatRequest.encode(types.HeartbeatRequest.create({
            gid: toLong(userState.gid), client_version: session.profile.clientVersion, field_3: toLong(0),
        })).finish();
        return sendMsgAsync('gamepb.userpb.UserService', 'Heartbeat', body, 20000, { criticalLane: 'heartbeat' }).then(({ body: replyBody }) => {
            if (!isCurrentSession(session)) return;
            lastHeartbeatResponse = performance.now();
            heartbeatMissCount = 0;
            try {
                const reply = types.HeartbeatReply.decode(replyBody);
                if (reply.server_time) {
                    const time = toNum(reply.server_time);
                    syncServerTime(time > 1e12 ? time : time * 1000);
                }
            } catch { }
        }).catch(() => {});
    });
}

// ============ WebSocket 连接 ============
let savedLoginCallback = null;
let savedCode = null;
let savedConnectionOptions = {};
let reconnectAttempts = 0;
let networkStopped = false;
let reconnectFailedReported = false;

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13)';

// 注：Worker 内不再做自动重连（旧的指数退避重试是 bug 来源）。
// 断线统一上报 reconnect_failed，由主进程的"应用宝离线重连"负责重启 Worker。

function closeCurrentWs({ terminate = false } = {}) {
    const current = ws;
    if (!current) return;
    ws = null;
    current.removeAllListeners();
    // ws can emit an asynchronous error when terminating an unfinished handshake.
    current.on?.('error', () => {});
    try {
        if (terminate && typeof current.terminate === 'function') current.terminate();
        else current.close();
    } catch { }
}

/**
 * 断线后不再在 Worker 内进行自动重连（旧逻辑的指数退避重试是"自动重连 bug"的来源）。
 * 改为直接上报 reconnect_failed，交还给主进程的"应用宝离线重连"统一处理：
 * 由主进程按全局配置（延迟 N 分钟、重新获取 code）重启 Worker。
 * Worker 重启后走 connect() 建立全新连接，无需自身重试。
 */
function reportReconnectFailed(reason) {
    if (networkStopped || !savedLoginCallback) return;
    // 防止 close 与 heartbeat_timeout 同周期重复上报，导致主进程重复排重连
    if (reconnectFailedReported) return;
    reconnectFailedReported = true;
    const message = `连接已断开，交由应用宝离线重连处理${reason ? ` (${reason})` : ''}`;
    logWarn('系统', `[WS] ${message}`);
    networkEvents.emit('reconnect_failed', {
        attempts: reconnectAttempts,
        reason: reason || '',
    });
}

// Only the current socket may tear down the account or complete its login.
function finishSession(session, reason, code = reason) {
    if (!isCurrentSession(session)) return;
    session.finalized = true;
    session.phase = 'closed';
    session.closedAt = performance.now();
    cleanup(reason);
    closeCurrentWs({ terminate: true });
    userState.gid = 0;
    networkEvents.emit('disconnect', { code });
    reportReconnectFailed(reason);
}

function connect(code, onLoginSuccess, options = {}) {
    if (!String(code || '').trim()) throw new Error('登录需要新的 Code');
    if (currentSession) currentSession.finalized = true;
    cleanup('建立新连接');
    closeCurrentWs({ terminate: true });
    networkStopped = false;
    reconnectFailedReported = false;
    savedLoginCallback = onLoginSuccess;
    savedCode = String(code).trim();
    savedConnectionOptions = { ...options };
    userState.gid = 0;
    heartbeatMissCount = 0;
    clientSeq = 1;
    serverSeq = 0;
    let userAgent = DEFAULT_USER_AGENT;
    const deviceProtocol = options.deviceProtocol?.enabled ? { ...options.deviceProtocol } : null;
    if (deviceProtocol?.userAgent) userAgent = deviceProtocol.userAgent;
    const profile = createClientProfile(deviceProtocol);
    const url = new URL(profile.serverUrl);
    for (const [key, value] of Object.entries({ platform: profile.platform, os: profile.os,
        ver: profile.clientVersion, code: savedCode, openID: '' })) url.searchParams.set(key, value);
    const socket = new WebSocket(url.toString(), {
        ...(options.proxyURL ? { agent: createProxyAgent(options.proxyURL) } : {}),
        handshakeTimeout: 20000,
        headers: { 'User-Agent': userAgent, 'Origin': 'https://gate-obt.nqf.qq.com' },
    });
    ws = socket;
    const session = { socket, profile, phase: 'handshake', finalized: false, startedAt: performance.now(), identityOnly: options.identityOnly === true };
    currentSession = session;
    socket.binaryType = 'arraybuffer';
    networkScheduler.setTimeoutTask('connection_login_timeout', 60000, () => finishSession(session, 'login_timeout'));
    socket.on('open', async () => {
        if (!isCurrentSession(session)) return;
        reconnectAttempts = 0;
        session.phase = 'security_init';
        try {
            await startSecurityRuntime(deviceProtocol, session);
            if (!isCurrentSession(session)) return;
            await sendLogin(session, onLoginSuccess);
        } catch (error) {
            if (!isCurrentSession(session)) return;
            logWarn('登录', `登录中止 (${session.phase}): ${error.message}`);
            if (session.phase === 'security_init') networkEvents.emit('security_error', { message: error.message });
            finishSession(session, `login_failed:${session.phase}`);
        }
    });
    socket.on('message', data => {
        if (isCurrentSession(session)) handleMessage(Buffer.isBuffer(data) ? data : Buffer.from(data));
    });
    socket.on('close', code => {
        if (!isCurrentSession(session)) return;
        logWarn('系统', `[WS] 连接关闭 (code=${code})`);
        finishSession(session, `close:${code}`, code);
    });
    socket.on('error', error => {
        if (!isCurrentSession(session)) return;
        // Do not include the URL/one-time Code in diagnostics.
        const match = String(error?.message || '').match(/Unexpected server response:\s*(\d+)/i);
        if (match) {
            const code = Number(match[1]);
            const message = `WebSocket 握手被拒绝 (HTTP ${code})`;
            setWsErrorState(code, message);
            networkEvents.emit('ws_error', { code, message });
        }
        logWarn('系统', '[WS] 连接或握手失败');
        finishSession(session, 'socket_error');
    });
}

function cleanup(reason = '网络清理') {
    stopSecurityRuntime(reason);
    rejectAllPendingRequests(`请求已中断: ${reason}`);
    networkScheduler.clearAll();
    // pendingCallbacks.clear();
}

function reconnect(newCode) {
    if (networkStopped || !savedLoginCallback) return false;
    if (!String(newCode || '').trim() || String(newCode).trim() === savedCode) return false;
    connect(newCode, savedLoginCallback, savedConnectionOptions);
    return true;
}

function stopNetwork(reason = '停止网络') {
    networkStopped = true;
    if (currentSession) {
        currentSession.finalized = true;
        currentSession.phase = 'stopped';
        currentSession.closedAt = performance.now();
    }
    savedCode = null;
    savedConnectionOptions = {};
    savedLoginCallback = null;
    reconnectAttempts = 0;
    stopSecurityRuntime(reason);
    rejectAllPendingRequests(`请求已中断: ${reason}`);
    networkScheduler.clearAll();
    closeCurrentWs({ terminate: true });
    userState.gid = 0;
}

function getWs() { return ws; }
function isConnected() { return !!(ws && ws.readyState === WebSocket.OPEN); }
function getGatewayLoad() { return requestQueue.getLoad(heartbeatMissCount); }

function getRequestDiagnostics() {
    return { recent: recentRequestDiagnostics.map(record => ({ ...record })),
        pending: [...pendingCallbacks.values()].slice(0, 20).map(callback => ({ ...callback.diagnostic, ageMs: Math.round(performance.now() - callback.startedAt) })) };
}
async function waitForGatewayIdle(maxWaitMs = 8000, signal) {
    const deadline = performance.now() + Math.min(8000, Math.max(0, maxWaitMs));
    do {
        if (signal?.aborted || !isConnected()) return false;
        if (isGatewayIdleForBackground(getGatewayLoad())) return true;
        if (performance.now() >= deadline) return false;
        await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - performance.now())));
    } while (true);
}
function getConnectionDiagnostics() {
    if (!currentSession) return null;
    const session = currentSession;
    return { platform: session.profile.platform, clientVersion: session.profile.clientVersion,
        phase: session.phase, elapsedMs: Math.max(0, (session.closedAt ?? performance.now()) - session.startedAt) };
}
function getAceStatus() {
    if (aceService) return aceService.getStatus();
    return tsdkRuntime ? { running: false, runtime: tsdkRuntime.getStatus() } : null;
}

module.exports = {
    connect, reconnect, cleanup, stopNetwork, getWs, isConnected,
    sendMsg, sendMsgAsync, sendMsgNoReply, GatewayError,
    getGatewayLoad, waitForGatewayIdle, getRequestDiagnostics,
    getUserState,
    getWsErrorState,
    getAceStatus, getConnectionDiagnostics,
    networkEvents,
};
