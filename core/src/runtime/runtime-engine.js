const { fork } = require('node:child_process');
const path = require('node:path');
const process = require('node:process');
const { Worker } = require('node:worker_threads');
const store = require('../models/store');
const { updateRuntimeConfig } = require('../config/config');
const { sendPushooMessage, sendSmtpEmail } = require('../services/push');
const { createAutoCodeRefreshService } = require('./auto-code-refresh');
const { createDataProvider } = require('./data-provider');
const { createReloginReminderService } = require('./relogin-reminder');
const { createRuntimeState } = require('./runtime-state');
const { createWorkerManager } = require('./worker-manager');
const { createLoginRecovery } = require('../services/login-recovery');

function getRestorableAccounts(accounts) {
    return (Array.isArray(accounts) ? accounts : [])
        .filter(account => account && account.autoStart !== false);
}

/** 操作类型键列表 */
const OPERATION_KEYS = [
    'harvest', 'water', 'weed', 'bug', 'farming', 'fertilize', 'plant',
    'steal', 'helpWater', 'helpWeed', 'helpBug',
    'taskClaim', 'sell', 'upgrade', 'tongQiGift'
];

/**
 * 创建运行时引擎
 * @param {object} options
 * @param {object} options.processRef - process 引用
 * @param {string} options.mainEntryPath - 主入口文件路径
 * @param {string} options.workerScriptPath - Worker 脚本路径
 * @param {string} options.runtimeMode - 运行模式 'thread' | 'fork'
 * @param {Function} options.onStatusSync - 状态同步回调
 * @param {Function} options.onLog - 日志回调
 * @param {Function} options.onAccountLog - 账号日志回调
 * @param {Function} options.startAdminServer - 启动管理服务器回调
 */
function createRuntimeEngine(options = {}) {
    const processRef = options.processRef || process;
    const mainEntryPath = options.mainEntryPath || path.join(__dirname, '../../client.js');
    const workerScriptPath = options.workerScriptPath || path.join(__dirname, '../core/worker.js');
    const runtimeMode = String(options.runtimeMode || processRef.env.FARM_RUNTIME_MODE || 'thread').toLowerCase();
    const onStatusSync = typeof options.onStatusSync === 'function' ? options.onStatusSync : null;
    const onLog = typeof options.onLog === 'function' ? options.onLog : null;
    const onAccountLog = typeof options.onAccountLog === 'function' ? options.onAccountLog : null;
    const startAdminServer = typeof options.startAdminServer === 'function' ? options.startAdminServer : null;

    // Worker 启动/重启的引用占位
    const engine = { startWorker: null, restartWorker: null, getWorkerRuntime: null };
    const loginRecovery = createLoginRecovery();

    // 创建运行时状态
    const runtimeState = createRuntimeState({
        store,
        operationKeys: OPERATION_KEYS
    });

    const {
        workers,
        globalLogs,
        accountLogs,
        runtimeEvents,
        nextConfigRevision,
        buildConfigSnapshotForAccount,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildDefaultStatus,
        filterLogs
    } = runtimeState;

    // 创建重登提醒服务
    const reloginReminder = createReloginReminderService({
        store,
        sendPushooMessage,
        sendSmtpEmail,
        log,
        getAccounts: store.getAccounts,
    });
    const { getOfflineAutoDeleteMs, triggerOfflineReminder } = reloginReminder;

    const autoCodeRefresh = createAutoCodeRefreshService({
        loginRecovery,
        store,
        getAccounts: store.getAccounts,
        addOrUpdateAccount: store.addOrUpdateAccount,
        resolveWorkerControls: () => engine,
        log,
        addAccountLog
    });

    // 创建 Worker 管理器
    const {
        getWorkerRuntime,
        startWorker,
        stopWorker,
        restartWorker,
        refreshYybCodeIfNeeded,
        callWorkerApi
    } = createWorkerManager({
        loginRecovery,
        fork,
        WorkerThread: Worker,
        runtimeMode,
        processRef,
        mainEntryPath,
        workerScriptPath,
        workers,
        globalLogs,
        store,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildConfigSnapshotForAccount,
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        addOrUpdateAccount: store.addOrUpdateAccount,
        deleteAccount: store.deleteAccount,
        refreshQqCode: (account, options) => require('../services/qq-login-service').getQqLoginService().refreshAccountCode(account, options),
        onStatusSync: (accountId, status, accountName) => {
            runtimeEvents.emit('status', { accountId, status, accountName });
            if (onStatusSync) onStatusSync(accountId, status, accountName);
        },
        onWorkerLog: (entry, accountId, accountName) => {
            runtimeEvents.emit('worker_log', { entry, accountId, accountName });
            if (onLog) onLog(entry, accountId, accountName);
        }
    });

    engine.startWorker = startWorker;
    engine.restartWorker = restartWorker;
    engine.getWorkerRuntime = getWorkerRuntime;

    // 创建数据提供器
    const dataProviderDeps = {
        getWorkerRuntime,
        workers,
        globalLogs,
        accountLogs,
        store,
        getAccounts: store.getAccounts,
        callWorkerApi,
        buildDefaultStatus,
        normalizeStatusForPanel,
        filterLogs,
        addAccountLog,
        nextConfigRevision,
        broadcastConfigToWorkers,
        startWorker,
        stopWorker,
        restartWorker,
        refreshYybCodeIfNeeded,
        scheduleAutoCodeRefresh: autoCodeRefresh.scheduleAccount,
        cancelCodeRefresh: autoCodeRefresh.stopAccount,
        refreshAccountCode: autoCodeRefresh.refreshAccountCode
    };
    const dataProvider = createDataProvider(dataProviderDeps);

    // 绑定全局日志事件
    runtimeEvents.on('log', (entry) => {
        if (onLog) {
            onLog(
                entry,
                entry && entry.accountId ? entry.accountId : '',
                entry && entry.accountName ? entry.accountName : ''
            );
        }
    });

    runtimeEvents.on('account_log', (entry) => {
        if (onAccountLog) onAccountLog(entry);
    });

    /** 广播配置到所有/指定 Worker */
    function broadcastConfigToWorkers(accountId = '') {
        const targetId = String(accountId || '').trim();
        for (const [id, worker] of Object.entries(workers)) {
            if (targetId && String(id) !== targetId) continue;
            const config = buildConfigSnapshotForAccount(id);
            try {
                worker.process.send({ type: 'config_sync', config });
            } catch { }
        }
    }

    /** 游戏资源更新独立通知，不触发账号设置同步或自动化重排。 */
    function broadcastGameConfigReload() {
        let sent = 0;
        let failed = 0;
        for (const worker of Object.values(workers)) {
            try {
                worker.process.send({ type: 'game_config_reload' });
                sent++;
            } catch (err) {
                failed++;
                log('系统', `通知 Worker 刷新游戏配置失败: ${err.message}`);
            }
        }
        return { sent, failed };
    }

    /** 恢复上次仍处于运行状态的账号；旧数据没有 autoStart 时按运行恢复。 */
    async function startAllAccounts() {
        const accounts = store.getAccounts().accounts || [];
        const restorable = getRestorableAccounts(accounts);
        if (restorable.length > 0) {
            log('系统', `发现 ${restorable.length} 个需恢复运行的账号，正在启动...`);
            for (const acc of restorable) {
                await startWorker(acc);
            }
        } else if (accounts.length > 0) {
            log('系统', '所有账号上次均已停止，不自动启动');
        } else {
            log('系统', '未发现账号，请访问管理面板添加账号');
        }
    }

    /** 引擎启动入口 */
    async function start(startOpts = {}) {
        const shouldStartAdmin = startOpts.startAdminServer !== false;
        const shouldAutoStart = startOpts.autoStartAccounts !== false;

        // 加载系统配置
        const sysConfig = store.getSystemConfig();
        if (sysConfig) {
            updateRuntimeConfig(sysConfig);
            log('系统', `已加载系统配置: serverUrl=${  sysConfig.serverUrl
                 }, clientVersion=${  sysConfig.clientVersion
                 }, platform=${  sysConfig.platform}`);
        }

        if (shouldStartAdmin && startAdminServer) {
            startAdminServer(dataProvider);
        }

        if (shouldAutoStart) {
            startAllAccounts();
        }
        autoCodeRefresh.rescheduleAll();
    }

    /** 停止所有账号 */
    function stopAllAccounts() {
        autoCodeRefresh.close();
        loginRecovery.clear();
        const ids = new Set([...Object.keys(workers), ...store.getAccounts().accounts.map(account => account.id)]);
        for (const id of ids) {
            stopWorker(id);
        }
    }

    return {
        store,
        runtimeEvents,
        workers,
        dataProvider,
        start,
        startAllAccounts,
        stopAllAccounts,
        broadcastConfigToWorkers,
        broadcastGameConfigReload,
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi,
        log,
        addAccountLog
    };
}

module.exports = { createRuntimeEngine, getRestorableAccounts };
