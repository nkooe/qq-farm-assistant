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
        resolveAccountProxy = account => require('../services/account-proxy').resolveProxyURL(account, {
            userId: account?.userId || '',
        }),
        refreshQqCode,
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        addOrUpdateAccount,
        deleteAccount,
        onStatusSync,
        onWorkerLog
    } = deps;
    const getAccountAccessRejection = deps.getAccountAccessRejection || require('../services/account-access').getAccountAccessRejection;

    const scheduler = createScheduler('worker_manager');
    const workerExits = new WeakMap();
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

    // 每个账号独立退避；创建 Worker 不等于已经连接游戏。
    const reconnectAttemptsMap = new Map();
    const RECONNECT_DELAYS_MS = [60000, 5 * 60000, 10 * 60000];
    const RECONNECT_SUCCESS_STABLE_MS = 10 * 60 * 1000;
    const CONNECT_TIMEOUT_MS = 90000;

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
        const worker = threadMode ? createThreadWorker(account) : createForkWorker(account);
        workerExits.set(worker, new Promise(resolve => worker.once('exit', resolve)));
        return worker;
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
            const wxConfig = store.getUserWxConfig(account.userId);
            const yybApiBase = String(process.env.YYB_API_URL || '').trim();
            const yybApiKey = String(process.env.YYB_API_KEY || '').trim();
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
                    ...require('../services/user-identity').trustedUserHeaders(account.userId),
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
        const stored = require('../models/store').getAccounts().accounts.find(item => item.id === account.id);
        if (!stored || stored.deleting || stored.autoStart !== true || loginIdentity(stored) !== loginIdentity(account)) return false;
        const rejection = getAccountAccessRejection(account);
        if (rejection) {
            stopWorker(account.id);
            startupResults.set(account.id, { updatedAt: Date.now(), error: rejection.error, kind: 'cancelled' });
            return false;
        }
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
                if (!current || current.deleting || current.autoStart !== true || loginIdentity(current) !== start.identity) start.cancelled = true;
                if (!start.cancelled) {
                    startupResults.set(account.id, { updatedAt: Date.now(), error: safeRuntimeError(error.message || '启动失败'), category: error.startupCategory || '', kind: classifyLoginError(error) });
                    log('错误', `账号 ${account.name} 启动失败: ${safeRuntimeError(error.message)}`, { accountId: String(account.id) });
                }
                return false;
            } finally {
                if (startingWorkers.get(account.id) === start) {
                    startingWorkers.delete(account.id);
                    // 取码失败同样退避重试，不依赖尚未创建的 Worker 上报断线。
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
        const isCurrent = () => {
            const current = require('../models/store').getAccounts().accounts.find(a => String(a.id) === String(account.id));
            const valid = !!current && !current.deleting && current.autoStart === true
                && loginIdentity(current) === identity && !getAccountAccessRejection(current);
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
            addOrUpdateAccount({ id: account.id, code: freshCode });
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
            userId: account.userId || '',
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

        // 发送启动配置
        proc.send({
            type: 'start',
            config: { ...buildConfigSnapshotForAccount(account.id), deviceProtocol: require('../models/store').getUserDeviceProtocol(account.userId), code: account.code, platform: account.platform, proxyURL }
        });

        // 发送配置快照
        proc.send({
            type: 'config_sync',
            config: buildConfigSnapshotForAccount(account.id)
        });

        scheduler.setTimeoutTask(`connect_timeout_${account.id}`, CONNECT_TIMEOUT_MS, () => {
            const current = workers[account.id];
            if (current?.process === proc && !current.stopping && !current.status?.connection?.connected) {
                void scheduleReconnect(account.id, '连接游戏超时');
            }
        }).unref?.();

        // 监听 Worker 消息
        proc.on('message', (msg) => {
            if (workers[account.id]?.process !== proc) return;
            try {
                handleWorkerMessage(account.id, msg);
            } catch (error) {
                if (!String(error?.code || '').startsWith('STORAGE_')) throw error;
                addAccountLog('config_save_failed', error.message, account.id, account.name, { code: error.code });
            }
        });

        // 监听 Worker 错误
        proc.on('error', (err) => {
            if (workers[account.id]?.process !== proc) return;
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
            if (wrk && wrk.process !== proc) return;
            const displayName = wrk && wrk.name ? wrk.name : account.name;

            log('系统', `账号 ${  displayName  } 进程退出 (code=${  code
                }, signal=${  signal || 'none'  })`, {
                accountId: String(account.id),
                accountName: displayName,
                runtimeMode: threadMode ? 'thread' : 'fork'
            });

            scheduler.clear(`force_kill_${  account.id}`);

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
                scheduler.clear(`connect_timeout_${account.id}`);
                scheduler.clear(`reconnect_reset_${account.id}`);
                if (!wrk.stopping) void scheduleReconnect(account.id, 'worker_exited', { stopCurrent: false });
            }
        });

        return true;
    }

    /**
     * 停止账号 Worker
     * @param {string} accountId 账号 ID
     * @param {object} [opts]
     * @param {boolean} [opts.resetReconnect] 手动停止或删除时清除退避状态；自动恢复时保留。
     */
    function stopWorker(accountId, opts = {}) {
        const { resetReconnect = true, preserveRestart = false } = opts;
        if (!preserveRestart) {
            restartingWorkers.delete(accountId);
        }
        if (resetReconnect) {
            startupResults.delete(accountId);
            reconnectPlans.delete(accountId);
        }
        const pending = startingWorkers.get(accountId);
        if (pending) { pending.cancelled = true; pending.controller?.abort(); }
        loginRecovery.cancel(accountId);

        // 取消尚未触发的离线重连计划
        scheduler.clear(`reconnect_attempt_${accountId}`);
        scheduler.clear(`connect_timeout_${accountId}`);
        scheduler.clear(`reconnect_reset_${accountId}`);
        if (resetReconnect) {
            // 仅「账号退役 / 用户主动停止」场景清零计数；自动重连循环内不在此清零
            reconnectAttemptsMap.delete(accountId);
        }

        // 即使尚未创建 Worker，也要取消启动失败留下的重试计划。
        const wrk = workers[accountId];
        if (!wrk) return;
        if (wrk.stopping) return;

        const targetProc = wrk.process;
        wrk.stopping = true;

        // Arm termination before IPC: a closed channel must not strand a
        // stopping worker and prevent deletion or access revocation.
        scheduler.setTimeoutTask(`force_kill_${  accountId}`, 1000, () => {
            const current = workers[accountId];
            if (current && current.process === targetProc) {
                current.process.kill();
            }
        });
        try {
            wrk.process.send({ type: 'stop' });
        } catch (error) {
            addAccountLog('stop_failed', '停止指令发送失败，等待强制终止', accountId, wrk.name, { reason: safeRuntimeError(error.message) });
        }
    }

    async function stopWorkerAndWait(accountId, options = {}) {
        const pending = startingWorkers.get(accountId);
        const process = workers[accountId]?.process;
        const exited = process ? workerExits.get(process) : null;
        if (process && !exited) throw new Error('账号进程退出监听未初始化');
        stopWorker(accountId, options);
        if (pending) await pending.promise;
        if (exited) {
            let timer;
            try {
                await Promise.race([exited, new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('账号进程停止超时，删除已中止')), 7000);
                })]);
            } finally { clearTimeout(timer); }
        }
    }

    /**
     * 重启账号 Worker
     */
    async function restartWorker(account, options = {}) {
        if (!account) return;
        const accountId = account.id;
        const store = require('../models/store');
        const current = store.getAccounts().accounts.find(item => item.id === accountId);
        if (!current || current.deleting || current.autoStart !== true || loginIdentity(current) !== loginIdentity(account)) return false;
        const wrk = workers[accountId];

        // 如果未运行，直接启动
        if (!wrk) return startWorker(account, options);

        const restart = { identity: loginIdentity(account) };
        restartingWorkers.set(accountId, restart);
        await stopWorkerAndWait(accountId, { preserveRestart: true });
        if (restartingWorkers.get(accountId) !== restart) return false;
        restartingWorkers.delete(accountId);
        const stored = store.getAccounts().accounts.find(a => String(a.id) === String(accountId));
        if (!stored || stored.deleting || stored.autoStart !== true || loginIdentity(stored) !== restart.identity) return false;
        return startWorker(stored, options);
    }

    function isNativeQq(account) {
        return account?.platform === 'qq' && account.loginType !== 'yyb' && !account.yybOpenid;
    }

    function reconnectLabel(account) {
        return isNativeQq(account) ? 'QQ 原生登录态重连' : account?.loginType === 'yyb' ? '应用宝离线重连' : '账号重连';
    }

    function resolveReconnectConfig(account) {
        if (isNativeQq(account)) {
            return { autoReconnect: !!account.qqLoginProfile && account.qqAutoReconnect !== false, source: 'qq' };
        }
        if (account.provider === 'thirdparty' && account.thirdparty?.autoReconnect !== undefined) {
            return { autoReconnect: account.thirdparty.autoReconnect === true, source: 'account' };
        }
        return { autoReconnect: require('../models/store').getUserWxConfig(account.userId).autoReconnect === true, source: 'user' };
    }

    // 1、5、10 分钟退避，之后每 10 分钟继续；明确失效或用户停止才暂停。
    async function scheduleReconnect(accountId, reason, { stopCurrent = true, kind: failureKind } = {}) {
        const wrk = workers[accountId];
        const name = wrk ? wrk.name : accountId;
        if (stopCurrent) {
            const error = wrk?.wsError?.message || reason;
            stopWorker(accountId, { resetReconnect: false });
            startupResults.set(accountId, { updatedAt: Date.now(), error, kind: failureKind || 'temporary' });
        }
        try {
            const store = require('../models/store');
            const account = store.getAccounts().accounts.find(a => a.id === accountId);
            if (!account || account.autoStart !== true || getAccountAccessRejection(account)) {
                scheduler.clear(`reconnect_attempt_${accountId}`);
                reconnectAttemptsMap.delete(accountId);
                reconnectPlans.delete(accountId);
                return;
            }
            const cfg = resolveReconnectConfig(account);
            const kind = startupResults.get(accountId)?.kind || 'temporary';
            if (['rescan', 'configuration', 'cancelled'].includes(kind)) {
                scheduler.clear(`reconnect_attempt_${accountId}`);
                reconnectPlans.set(accountId, { state: kind === 'rescan' ? 'needs_rescan' : 'blocked',
                    attempt: reconnectAttemptsMap.get(accountId) || 0, nextRetryAt: null, reason, kind });
                return;
            }
            if (!cfg.autoReconnect) {
                reconnectPlans.delete(accountId);
                if (isNativeQq(account) && !account.qqLoginProfile) reconnectPlans.set(accountId, {
                    state: 'needs_rescan', attempt: 0, nextRetryAt: null, reason, kind: 'rescan',
                });
                const hint = isNativeQq(account) && !account.qqLoginProfile ? '缺少可恢复的 QQ 登录态，请使用 QQ 扫码更新一次' : `未启用${reconnectLabel(account)}`;
                log('系统', `账号 ${name} ${hint}，已停止`, { accountId });
                return;
            }
            const attemptKey = `reconnect_attempt_${accountId}`;
            if (scheduler.has(attemptKey)) return;
            const nextAttempt = Math.min(Number.MAX_SAFE_INTEGER, (reconnectAttemptsMap.get(accountId) || 0) + 1);
            reconnectAttemptsMap.set(accountId, nextAttempt);
            const delayMs = RECONNECT_DELAYS_MS[Math.min(nextAttempt - 1, RECONNECT_DELAYS_MS.length - 1)];
            const plan = { state: 'scheduled', attempt: nextAttempt, nextRetryAt: Date.now() + delayMs, reason, kind };
            const identity = loginIdentity(account);
            reconnectPlans.set(accountId, plan);
            log('系统', `账号 ${name} 将在 ${delayMs / 60000} 分钟后重新取码重连（第 ${nextAttempt} 次）`, {
                accountId, delayMin: delayMs / 60000, attempt: nextAttempt,
            });
            scheduler.setTimeoutTask(attemptKey, delayMs, async () => {
                if (reconnectPlans.get(accountId) !== plan) return;
                scheduler.clear(attemptKey);
                reconnectPlans.delete(accountId);
                const current = store.getAccounts().accounts.find(a => a.id === accountId);
                if (!current || current.autoStart !== true || current.deleting || getAccountAccessRejection(current)
                    || loginIdentity(current) !== identity || !resolveReconnectConfig(current).autoReconnect) return;
                if (workers[accountId]) return;
                const started = await startWorker(current, { automatic: true });
                if (started) addAccountLog('reconnect_started',
                    `账号 ${name} 已发起${reconnectLabel(current)}，等待游戏连接确认（第 ${nextAttempt} 次）`,
                    accountId, name, { attempt: nextAttempt });
            }).unref?.();
        } catch (error) {
            log('系统', `账号 ${name} 自动重连异常: ${safeRuntimeError(error.message)}`, { accountId });
        }
    }

    /**
     * 处理 Worker 消息
     */
    function handleWorkerMessage(accountId, msg) {
        const wrk = workers[accountId];
        if (!wrk) return;
        if (wrk.stopping && ['ws_error', 'account_kicked', 'ws_reconnect_failed'].includes(msg.type)) return;

        if (msg.type === 'status_sync') {
            if (wrk.stopping) return;
            // 状态同步
            const wasConnected = !!wrk.status?.connection?.connected;
            wrk.status = normalizeStatusForPanel(msg.data, accountId, wrk.name);
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
                const last = startupResults.get(accountId);
                if (last?.error || last?.kind) startupResults.set(accountId, { updatedAt: Date.now(), error: '' });
                reconnectPlans.delete(accountId);
                scheduler.clear(`reconnect_attempt_${accountId}`);
                scheduler.clear(`connect_timeout_${accountId}`);
                if (!wasConnected) scheduler.setTimeoutTask(`reconnect_reset_${accountId}`, RECONNECT_SUCCESS_STABLE_MS, () => {
                    if (workers[accountId] === wrk && wrk.status?.connection?.connected) reconnectAttemptsMap.delete(accountId);
                }).unref?.();
                loginRecovery.confirmConnected(accountId);
            } else if (!wrk.stopping) {
                scheduler.clear(`reconnect_reset_${accountId}`);
                const now = Date.now();
                if (!wrk.disconnectedSince) wrk.disconnectedSince = now;

                const offlineDuration = now - wrk.disconnectedSince;
                if (!wrk.offlineReminderTriggered && offlineDuration >= 60000) {
                    wrk.offlineReminderTriggered = true;
                    const offlineMinutes = Math.floor(offlineDuration / 60000);
                    log('系统', `账号 ${  wrk.name  } 已离线 ${  offlineMinutes  } 分钟，发送下线提醒`, { accountId: String(accountId) });

                    Promise.resolve(triggerOfflineReminder({
                        accountId,
                        accountName: wrk.name,
                        userId: wrk.userId,
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
                    ? getOfflineAutoDeleteMs(wrk.userId)
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
                        userId: wrk.userId,
                        reason: 'offline_timeout',
                        offlineMs: offlineDuration
                    });
                    Promise.resolve().then(() => deleteAccount(accountId)).catch(err => {
                        log('错误', `删除离线账号失败: ${safeRuntimeError(err.message)}`, { accountId: String(accountId) });
                    });
                }
            }
            if (typeof onStatusSync === 'function') {
                onStatusSync(accountId, wrk.status, wrk.name);
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
            const reason = safeRuntimeError(msg.reason || '未知');
            triggerOfflineReminder({ accountId, accountName: wrk.name, reason: `kickout:${reason}`, offlineMs: 0 });
            addAccountLog('kickout_reconnect', `账号 ${wrk.name} 已被踢下线，等待重新取码`, accountId, wrk.name);
            void scheduleReconnect(accountId, reason, { kind: 'kicked' });
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
        if (wrk.stopping) return Promise.reject(Object.assign(new Error('账号正在停止，操作已拒绝'), { status: 409 }));

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
        stopWorkerAndWait,
        restartWorker,
        refreshYybCodeIfNeeded,
        callWorkerApi
    };
}

module.exports = { createWorkerManager };
