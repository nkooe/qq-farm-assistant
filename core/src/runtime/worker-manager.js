const path = require('node:path');
const { createScheduler } = require('../services/scheduler');
const { createLoginRecovery, LoginRecoveryError, classifyLoginError, loginIdentity, requestDeadline } = require('../services/login-recovery');

function safeRuntimeError(message) {
    return String(message || '')
        .replace(/\b(?:https?|socks5h?):\/\/[^\s<>"']+/gi, '[连接地址已隐藏]')
        .replace(/\bBearer\s+[^\s<>"']+/gi, 'Bearer [已隐藏]')
        .replace(/\b(access[_-]?token|refresh[_-]?token|api[_-]?key|token|password|passwd|login_buffer)["']?\s*[:=]\s*["']?[^,\s"'<>}&]+/gi, '$1=[已隐藏]');
}

/**
 * 创建 Worker 管理器
 * 负责账号 Worker 进程/线程的启动、停止、重启、消息处理和 RPC 调用
 */
function createWorkerManager(deps) {
    const {
        fork,
        WorkerThread,
        runtimeMode = 'thread',
        processRef,
        mainEntryPath,
        workerScriptPath,
        workers,
        globalLogs,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildConfigSnapshotForAccount,
        resolveAccountProxy = account => require('../services/account-proxy').resolveProxyURL(account),
        refreshQqCode,
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        addOrUpdateAccount,
        deleteAccount,
        onStatusSync,
        onWorkerLog
    } = deps;

    const scheduler = createScheduler('worker_manager');
    const startingWorkers = new Map();
    const restartingWorkers = new Map();
    const startupResults = new Map();
    const reconnectPlans = new Map();
    const loginRecovery = deps.loginRecovery || createLoginRecovery();

    function getWorkerRuntime(accountId) {
        const worker = workers[accountId];
        const connected = !!worker?.status?.connection?.connected;
        const pending = startingWorkers.get(accountId);
        const last = startupResults.get(accountId);
        const reconnect = reconnectPlans.get(accountId);
        let state = 'stopped';
        let error = last?.error || worker?.wsError?.message || '';
        if (connected) { state = 'online'; error = ''; }
        else if (reconnect?.state === 'scheduled') state = 'reconnecting';
        else if (worker?.stopping) state = 'stopping';
        else if (pending && !pending.cancelled) state = 'starting';
        else if (worker) {
            state = error || (last?.updatedAt && Date.now() - last.updatedAt > 90000) ? 'failed' : 'starting';
            if (state === 'failed' && !error) error = '连接游戏超时，请检查网络后重试启动';
        } else if (error) state = 'failed';
        return { state, connected, running: !!worker, error: safeRuntimeError(error), updatedAt: last?.updatedAt || null, login: loginRecovery.getState(accountId),
            reconnect: reconnect ? { ...reconnect, reason: safeRuntimeError(reconnect.reason) } : null };
    }

    // 应用宝离线重连的独立计数（不受 startWorker 成功清零影响，否则 maxAttempts 会失效导致无限重连）
    const reconnectAttemptsMap = new Map();
    // 【2026-08-12 修复】重连成功后"稳定在线时长"：账号在线超过该时长未再断线，则清零重连计数。
    // 原逻辑计数永不清零 → 断线 3 次（无论重连是否成功）后 currentAttempt>=maxAttempts → 永久放弃重连，
    // 频繁被踢/网络不稳的账号表现为"老是没重连"。改为成功后稳定 10 分钟再清零：
    // 既保留"防止无限重连"（10 分钟内反复断线仍累积计数受 maxAttempts 约束），又不会 3 次就永久放弃。
    const RECONNECT_SUCCESS_STABLE_MS = 10 * 60 * 1000;

    function builtinYybApi() {
        const store = require('../models/store');
        const config = store.getGlobalWxConfig?.() || {};
        const base = String(process.env.YYB_API_URL || config.apiBase || '').trim().replace(/\/+$/, '')
            .replace(/\/wxapp\/getCode$/i, '').replace(/\/wxapp$/i, '').replace(/\/accounts$/i, '');
        return { base, key: String(process.env.YYB_API_KEY || config.apiKey || '').trim() };
    }

    function clearCredentialRecoveryIfIdle() {
        if (![...reconnectPlans.values()].some(plan => plan.state === 'waiting_credentials')) {
            scheduler.clear('credential_recovery');
        }
    }

    async function checkCredentialRecovery() {
        const store = require('../models/store');
        for (const [accountId, plan] of reconnectPlans) {
            if (plan.state !== 'waiting_credentials') continue;
            const eligible = () => {
                const account = store.getAccounts().accounts.find(item => item.id === accountId);
                return account && account.autoStart !== false && account.provider !== 'thirdparty'
                    && account.loginType === 'yyb' && account.yybOpenid
                    && resolveReconnectConfig(account).autoReconnect && resolveReconnectConfig(account).reconnectDelayMin > 0 ? account : null;
            };
            let account = eligible();
            if (!account) {
                plan.state = 'exhausted';
                continue;
            }
            const api = builtinYybApi();
            if (!api.base || !api.key) continue;
            try {
                const response = await fetch(`${api.base}/accounts/health?ref=${encodeURIComponent(account.yybOpenid)}`, {
                    headers: { Authorization: `Bearer ${api.key}` }, signal: AbortSignal.timeout(4000),
                });
                const result = await response.json();
                const health = result?.code === 0 && result.data && typeof result.data === 'object'
                    && !Array.isArray(result.data) ? result.data : null;
                // A late health response must never undo a stop, deletion or manual start.
                account = eligible();
                if (reconnectPlans.get(accountId) !== plan || !account) continue;
                if (!response.ok || !health || health.needs_rescan || health.refresh?.last_error
                    || !(health.refresh?.last_success_at > Math.floor(plan.waitingSince / 1000))
                    || !(health.expires_at > Date.now() / 1000)) continue;
                reconnectPlans.delete(accountId);
                reconnectAttemptsMap.delete(accountId);
                log('系统', `账号 ${account.name} 后台凭据已恢复，重新发起自动启动`, { accountId });
                await startWorker(account, { automatic: true });
            } catch {
                // Health reads do not refresh credentials or consume the game retry budget.
            }
        }
        clearCredentialRecoveryIfIdle();
    }

    /** 是否支持 Thread 模式（非 pkg 打包 + Worker 可用） */
    const threadMode = runtimeMode === 'thread' && !processRef.pkg && typeof WorkerThread === 'function';

    function cleanText(value) {
        return String(value || '').trim();
    }

    function buildQqAvatarUrl(qq) {
        const value = cleanText(qq);
        if (!/^\d+$/.test(value)) return '';
        return `https://q1.qlogo.cn/g?b=qq&nk=${  value  }&s=100`;
    }

    function resolveLoginProfile(status, worker) {
        const data = status && typeof status === 'object' ? status : {};
        const info = data.status && typeof data.status === 'object' ? data.status : {};
        const platform = cleanText(info.platform || data.platform || worker.platform || 'qq').toLowerCase();
        const gid = cleanText(info.gid || data.gid);
        const openId = cleanText(info.openId || info.open_id || data.openId || data.open_id);
        const avatar = cleanText(info.avatar || info.avatarUrl || info.avatar_url || data.avatar || data.avatarUrl || data.avatar_url);
        const qq = cleanText(info.qq || info.uin || data.qq || data.uin || worker.qq || worker.uin);
        const fallbackAvatar = platform === 'qq' ? buildQqAvatarUrl(qq) : '';

        return {
            platform,
            gid,
            openId,
            qq,
            avatar: avatar || fallbackAvatar
        };
    }

    function syncAccountProfile(accountId, msgData, worker) {
        const profile = resolveLoginProfile(msgData, worker);
        const update = { id: accountId };

        if (profile.openId && worker.openId !== profile.openId) {
            update.openId = profile.openId;
        }
        if (profile.gid && worker.gid !== profile.gid) {
            update.gid = profile.gid;
        }
        if (profile.qq && worker.qq !== profile.qq) {
            update.qq = profile.qq;
            update.uin = profile.qq;
        }
        if (profile.avatar && worker.avatar !== profile.avatar) {
            update.avatar = profile.avatar;
        }

        if (Object.keys(update).length <= 1) return;

        addOrUpdateAccount(update);
        if (update.openId) worker.openId = update.openId;
        if (update.gid) worker.gid = update.gid;
        if (update.qq) {
            worker.qq = update.qq;
            worker.uin = update.uin;
        }
        if (update.avatar) worker.avatar = update.avatar;
    }

    /**
     * 创建 Thread Worker
     */
    function createThreadWorker(account) {
        const worker = new WorkerThread(workerScriptPath, {
            workerData: {
                accountId: String(account.id || ''),
                channel: 'thread'
            }
        });
        // 统一 send/kill 接口
        worker.send = (msg) => worker.postMessage(msg);
        worker.kill = () => worker.terminate();
        return worker;
    }

    /**
     * 创建 Fork Worker
     */
    function createForkWorker(account) {
        // 显式指定 cwd：用 mainEntryPath 所在目录（core/）的绝对路径，
        // 避免父进程 cwd 失效（ENOENT: uv_cwd）导致子进程启动失败。
        const workerCwd = path.dirname(mainEntryPath);

        if (processRef.pkg) {
            // pkg 打包模式：fork 主入口而不是 worker 脚本
            return fork(mainEntryPath, [], {
                execPath: processRef.execPath,
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
                cwd: workerCwd,
                env: {
                    ...processRef.env,
                    FARM_WORKER: '1',
                    FARM_ACCOUNT_ID: String(account.id || '')
                }
            });
        }
        return fork(workerScriptPath, [], {
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            cwd: workerCwd,
            env: {
                ...processRef.env,
                FARM_ACCOUNT_ID: String(account.id || '')
            }
        });
    }

    /**
     * 根据运行模式创建 Worker
     */
    function createWorker(account) {
        if (threadMode) return createThreadWorker(account);
        return createForkWorker(account);
    }

    /**
     * 应用宝账号启动前自动刷新 code
     * 调应用宝接口用 openid 换新的 code，覆盖 account.code。
     * 失败时保留账号并返回诊断，由启动状态提示重试。
     */
    function refreshYybCodeIfNeeded(account, options = {}) {
        return loginRecovery.run(account, 'yyb', ({ signal }) => requestYybCode(account, signal), options);
    }

    async function requestYybCode(account, signal) {
        if (!account || account.loginType !== 'yyb' || !account.yybOpenid) {
            return { ok: false, error: '账号不是有效的应用宝账号' };
        }
        const request = requestDeadline(signal, 45000);
        try {
            if (request.signal.aborted) throw new LoginRecoveryError('取码已取消', 'cancelled', 410);
            // 第三方 YYB：直接调第三方接口换 code（与内置 yyb-go 同协议、可刷新）
            if (account.provider === 'thirdparty') {
                const { getThirdpartyYybCode } = require('../utils/thirdpartyYyb');
                const result = await getThirdpartyYybCode({
                    apiBase: account.thirdparty?.apiBase,
                    apiToken: account.thirdparty?.apiToken,
                    openid: account.thirdparty?.openid || account.yybOpenid,
                    forceRefresh: false,
                    signal: request.signal,
                });
                if (result.ok && result.code) {
                    if (signal?.aborted) throw new LoginRecoveryError('取码已取消', 'cancelled', 410);
                    log('系统', `账号 ${account.name} 第三方应用宝 code 已自动刷新`, {
                        accountId: String(account.id),
                    });
                    return { ok: true, code: result.code, source: 'yyb' };
                }
                const error = result.error || '第三方应用宝刷新失败';
                log('系统', `账号 ${account.name} 第三方应用宝 code 刷新失败: ${safeRuntimeError(error)}`, {
                        accountId: String(account.id),
                });
                return { ok: false, error: safeRuntimeError(error), source: 'yyb', kind: result.kind || (result.status === 401 || result.status === 403 ? 'configuration' : 'temporary') };
            }
            // 内置 YYB（走 yyb-go）
            const store = require('../models/store');
            const wxConfig = store.getGlobalWxConfig ? store.getGlobalWxConfig() : null;
            const yybApiBase = String(process.env.YYB_API_URL || (wxConfig && wxConfig.apiBase) || '').trim();
            const yybApiKey = String(process.env.YYB_API_KEY || (wxConfig && wxConfig.apiKey) || '').trim();
            if (!yybApiBase || !yybApiKey) {
                const error = '应用宝接口未配置';
                log('系统', `账号 ${account.name} 应用宝接口未配置，启动已暂停`, {
                    accountId: String(account.id),
                });
                return { ok: false, error, source: 'yyb', kind: 'configuration' };
            }
            // 规范化 apiBase：去掉尾部斜杠和可能误带的路径后缀
            const rawBase = yybApiBase.replace(/\/+$/, '');
            const base = rawBase.replace(/\/wxapp\/getCode$/i, '').replace(/\/wxapp$/i, '').replace(/\/accounts$/i, '');
            const appId = (wxConfig && wxConfig.appId) || 'wx5306c5978fdb76e4';
            const resp = await fetch(`${base}/wxapp/getCode`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${yybApiKey}`,
                },
                body: JSON.stringify({ ref: account.yybOpenid, app_id: appId }),
                signal: request.signal,
            });
            const data = await resp.json();
            if (signal?.aborted) throw new LoginRecoveryError('取码已取消', 'cancelled', 410);
            if (resp.ok !== false && data && data.code === 0 && typeof data.data?.result?.code === 'string' && data.data.result.code.trim()) {
                log('系统', `账号 ${account.name} 应用宝 code 已自动刷新`, {
                    accountId: String(account.id),
                });
                return { ok: true, code: String(data.data.result.code), source: 'yyb' };
            }
            const error = (data && data.msg) || '应用宝未返回 Code';
            log('系统', `账号 ${account.name} 应用宝 code 刷新失败: ${safeRuntimeError(error)}`, {
                accountId: String(account.id),
                yybCode: data && data.code,
            });
            const status = Number(resp.ok === false ? resp.status : data?.code);
            return { ok: false, error: safeRuntimeError(error), source: 'yyb',
                kind: status === 409 ? 'rescan' : status === 401 || status === 403 ? 'configuration' : status === 429 ? 'busy' : 'temporary' };
        } catch (e) {
            if (signal?.aborted) throw new LoginRecoveryError('取码已取消', 'cancelled', 410);
            log('系统', `账号 ${account.name} 应用宝 code 刷新异常: ${safeRuntimeError(e.message)}`, {
                accountId: String(account.id),
            });
            return { ok: false, error: safeRuntimeError(e.message || '应用宝 Code 刷新异常'), source: 'yyb', kind: request.signal.aborted ? 'timeout' : classifyLoginError(e) };
        } finally {
            request.close();
        }
    }

    /**
     * 启动账号 Worker
     */
    async function startWorker(account, options = {}) {
        if (!account || !account.id) return false;
        if (workers[account.id]) return false;

        const pending = startingWorkers.get(account.id);
        if (pending && !pending.cancelled) {
            if (pending.identity === loginIdentity(account)) return pending.promise;
            pending.cancelled = true;
            pending.controller.abort();
        }
        // 手动启动接管已有重试计划，避免刷新期间定时器再次消耗重连次数。
        scheduler.clear(`reconnect_attempt_${account.id}`);
        reconnectPlans.delete(account.id);
        clearCredentialRecoveryIfIdle();
        if (!options.automatic) reconnectAttemptsMap.delete(account.id);
        if (!options.automatic) loginRecovery.cancel(account.id);
        const start = { cancelled: false, promise: null, controller: new AbortController(), identity: loginIdentity(account) };
        startingWorkers.set(account.id, start);
        startupResults.set(account.id, { updatedAt: Date.now(), error: '' });
        // 所有并发调用共享完整启动结果（包括异常处理和重试调度）。
        start.promise = (async () => {
            let started = false;
            try {
                started = await performStartWorker(account, start, options);
                return started;
            } catch (error) {
                const current = require('../models/store').getAccounts().accounts.find(a => String(a.id) === String(account.id));
                if (current && loginIdentity(current) !== start.identity) start.cancelled = true;
                if (!start.cancelled) {
                    startupResults.set(account.id, { updatedAt: Date.now(), error: safeRuntimeError(error.message || '启动失败'), category: error.startupCategory || '', kind: classifyLoginError(error) });
                    log('错误', `账号 ${account.name} 启动失败: ${safeRuntimeError(error.message)}`, { accountId: String(account.id) });
                }
                return false;
            } finally {
                if (startingWorkers.get(account.id) === start) {
                    startingWorkers.delete(account.id);
                    // Code 刷新发生在 Worker 创建之前，失败时也必须进入有上限的重连流程。
                    // 保留失败诊断；不能调用 stopWorker，否则会把本次失败当作用户取消。
                    if (!started && !start.cancelled && !workers[account.id] && (account.loginType === 'yyb' || isNativeQq(account))) {
                        void scheduleReconnect(account.id, 'startup_failed', { stopCurrent: false });
                    }
                }
            }
        })();
        return start.promise;
    }

    async function performStartWorker(account, start, options) {
        const identity = loginIdentity(account);
        const storedAtStart = require('../models/store').getAccounts().accounts.some(a => String(a.id) === String(account.id));
        const isCurrent = () => {
            const current = require('../models/store').getAccounts().accounts.find(a => String(a.id) === String(account.id));
            const valid = !storedAtStart || (current && loginIdentity(current) === identity);
            if (!valid) start.cancelled = true;
            return valid;
        };
        let freshCode;

        log('系统', `正在启动账号: ${  account.name}`, {
            accountId: String(account.id),
            accountName: account.name
        });

        // 应用宝账号：启动前自动刷新 code
        if (!options.skipYybRefresh && account.loginType === 'yyb') {
            const refreshed = await refreshYybCodeIfNeeded(account, { signal: start.controller.signal });
            if (!refreshed.ok) throw Object.assign(new LoginRecoveryError(refreshed.error || '应用宝 Code 刷新失败，请重试启动', refreshed.kind), { startupCategory: 'credentials' });
            if (start.cancelled || !isCurrent()) return false;
            freshCode = refreshed.code;
        }
        if (isNativeQq(account) && account.qqLoginProfile && !options.skipQqRefresh) {
            if (typeof refreshQqCode !== 'function') throw Object.assign(new LoginRecoveryError('QQ 登录态服务不可用，请检查服务配置', 'configuration'), { startupCategory: 'credentials' });
            const code = await loginRecovery.run(account, 'qq', ({ signal, mark }) => refreshQqCode(account, { signal, mark }), { signal: start.controller.signal });
            if (start.cancelled || workers[account.id]) return false;
            if (!isCurrent()) return false;
            freshCode = code;
            log('系统', 'QQ 原生登录态已获取新 Code', { accountId: String(account.id) });
        }
        // Resolve before creating a worker; an unavailable selected proxy must
        // never turn a configured account into a direct connection.
        let proxyURL;
        try { proxyURL = account.proxyMode === 'static' ? await resolveAccountProxy(account) : ''; }
        catch { throw new LoginRecoveryError('账号代理不可用，请检查所选代理配置', 'proxy'); }
        if (start.cancelled || workers[account.id] || !isCurrent()) return false;
        if (freshCode !== undefined) {
            account = { ...account, code: freshCode };
            if (storedAtStart) addOrUpdateAccount({ id: account.id, code: freshCode });
        }

        let proc = null;
        try {
            proc = createWorker(account);
        } catch (err) {
            const errorMsg = err && err.message ? err.message : String(err || 'unknown error');
            log('错误', `账号 ${  account.name  } 启动失败: ${  errorMsg}`, {
                accountId: String(account.id),
                accountName: account.name
            });
            addAccountLog('start_failed', `账号 ${  account.name  } 启动失败`,
                account.id, account.name, { reason: errorMsg });
            startupResults.set(account.id, { updatedAt: Date.now(), error: errorMsg });
            return false;
        }

        // 注册 Worker 记录
        workers[account.id] = {
            process: proc,
            status: null,
            logs: [],
            requests: new Map(),
            reqId: 1,
            name: account.name,
            username: account.username || '',
            platform: account.platform || 'qq',
            gid: account.gid || '',
            openId: account.openId || account.open_id || '',
            qq: account.qq || account.uin || '',
            uin: account.uin || account.qq || '',
            avatar: account.avatar || account.avatarUrl || '',
            stopping: false,
            disconnectedSince: 0,
            offlineReminderTriggered: false,
            autoDeleteTriggered: false,
            wsError: null
        };

        // 注意：这里不再清理应用宝离线重连计数（reconnectAttemptsMap）。
        // 旧逻辑会在 startWorker 成功时清零，导致重连计数永远从 0 起算、
        // maxAttempts 失效、账号被无限重连。计数只在"达到上限 /
        // 账号被删 / 手动停止"时清零（见下方 ws_reconnect_failed 与 stopWorker）。

        // 发送启动配置
        proc.send({
            type: 'start',
            config: { ...buildConfigSnapshotForAccount(account.id), code: account.code, platform: account.platform, proxyURL }
        });

        // 发送配置快照
        proc.send({
            type: 'config_sync',
            config: buildConfigSnapshotForAccount(account.id)
        });

        // 监听 Worker 消息
        proc.on('message', (msg) => {
            try {
                handleWorkerMessage(account.id, msg);
            } catch (error) {
                if (!String(error?.code || '').startsWith('STORAGE_')) throw error;
                addAccountLog('config_save_failed', error.message, account.id, account.name, { code: error.code });
            }
        });

        // 监听 Worker 错误
        proc.on('error', (err) => {
            startupResults.set(account.id, { updatedAt: Date.now(), error: err.message || '子进程启动失败' });
            log('系统', `账号 ${  account.name  } 子进程启动失败: ${
                err && err.message ? err.message : err}`, {
                accountId: String(account.id),
                accountName: account.name
            });
        });

        // 监听 Worker 退出
        proc.on('exit', (code, signal) => {
            const wrk = workers[account.id];
            const displayName = wrk && wrk.name ? wrk.name : account.name;

            log('系统', `账号 ${  displayName  } 进程退出 (code=${  code
                }, signal=${  signal || 'none'  })`, {
                accountId: String(account.id),
                accountName: displayName,
                runtimeMode: threadMode ? 'thread' : 'fork'
            });

            scheduler.clear(`force_kill_${  account.id}`);
            scheduler.clear(`restart_fallback_${  account.id}`);

            // 清理所有未完成的 API 请求
            if (wrk && wrk.requests && wrk.requests.size > 0) {
                for (const [reqId, pending] of wrk.requests.entries()) {
                    scheduler.clear(`api_timeout_${  account.id  }_${  reqId}`);
                    try { pending.reject(new Error('Worker exited')); } catch { }
                }
                wrk.requests.clear();
            }

            if (wrk && wrk.process === proc) {
                if (!wrk.stopping) startupResults.set(account.id, { updatedAt: Date.now(), error: `账号进程退出（${code ?? signal ?? '未知原因'}），可重试启动` });
                delete workers[account.id];
            }
        });

        return true;
    }

    /**
     * 停止账号 Worker
     * @param {string} accountId 账号 ID
     * @param {object} [opts]
     * @param {boolean} [opts.resetReconnect] 是否同时清零「应用宝离线重连」计数，默认 true。
     *   手动停止 / 踢下线 / 删除账号时应清零；唯独自动重连流程(ws_reconnect_failed)必须传 false，
     *   否则每次断线都会被清零，导致 maxAttempts 永远不触发、无限重连。
     */
    function stopWorker(accountId, opts = {}) {
        const { resetReconnect = true, preserveRestart = false } = opts;
        if (!preserveRestart) {
            restartingWorkers.delete(accountId);
            scheduler.clear(`restart_fallback_${accountId}`);
        }
        if (resetReconnect) {
            startupResults.delete(accountId);
            reconnectPlans.delete(accountId);
            clearCredentialRecoveryIfIdle();
        }
        const pending = startingWorkers.get(accountId);
        if (pending) { pending.cancelled = true; pending.controller?.abort(); }
        loginRecovery.cancel(accountId);

        // 取消尚未触发的离线重连计划
        scheduler.clear(`reconnect_attempt_${accountId}`);
        // 【2026-08-12】同步清理"重连成功稳定期清零"定时器，避免账号停止后残留定时器意外清零计数
        scheduler.clear(`reconnect_reset_${accountId}`);
        if (resetReconnect) {
            // 仅「账号退役 / 用户主动停止」场景清零计数；自动重连循环内不在此清零
            reconnectAttemptsMap.delete(accountId);
        }

        // 即使尚未创建 Worker，也要取消启动失败留下的重试计划。
        const wrk = workers[accountId];
        if (!wrk) return;

        const targetProc = wrk.process;
        wrk.stopping = true;

        // 发送停止指令
        wrk.process.send({ type: 'stop' });

        // 1 秒后强制杀死
        scheduler.setTimeoutTask(`force_kill_${  accountId}`, 1000, () => {
            const current = workers[accountId];
            if (current && current.process === targetProc) {
                delete workers[accountId];
                current.process.kill();
            }
        });
    }

    /**
     * 重启账号 Worker
     */
    async function restartWorker(account, options = {}) {
        if (!account) return;
        const accountId = account.id;
        const wrk = workers[accountId];

        // 如果未运行，直接启动
        if (!wrk) return startWorker(account, options);

        const targetProc = wrk.process;
        let restarted = false;
        const restart = { identity: loginIdentity(account) };
        const storedAtStart = require('../models/store').getAccounts().accounts.some(a => String(a.id) === String(accountId));
        restartingWorkers.set(accountId, restart);

        const doRestart = async () => {
            if (restarted || restartingWorkers.get(accountId) !== restart) return;
            restarted = true;
            restartingWorkers.delete(accountId);
            scheduler.clear(`restart_fallback_${  accountId}`);
            const stored = require('../models/store').getAccounts().accounts.find(a => String(a.id) === String(accountId));
            if (storedAtStart && (!stored || loginIdentity(stored) !== restart.identity)) return;

            const current = workers[accountId];
            if (!current) return startWorker(account, options);
            if (current.process !== targetProc) return;

            delete workers[accountId];
            await startWorker(account, options);
        };

        const forceKill = () => {
            const current = workers[accountId];
            if (!current || current.process !== targetProc) return false;
            delete workers[accountId];
            try { current.process.kill(); } catch { }
            return true;
        };

        // 如果进程已退出，直接重启
        if (typeof targetProc.exitCode === 'number' || targetProc.signalCode) {
            return doRestart();
        }

        // 先尝试正常停止，再等待退出事件
        targetProc.once('exit', doRestart);
        stopWorker(accountId, { preserveRestart: true });

        // 1500ms 超时回退
        scheduler.setTimeoutTask(`restart_fallback_${  accountId}`, 1500, () => {
            if (restarted || restartingWorkers.get(accountId) !== restart) return;
            forceKill();
            doRestart();
        });
    }

    /**
     * 统一的应用宝离线重连调度
     * 由 ws_reconnect_failed（连接中断）/ account_kicked（被踢下线）/ ws_error 400（登录失效/异地登录）
     * 三种场景共用，避免某些场景“永不重连”。
     * 受（账号级优先、全局兜底）autoReconnect + reconnectDelayMin + maxAttempts 控制；重连前由 startWorker →
     * refreshYybCodeIfNeeded 自动刷新 code（内置 YYB 走 yyb-go；第三方 tab 接入时按 provider 分流）。
     */

    /**
     * 解析某账号的离线重连配置。
     * 第三方账号（provider==='thirdparty'）优先使用账号级独立配置（thirdparty.*），
     * 未设置账号级配置时回退到全局 wxConfig（与内置 YYB 一致）。
     */
    function isNativeQq(account) {
        return account?.platform === 'qq' && account.loginType !== 'yyb' && !account.yybOpenid;
    }

    function reconnectLabel(account) {
        return isNativeQq(account) ? 'QQ 原生登录态重连' : account?.loginType === 'yyb' ? '应用宝离线重连' : '账号重连';
    }

    function resolveReconnectConfig(account) {
        if (isNativeQq(account)) {
            return { autoReconnect: !!account.qqLoginProfile && account.qqAutoReconnect !== false,
                reconnectDelayMin: 0.5, reconnectMaxAttempts: 3, source: 'qq' };
        }
        const store = require('../models/store');
        const wxConfig = store.getGlobalWxConfig ? store.getGlobalWxConfig() : null;
        const globalCfg = {
            autoReconnect: !!(wxConfig && wxConfig.autoReconnect),
            reconnectDelayMin: wxConfig ? wxConfig.reconnectDelayMin : 5,
            reconnectMaxAttempts: wxConfig ? wxConfig.reconnectMaxAttempts : 3,
        };

        if (account && account.provider === 'thirdparty' && account.thirdparty) {
            const tp = account.thirdparty;
            const hasAccountLevel =
                tp.autoReconnect !== undefined ||
                tp.reconnectDelayMin !== undefined ||
                tp.reconnectMaxAttempts !== undefined;
            if (hasAccountLevel) {
                return {
                    autoReconnect: tp.autoReconnect === undefined
                        ? globalCfg.autoReconnect
                        : tp.autoReconnect === true,
                    reconnectDelayMin: (tp.reconnectDelayMin === undefined || tp.reconnectDelayMin === null || tp.reconnectDelayMin === '')
                        ? globalCfg.reconnectDelayMin
                        : Math.max(1, Number(tp.reconnectDelayMin) || globalCfg.reconnectDelayMin),
                    reconnectMaxAttempts: (tp.reconnectMaxAttempts === undefined || tp.reconnectMaxAttempts === null || tp.reconnectMaxAttempts === '')
                        ? globalCfg.reconnectMaxAttempts
                        : Math.max(1, Number(tp.reconnectMaxAttempts) || globalCfg.reconnectMaxAttempts),
                    source: 'account',
                };
            }
        }
        return { ...globalCfg, source: 'global' };
    }

    async function scheduleReconnect(accountId, reason, { stopCurrent = true } = {}) {
        const wrk = workers[accountId];
        const name = wrk ? wrk.name : accountId;

        log('系统', `账号 ${name} 触发离线重连调度 (${reason})`, {
            accountId: String(accountId),
            accountName: name,
            reason,
        });

        // 先停止当前 worker（清理进程）；自动重连流程内【不】清零计数，
        // 否则每次断线都被清零，maxAttempts 永不触发、无限重连。
        if (stopCurrent) {
            const error = wrk?.wsError?.message || reason;
            stopWorker(accountId, { resetReconnect: false });
            startupResults.set(accountId, { updatedAt: Date.now(), error });
        }

        try {
            const store = require('../models/store');
            // 取完整账号（含第三方真实 token 与账号级离线重连配置）
            const accountsData = store.getAccounts();
            const account = (accountsData.accounts || []).find(a => a.id === accountId);
            if (!account) {
                reconnectAttemptsMap.delete(accountId);
                reconnectPlans.delete(accountId);
                return;
            }
            const cfg = resolveReconnectConfig(account);
            const kind = startupResults.get(accountId)?.kind || 'temporary';
            if (['rescan', 'configuration', 'cancelled'].includes(kind)) {
                scheduler.clear(`reconnect_attempt_${accountId}`);
                reconnectPlans.set(accountId, { state: kind === 'rescan' ? 'needs_rescan' : 'blocked',
                    attempt: reconnectAttemptsMap.get(accountId) || 0, maxAttempts: cfg.reconnectMaxAttempts, nextRetryAt: null, reason, kind });
                log('系统', `账号 ${name} ${kind === 'rescan' ? '需要扫码更新，已暂停自动重试' : '需要检查登录配置，已暂停自动重试'}`, { accountId: String(accountId) });
                return;
            }

            if (!cfg.autoReconnect || !(cfg.reconnectDelayMin > 0)) {
                reconnectPlans.delete(accountId);
                if (isNativeQq(account) && !account.qqLoginProfile) reconnectPlans.set(accountId, { state: 'needs_rescan', attempt: 0, maxAttempts: cfg.reconnectMaxAttempts, nextRetryAt: null, reason, kind: 'rescan' });
                const hint = isNativeQq(account) && !account.qqLoginProfile ? '缺少可恢复的 QQ 登录态，请使用 QQ 扫码更新一次' : `未启用${  reconnectLabel(account)}`;
                log('系统', `账号 ${name} ${hint}，已停止`, { accountId: String(accountId) });
                return;
            }

            const attemptKey = `reconnect_attempt_${accountId}`;
            // 从独立计数 Map 读取（不受 startWorker 清零影响，保证 maxAttempts 生效）
            const currentAttempt = reconnectAttemptsMap.get(accountId) || 0;
            const maxAttempts = cfg.reconnectMaxAttempts;

            if (currentAttempt >= maxAttempts) {
                const awaitCredentials = account.autoStart !== false && account.provider !== 'thirdparty'
                    && account.loginType === 'yyb' && !!account.yybOpenid
                    && startupResults.get(accountId)?.category === 'credentials';
                reconnectPlans.set(accountId, { state: awaitCredentials ? 'waiting_credentials' : 'exhausted',
                    attempt: currentAttempt, maxAttempts, nextRetryAt: null, reason, waitingSince: Date.now() });
                if (awaitCredentials && !scheduler.has('credential_recovery')) {
                    scheduler.setIntervalTask('credential_recovery', 60000, checkCredentialRecovery);
                }
                log('系统', `账号 ${name} 自动重连已达上限(${maxAttempts}次)，停止重连`, {
                    accountId: String(accountId),
                    attempts: currentAttempt,
                });
                return;
            }

            // 记录重连计数（先自增，作为下一次判断基准）
            const nextAttempt = kind === 'busy' ? currentAttempt : currentAttempt + 1;
            reconnectAttemptsMap.set(accountId, nextAttempt);

            const baseDelay = cfg.reconnectDelayMin * 60 * 1000;
            const delayMs = kind === 'busy' ? Math.min(baseDelay, 15000) : Math.min(baseDelay * 2 ** Math.max(0, nextAttempt - 1), Math.max(baseDelay, 15 * 60000));
            reconnectPlans.set(accountId, { state: 'scheduled', attempt: nextAttempt, maxAttempts, nextRetryAt: Date.now() + delayMs, reason, kind });
            log('系统', `账号 ${name} 将在 ${delayMs / 1000} 秒后自动重连 (${nextAttempt}/${maxAttempts})${cfg.source === 'qq' ? ' [QQ 独立配置]' : cfg.source === 'account' ? ' [账号级配置]' : ' [全局配置]'}`, {
                accountId: String(accountId),
                delayMin: delayMs / 60000,
                attempt: nextAttempt,
                maxAttempts,
            });

            scheduler.setTimeoutTask(attemptKey, delayMs, async () => {
                scheduler.clear(attemptKey);
                reconnectPlans.delete(accountId);
                // 重连前检查账号是否还存在、是否已有 worker 在跑（无需重复重连）
                const currentWrk = workers[accountId];
                if (currentWrk) return;

                try {
                    const accountsData2 = store.getAccounts();
                    const account2 = (accountsData2.accounts || []).find(a => a.id === accountId);
                    if (!account2) {
                        log('系统', `账号 ${name} 已被删除，取消自动重连`);
                        reconnectAttemptsMap.delete(accountId);
                        return;
                    }
                    // 等待期间可能关闭重连，必须以最新设置为准。
                    const currentConfig = resolveReconnectConfig(account2);
                    if (account2.autoStart === false || !currentConfig.autoReconnect || !(currentConfig.reconnectDelayMin > 0)
                        || nextAttempt > currentConfig.reconnectMaxAttempts) return;
                    log('系统', `账号 ${name} 开始自动重连 (${nextAttempt}/${cfg.reconnectMaxAttempts})`);
                    const started = await startWorker(account2, { automatic: true });
                    if (started) {
                        // 【2026-08-12 修复】重连成功后：若账号稳定在线 10 分钟未再断线，清零重连计数。
                        // 原逻辑计数永不清零 → 断线 3 次后 currentAttempt>=maxAttempts 直接停止重连、账号永久离线。
                        // 若 10 分钟内再次断线，计数保留继续累积，仍受 maxAttempts 限制，防止无限重连。
                        scheduler.setTimeoutTask(`reconnect_reset_${accountId}`, RECONNECT_SUCCESS_STABLE_MS, () => {
                            if (workers[accountId]?.status?.connection?.connected) {
                                reconnectAttemptsMap.delete(accountId);
                            }
                        });
                        addAccountLog('reconnect_success',
                            `账号 ${name} 已发起${reconnectLabel(account2)}，等待游戏连接确认 (${nextAttempt}/${cfg.reconnectMaxAttempts})`,
                            accountId, name, { attempt: nextAttempt, maxAttempts: cfg.reconnectMaxAttempts });
                    }
                } catch (e) {
                    log('系统', `账号 ${name} 自动重连启动失败: ${e.message}`);
                }
            });
        } catch (e) {
            log('系统', `账号 ${name} 自动重连逻辑异常: ${e.message}`);
        }
    }

    /**
     * 处理 Worker 消息
     */
    function handleWorkerMessage(accountId, msg) {
        const wrk = workers[accountId];
        if (!wrk) return;

        if (msg.type === 'status_sync') {
            // 状态同步
            wrk.status = normalizeStatusForPanel(msg.data, accountId, wrk.name);
            if (typeof onStatusSync === 'function') {
                onStatusSync(accountId, wrk.status, wrk.name);
            }

            syncAccountProfile(accountId, msg.data, wrk);

            // 同步昵称
            if (msg.data && msg.data.status && msg.data.status.name) {
                const nick = String(msg.data.status.name).trim();
                if (nick && nick !== '未知' && nick !== '未登录') {
                    if (wrk.nick !== nick) {
                        const oldNick = wrk.nick;
                        wrk.nick = nick;
                        addOrUpdateAccount({ id: accountId, nick });
                        if (oldNick !== nick) {
                            log('系统', `已同步账号昵称: ${  oldNick || 'None'  } -> ${  nick}`, {
                                accountId, accountName: wrk.name
                            });
                        }
                    }
                }
            }

            // 连接状态追踪和离线提醒
            const isConnected = !!(msg.data && msg.data.connection && msg.data.connection.connected);
            if (isConnected) {
                wrk.disconnectedSince = 0;
                wrk.offlineReminderTriggered = false;
                wrk.autoDeleteTriggered = false;
                wrk.wsError = null;
            } else if (!wrk.stopping) {
                const now = Date.now();
                if (!wrk.disconnectedSince) wrk.disconnectedSince = now;

                const offlineDuration = now - wrk.disconnectedSince;
                if (!wrk.offlineReminderTriggered && offlineDuration >= 60000) {
                    wrk.offlineReminderTriggered = true;
                    const offlineMinutes = Math.floor(offlineDuration / 60000);
                    log('系统', `账号 ${  wrk.name  } 已离线 ${  offlineMinutes  } 分钟，发送下线提醒`);

                    Promise.resolve(triggerOfflineReminder({
                        accountId,
                        accountName: wrk.name,
                        username: wrk.username,
                        reason: 'offline',
                        offlineMs: offlineDuration
                    })).then(result => {
                        const sent = result?.ok === true;
                        addAccountLog('offline_reminder',
                            `账号 ${wrk.name} 已离线 ${offlineMinutes} 分钟，${sent ? '下线提醒已发送' : result?.status === 'disabled' ? '提醒已关闭' : result?.status === 'unconfigured' ? '提醒未配置，已跳过' : '下线提醒发送失败'}`,
                            accountId, wrk.name, { reason: 'offline', offlineMs: offlineDuration, status: result?.status || 'failed' });
                    }).catch(() => {
                        addAccountLog('offline_reminder', `账号 ${wrk.name} 下线提醒发送失败`, accountId, wrk.name, { status: 'failed' });
                    });
                }

                const autoDeleteMs = typeof getOfflineAutoDeleteMs === 'function'
                    ? getOfflineAutoDeleteMs(wrk.username)
                    : Infinity;
                if (!wrk.autoDeleteTriggered && offlineDuration >= autoDeleteMs) {
                    wrk.autoDeleteTriggered = true;
                    const offlineMinutes = Math.floor(offlineDuration / 60000);
                    log('系统', `账号 ${  wrk.name  } 持续离线 ${  offlineMinutes  } 分钟，自动删除账号信息`, {
                        accountId: String(accountId),
                        accountName: wrk.name
                    });
                    triggerOfflineReminder({
                        accountId,
                        accountName: wrk.name,
                        username: wrk.username,
                        reason: 'offline_timeout',
                        offlineMs: offlineDuration
                    });
                    addAccountLog('offline_delete',
                        `账号 ${  wrk.name  } 持续离线 ${  offlineMinutes  } 分钟，已自动删除`,
                        accountId, wrk.name, { reason: 'offline_timeout', offlineMs: offlineDuration });
                    stopWorker(accountId);
                    try {
                        if (typeof deleteAccount === 'function') deleteAccount(accountId);
                    } catch (err) {
                        log('错误', `删除离线账号失败: ${  err.message}`);
                    }
                }
            }
        } else if (msg.type === 'log') {
            // 日志消息
            const entry = {
                ...msg.data,
                accountId,
                accountName: wrk.name,
                ts: Date.now(),
                meta: msg.data && msg.data.meta ? msg.data.meta : {}
            };
            entry._searchText = (`${entry.msg || ''  } ${  entry.tag || ''
                } ${  JSON.stringify(entry.meta || {})}`).toLowerCase();

            wrk.logs.push(entry);
            if (wrk.logs.length > 1000) wrk.logs.shift();

            globalLogs.push(entry);
            if (globalLogs.length > 2000) globalLogs.shift();

            if (typeof onWorkerLog === 'function') {
                onWorkerLog(entry, accountId, wrk.name);
            }
        } else if (msg.type === 'error') {
            log('错误', `账号[${  accountId  }]进程报错: ${  msg.error}`, {
                accountId: String(accountId),
                accountName: wrk.name
            });
        } else if (msg.type === 'ws_error') {
            // WebSocket 错误
            const code = Number(msg.code) || 0;
            const message = msg.message || '';
            wrk.wsError = { code, message, at: Date.now() };

            // Code 400 = 登录失效（code 过期 / 异地登录）。纳入离线重连调度，
            // 由 startWorker 在重连前自动刷新 code，而不是永久停止。
            if (code === 400) {
                triggerOfflineReminder({
                    accountId,
                    accountName: wrk.name,
                    reason: 'ws_400',
                    offlineMs: 0
                });
                addAccountLog('ws_400',
                    `账号 ${  wrk.name  } 登录失效，尝试自动重连并刷新 Code`,
                    accountId, wrk.name);
                scheduleReconnect(accountId, 'ws_400');
            } else {
                addAccountLog('ws_error',
                    `账号 ${  wrk.name  } 连接错误 (code=${  code  })`,
                    accountId, wrk.name);
            }
        } else if (msg.type === 'account_kicked') {
            // 被踢下线：纳入离线重连调度（受 autoReconnect + maxAttempts 控制），
            // 不再直接 stopWorker 永久停止。重连前 startWorker 会刷新 code 尝试恢复。
            const reason = msg.reason || '未知';
            triggerOfflineReminder({
                accountId,
                accountName: wrk.name,
                reason: `kickout:${  reason}`,
                offlineMs: 0
            });
            addAccountLog('kickout_reconnect',
                `账号 ${  wrk.name  } 被踢下线，已加入自动重连队列`,
                accountId, wrk.name, { reason });
            scheduleReconnect(accountId, `kickout:${  reason}`);
        } else if (msg.type === 'ws_reconnect_failed') {
            const reason = msg.reason || '未知';
            triggerOfflineReminder({
                accountId,
                accountName: wrk.name,
                reason: `ws_reconnect_failed:${  reason}`,
                offlineMs: 0
            });
            const account = require('../models/store').getAccounts().accounts.find(a => String(a.id) === String(accountId));
            addAccountLog('ws_reconnect_failed',
                `账号 ${wrk.name} 连接中断，交由${reconnectLabel(account)}处理`,
                accountId, wrk.name, { reason });
            scheduleReconnect(accountId, `ws_reconnect_failed:${  reason}`);
        } else if (msg.type === 'known_friend_gids_sync') {
            if (Array.isArray(msg.gids)) {
                const store = require('../models/store');
                store.setKnownFriendGids(accountId, msg.gids);
            }
        } else if (msg.type === 'automation_patch') {
            const patch = msg.patch && typeof msg.patch === 'object' ? msg.patch : {};
            if ((patch.automation && typeof patch.automation === 'object')
                || patch.friendBadRetryDate !== undefined || patch.friendHelpExpExhausted !== undefined) {
                const store = require('../models/store');
                store.applyConfigSnapshot(patch, { accountId });
                const currentWrk = workers[accountId];
                if (currentWrk && currentWrk.process) {
                    currentWrk.process.send({
                        type: 'config_sync',
                        config: buildConfigSnapshotForAccount(accountId)
                    });
                }
            }
        } else if (msg.type === 'api_response') {
            // API 响应
            const { id, result, error } = msg;
            scheduler.clear(`api_timeout_${  accountId  }_${  id}`);

            const pending = wrk.requests.get(id);
            if (pending) {
                if (error) pending.reject(Object.assign(new Error(error), { code: msg.errorCode }));
                else pending.resolve(result);
                wrk.requests.delete(id);
            }
        } else if (msg.type === 'friend_blacklist_add') {
            // 好友黑名单添加
            const gid = Number(msg.gid) || 0;
            if (gid > 0) {
                const { addFriendToBlacklist } = require('../models/store');
                addFriendToBlacklist(accountId, gid);
                log('好友', `已将好友 ${  msg.friendName || `GID:${  gid}`  } 加入黑名单`, {
                    accountId: String(accountId),
                    accountName: wrk.name,
                    friendGid: gid,
                    friendName: msg.friendName,
                    reason: msg.reason
                });

                // 同步黑名单到 Worker
                const currentWrk = workers[accountId];
                if (currentWrk && currentWrk.process) {
                    currentWrk.process.send({
                        type: 'config_sync',
                        config: buildConfigSnapshotForAccount(accountId)
                    });
                }
            }
        }
    }

    /**
     * 调用 Worker API（RPC）
     */
    function callWorkerApi(accountId, method, ...args) {
        const wrk = workers[accountId];
        if (!wrk) return Promise.reject(new Error('账号未运行'));

        // 检查最后一个参数是否包含 _timeoutMs
        const lastArg = args.at(-1);
        const customTimeout = lastArg && typeof lastArg === 'object' && lastArg._timeoutMs;
        const timeoutMs = customTimeout
            ? Number(lastArg._timeoutMs) || 10000
            : 10000;

        const actualArgs = customTimeout ? args.slice(0, -1) : args;

        return new Promise((resolve, reject) => {
            const reqId = wrk.reqId++;
            wrk.requests.set(reqId, { resolve, reject });

            // API 超时保护
            scheduler.setTimeoutTask(`api_timeout_${  accountId  }_${  reqId}`, timeoutMs, () => {
                if (wrk.requests.has(reqId)) {
                    wrk.requests.delete(reqId);
                    reject(new Error('API Timeout'));
                }
            });

            wrk.process.send({
                type: 'api_call',
                id: reqId,
                method,
                args: actualArgs
            });
        });
    }

    return {
        getWorkerRuntime,
        startWorker,
        stopWorker,
        restartWorker,
        refreshYybCodeIfNeeded,
        callWorkerApi
    };
}

module.exports = { createWorkerManager };
