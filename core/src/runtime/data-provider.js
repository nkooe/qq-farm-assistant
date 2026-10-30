const {
    findAccountByRef,
    normalizeAccountRef
} = require('../services/account-resolver');
const { getSchedulerRegistrySnapshot } = require('../services/scheduler');
const { loginIdentity } = require('../services/login-recovery');

/**
 * 创建数据提供器 —— 封装对 Worker 的 API 调用，供 Admin Server 使用
 */
function createDataProvider(deps) {
    const {
        workers,
        getWorkerRuntime,
        globalLogs,
        accountLogs,
        store,
        getAccounts,
        callWorkerApi,
        buildDefaultStatus,
        normalizeStatusForPanel,
        filterLogs,
        nextConfigRevision,
        broadcastConfigToWorkers,
        startWorker,
        stopWorker,
        restartWorker,
        refreshYybCodeIfNeeded,
        scheduleAutoCodeRefresh,
        refreshAccountCode
    } = deps;
    const manualRefreshes = new Map();
    const refreshControllers = new Map();
    const deletingUsers = new Set();
    const suspendingUsers = new Map();
    const accountDeletions = new Map();
    const getAccountAccessRejection = deps.getAccountAccessRejection || require('../services/account-access').getAccountAccessRejection;
    function assertAccountAccess(account) {
        const rejection = getAccountAccessRejection(account);
        if (deletingUsers.has(account.userId) || suspendingUsers.has(account.userId) || rejection) {
            throw Object.assign(new Error(rejection?.error || '用户已停用'), { status: 403 });
        }
    }

    function suspendUser(userId) {
        if (suspendingUsers.has(userId)) return suspendingUsers.get(userId);
        const ids = new Set(getAllAccountList().filter(account => account.userId === userId).map(account => String(account.id)));
        for (const [id, worker] of Object.entries(workers)) if (worker.userId === userId) ids.add(id);
        const operations = [];
        const refreshes = [];
        const issue = action => { try { operations.push(action()); } catch (error) { operations.push(Promise.reject(error)); } };
        // Issue every cancellation before awaiting any individual upstream request.
        for (const id of ids) {
            refreshControllers.get(id)?.abort();
            issue(() => deps.cancelCodeRefresh(id));
            issue(() => deps.stopWorkerAndWait(id));
            refreshes.push(manualRefreshes.get(id));
        }
        const operation = Promise.all([Promise.allSettled(operations), Promise.allSettled(refreshes)]).then(([results]) => {
            const failure = results.find(result => result.status === 'rejected');
            if (failure) throw failure.reason;
        }).finally(() => {
            if (suspendingUsers.get(userId) === operation) suspendingUsers.delete(userId);
        });
        suspendingUsers.set(userId, operation);
        return operation;
    }

    /** 获取账号列表 */
    function getAllAccountList() {
        const data = getAccounts();
        return Array.isArray(data.accounts) ? data.accounts : [];
    }

    /** 解析账号引用（account-ref / accountId） */
    function resolveAccountId(ref) {
        return normalizeAccountRef(ref);
    }

    /** 根据引用查找账号 */
    function findAccount(ref) {
        return findAccountByRef(getAllAccountList(), ref);
    }

    // 超时配置
    const FRIEND_TIMEOUT = { _timeoutMs: 180000 };       // 3分钟
    const SYNC_TIMEOUT = { _timeoutMs: 180000 };          // 3分钟
    const DOG_INFO_TIMEOUT = { _timeoutMs: 600000 };     // 10分钟

    return {
        /** 获取账号运行状态 */
        getStatus: (ref) => {
            const id = resolveAccountId(ref);
            if (!id) return buildDefaultStatus('');

            const worker = workers[id];
            if (!worker || !worker.status) return buildDefaultStatus(id);

            return {
                ...buildDefaultStatus(id),
                ...normalizeStatusForPanel(worker.status, id, worker.name),
                wsError: worker.wsError || null
            };
        },

        /** 获取日志 */
        getLogs: (ref, opts) => {
            const options = typeof opts === 'object' && opts ? opts : { limit: opts };
            const limit = Math.max(100, Number(options.limit) || 200);

            const normalized = normalizeAccountRef(ref);
            const id = resolveAccountId(ref);

            if (!normalized || normalized === 'all') {
                return filterLogs(globalLogs, options).slice(-limit);
            }

            if (!id) return [];

            const accountIdStr = String(id || '');
            return filterLogs(
                globalLogs.filter(e => String(e.accountId || '') === accountIdStr),
                options
            ).slice(-limit);
        },

        /** 获取账号操作日志 */
        getAccountLogs: (limit) => accountLogs.slice(-limit).reverse(),

        /** 清空日志 */
        clearLogs: (ref) => {
            const normalized = normalizeAccountRef(ref);
            const id = resolveAccountId(ref);

            if (!normalized || normalized === 'all') {
                globalLogs.length = 0;
                return { cleared: 'all' };
            }

            const result = { cleared: 0 };
            if (!id) return result;

            const idStr = String(id || '');
            const before = globalLogs.length;
            for (let i = globalLogs.length - 1; i >= 0; i--) {
                if (String(globalLogs[i].accountId || '') === idStr) {
                    globalLogs.splice(i, 1);
                }
            }
            const after = globalLogs.length;
            return { cleared: before - after, accountId: id };
        },

        // ========== Farm API ==========
        getLands: (ref) => callWorkerApi(resolveAccountId(ref), 'getLands'),
        getSeeds: (ref) => callWorkerApi(resolveAccountId(ref), 'getSeeds'),
        getBag: (ref) => callWorkerApi(resolveAccountId(ref), 'getBag'),
        featureCall: (ref, method, args) => callWorkerApi(resolveAccountId(ref), 'featureCall', method, args, { _timeoutMs: 180000 }),
        getBagSeeds: (ref) => callWorkerApi(resolveAccountId(ref), 'getBagSeeds'),
        doFarmOp: (ref, op) => callWorkerApi(resolveAccountId(ref), 'doFarmOp', op),
        operateSelectedLands: (ref, action, ids) => callWorkerApi(resolveAccountId(ref), 'operateSelectedLands', action, ids, { _timeoutMs: 60000 }),
        buyFertilizer: (ref, type, count) => callWorkerApi(resolveAccountId(ref), 'buyFertilizer', type, count),
        checkAndBuyFertilizer: (ref, opts) => callWorkerApi(resolveAccountId(ref), 'checkAndBuyFertilizer', opts),
        fertilizeLand: (ref, landId) => callWorkerApi(resolveAccountId(ref), 'fertilizeLand', landId),
        removePlant: (ref, landId) => callWorkerApi(resolveAccountId(ref), 'removePlant', landId),
        removeAllPlants: (ref) => callWorkerApi(resolveAccountId(ref), 'removeAllPlants'),
        getShopInfo: (ref, shopId) => callWorkerApi(resolveAccountId(ref), 'getShopInfo', shopId),
        buyGoods: (ref, shopId, goodsId, count) => callWorkerApi(resolveAccountId(ref), 'buyGoods', shopId, goodsId, count),
        doAnalytics: (ref, days) => callWorkerApi(resolveAccountId(ref), 'getAnalytics', days),

        // ========== Friend API ==========
        getFriends: (ref, force = false) => callWorkerApi(resolveAccountId(ref), 'getFriends', force,
            force ? FRIEND_TIMEOUT : undefined),
        getActivityList: (ref) => callWorkerApi(resolveAccountId(ref), 'getActivityList'),
        getActivityGroupRaw: (ref, activityId, uid) => callWorkerApi(resolveAccountId(ref), 'getActivityGroupRaw', activityId, uid),
        getServerVersion: (ref) => callWorkerApi(resolveAccountId(ref), 'getServerVersion'),
        clearFriendsCache: (ref) => callWorkerApi(resolveAccountId(ref), 'clearFriendsCache'),
        getInteractRecords: (ref) => callWorkerApi(resolveAccountId(ref), 'getInteractRecords'),
        getFriendLands: (ref, gid) => callWorkerApi(resolveAccountId(ref), 'getFriendLands', gid),
        doFriendOp: (ref, gid, op) => callWorkerApi(resolveAccountId(ref), 'doFriendOp', gid, op),
        getFriendDogInfo: (ref, gid) => callWorkerApi(resolveAccountId(ref), 'getFriendDogInfo', gid),
        batchGetFriendDogInfo: (ref, gids) => callWorkerApi(resolveAccountId(ref), 'batchGetFriendDogInfo', gids),
        syncFriendsFromGids: (ref, gids) => callWorkerApi(resolveAccountId(ref), 'syncFriendsFromGids', gids, SYNC_TIMEOUT),
        fetchFriendsDogInfo: (ref) => callWorkerApi(resolveAccountId(ref), 'fetchFriendsDogInfo', DOG_INFO_TIMEOUT),
        delFriend: (ref, gid) => callWorkerApi(resolveAccountId(ref), 'delFriend', gid),
        // 分享卡加好友：uid(gid) + openid + share_key → 账号 worker 内 ReportArkClick
        sendReportArkClick: (ref, uid, openid, shareKey) => callWorkerApi(resolveAccountId(ref), 'sendReportArkClick', uid, openid, shareKey),
        // 护主犬同气礼包：查询可领数量 / 领取
        getDogGiftStatus: (ref) => callWorkerApi(resolveAccountId(ref), 'getDogGiftStatus'),
        claimDogGifts: (ref) => callWorkerApi(resolveAccountId(ref), 'claimDogGifts'),
        // 宠物面板：全量数据 / 出战 / 收回 / 投喂 / 激活 / 看护日志
        getDogPanelData: (ref) => callWorkerApi(resolveAccountId(ref), 'getDogPanelData'),
        deployDog: (ref, dogId) => callWorkerApi(resolveAccountId(ref), 'deployDog', dogId),
        withdrawDog: (ref) => callWorkerApi(resolveAccountId(ref), 'withdrawDog'),
        addDogFood: (ref, foodId, count) => callWorkerApi(resolveAccountId(ref), 'addDogFood', foodId, count),
        activateDog: (ref, dogId) => callWorkerApi(resolveAccountId(ref), 'activateDog', dogId),
        getDogProtectLogs: (ref, from, count, filterType) => callWorkerApi(resolveAccountId(ref), 'getDogProtectLogs', from, count, filterType),

        // ========== 仓库 ==========
        useItem: (ref, itemId, count, uid = 0) => callWorkerApi(resolveAccountId(ref), 'useItem', itemId, count, uid),
        sellItems: (ref, items) => callWorkerApi(resolveAccountId(ref), 'sellItems', items),

        // ========== 每日礼包 ==========
        getDailyGifts: (ref) => callWorkerApi(resolveAccountId(ref), 'getDailyGiftOverview'),

        // ========== Mall ==========
        getMallGoods: (ref) => callWorkerApi(resolveAccountId(ref), 'getMallGoods'),
        buyMallGoods: (ref, goodsId, count) => callWorkerApi(resolveAccountId(ref), 'buyMallGoods', goodsId, count),
        getMysteryShop: (ref) => callWorkerApi(resolveAccountId(ref), 'getMysteryShop'),
        buyMysteryShopGoods: (ref, npcId) => callWorkerApi(resolveAccountId(ref), 'buyMysteryShopGoods', npcId),
        abandonMysteryShop: (ref) => callWorkerApi(resolveAccountId(ref), 'abandonMysteryShop'),

        // ========== Activity ==========
        getActivityShop: (ref) => callWorkerApi(resolveAccountId(ref), 'getActivityShop'),
        buyActivityShopItem: (ref, itemId, count) => callWorkerApi(resolveAccountId(ref), 'buyActivityShopItem', itemId, count),
        refreshActivityShop: (ref) => callWorkerApi(resolveAccountId(ref), 'refreshActivityShop'),
        getHeluActivity: (ref) => callWorkerApi(resolveAccountId(ref), 'getHeluActivity'),
        exchangeHeluShopItem: (ref, slotId, count) => callWorkerApi(resolveAccountId(ref), 'exchangeHeluShopItem', slotId, count),
        drawHeluGiftLotus: (ref, options) => callWorkerApi(resolveAccountId(ref), 'drawHeluGiftLotus', options || {}),
        claimSeasonPassportRewards: (ref) => callWorkerApi(resolveAccountId(ref), 'claimSeasonPassportRewards'),
        claimSolarTermsReward: (ref, termId) => callWorkerApi(resolveAccountId(ref), 'claimSolarTermsReward', termId),
        claimQingmeiSeeds: (ref) => callWorkerApi(resolveAccountId(ref), 'claimQingmeiSeeds'),
        brewAndSellQingmeiWine: (ref, options) => callWorkerApi(resolveAccountId(ref), 'brewAndSellQingmeiWine', options || {}),

        // ========== 观星礼录 ==========
        getGuanxingActivity: (ref) => callWorkerApi(resolveAccountId(ref), 'getGuanxingActivity'),
        claimGuanxingRewards: (ref) => callWorkerApi(resolveAccountId(ref), 'claimGuanxingRewards'),

        // ========== Illustrated ==========
        getIllustratedList: (ref, type, level) => callWorkerApi(resolveAccountId(ref), 'getIllustratedList', type, level),
        claimIllustratedRewards: (ref, type) => callWorkerApi(resolveAccountId(ref), 'claimIllustratedRewards', type),
        getCareerInfo: (ref) => callWorkerApi(resolveAccountId(ref), 'getCareerInfo'),

        // ========== 配置 ==========
        setAutomation: async (ref, key, value) => {
            const id = resolveAccountId(ref);
            if (!id) throw new Error('Missing x-account-id');
            store.setAutomation(key, value, id);
            const rev = nextConfigRevision();
            broadcastConfigToWorkers(id);
            return { automation: store.getAutomation(id), configRevision: rev };
        },

        saveSettings: async (ref, settings) => {
            const id = resolveAccountId(ref);
            if (!id) throw new Error('Missing x-account-id');
            const s = settings && typeof settings === 'object' ? settings : {};
            const patch = {
                plantingStrategy: s.plantingStrategy !== undefined ? s.plantingStrategy : s.strategy,
                preferredSeedId: s.preferredSeedId !== undefined ? s.preferredSeedId : s.seedId,
                prioritize2x2Crops: s.prioritize2x2Crops,
                intervals: s.intervals,
                friendQuietHours: s.friendQuietHours,
                autoCodeRefresh: s.autoCodeRefresh,
                stealDelaySeconds: s.stealDelaySeconds,
                plantOrderRandom: s.plantOrderRandom,
                plantDelaySeconds: s.plantDelaySeconds,
                fertilizerBuyOrganicCount: s.fertilizerBuyOrganicCount,
                fertilizerBuyOrganicThresholdHours: s.fertilizerBuyOrganicThresholdHours,
                fertilizerBuyNormalCount: s.fertilizerBuyNormalCount,
                fertilizerBuyNormalThresholdHours: s.fertilizerBuyNormalThresholdHours,
                fertilizerBuyCheckIntervalMinutes: s.fertilizerBuyCheckIntervalMinutes,
                goldenBugKeepCount: s.goldenBugKeepCount,
                goldenBugRoundLimit: s.goldenBugRoundLimit,
                autoAcceptFriendMinLevel: s.autoAcceptFriendMinLevel,
                bagSeedPriority: s.bagSeedPriority,
                bagSeedFallbackStrategy: s.bagSeedFallbackStrategy,
                bagPriorityLandTypes: s.bagPriorityLandTypes,
                mysteryAutoBuyCurrencies: s.mysteryAutoBuyCurrencies,
            };
            store.applyConfigSnapshot(patch, { accountId: id });
            const rev = nextConfigRevision();
            broadcastConfigToWorkers(id);
            if (s.autoCodeRefresh && typeof scheduleAutoCodeRefresh === 'function') {
                scheduleAutoCodeRefresh(id);
            }
            return {
                strategy: store.getPlantingStrategy(id),
                preferredSeed: store.getPreferredSeed(id),
                prioritize2x2Crops: store.getPrioritize2x2Crops(id),
                intervals: store.getIntervals(id),
                friendQuietHours: store.getFriendQuietHours(id),
                autoCodeRefresh: store.getAutoCodeRefresh(id),
                stealDelaySeconds: store.getStealDelaySeconds(id),
                plantOrderRandom: store.getPlantOrderRandom(id),
                plantDelaySeconds: store.getPlantDelaySeconds(id),
                fertilizerBuyOrganicCount: store.getFertilizerBuyOrganicCount(id),
                fertilizerBuyOrganicThresholdHours: store.getFertilizerBuyOrganicThresholdHours(id),
                fertilizerBuyNormalCount: store.getFertilizerBuyNormalCount(id),
                fertilizerBuyNormalThresholdHours: store.getFertilizerBuyNormalThresholdHours(id),
                fertilizerBuyCheckIntervalMinutes: store.getFertilizerBuyCheckIntervalMinutes(id),
                goldenBugKeepCount: store.getConfigSnapshot(id).goldenBugKeepCount,
                goldenBugRoundLimit: store.getConfigSnapshot(id).goldenBugRoundLimit,
                autoAcceptFriendMinLevel: store.getAutoAcceptFriendMinLevel(id),
                bagSeedPriority: store.getBagSeedPriority(id),
                bagSeedFallbackStrategy: store.getBagSeedFallbackStrategy(id),
                bagPriorityLandTypes: store.getBagPriorityLandTypes(id),
                mysteryAutoBuyCurrencies: store.getMysteryAutoBuyCurrencies(id),
                configRevision: rev
            };
        },

        saveAutoCodeRefresh: async (ref, config) => {
            const id = resolveAccountId(ref);
            if (!id) throw new Error('Missing x-account-id');
            const data = store.setAutoCodeRefresh(id, config || {});
            if (typeof scheduleAutoCodeRefresh === 'function') scheduleAutoCodeRefresh(id);
            return { autoCodeRefresh: data };
        },

        refreshAccountCode: async (ref) => {
            const id = resolveAccountId(ref);
            if (!id) throw new Error('Missing x-account-id');
            const account = findAccount(id);
            if (!account) throw new Error('账号不存在');
            assertAccountAccess(account);
            if (manualRefreshes.has(id)) return manualRefreshes.get(id);
            if (account.loginType === 'yyb' && account.yybOpenid) {
                if (typeof refreshYybCodeIfNeeded !== 'function') {
                    throw new TypeError('应用宝刷新服务不可用');
                }
                const controller = new AbortController();
                refreshControllers.set(id, controller);
                const identity = loginIdentity(account);
                const originalCode = account.code;
                const task = Promise.resolve().then(async () => {
                    const result = await refreshYybCodeIfNeeded({ ...account }, { signal: controller.signal });
                    const current = findAccount(id);
                    if (controller.signal.aborted || !current) return { ok: false, source: 'yyb', error: '账号已停止或删除，本次结果已丢弃' };
                    assertAccountAccess(current);
                    if (loginIdentity(current) !== identity) {
                        // A concurrent startup may already have committed this same shared result.
                        if (result?.ok && current.code === result.code && loginIdentity({ ...current, code: originalCode }) === identity) return { ok: true, source: 'yyb' };
                        return { ok: false, source: 'yyb', error: '账号登录信息已变化，本次结果已丢弃' };
                    }
                    if (!result || result.ok !== true || !result.code) {
                        return {
                            ok: false,
                            source: 'yyb',
                            error: result && result.error ? result.error : '应用宝 Code 刷新失败',
                        };
                    }
                    store.addOrUpdateAccount({ id, code: result.code });
                    if (workers[id] || getWorkerRuntime?.(id)?.state === 'starting') {
                        await restartWorker({ ...current, code: result.code }, { skipYybRefresh: true });
                    }
                    return { ok: true, source: 'yyb' };
                }).finally(() => {
                    if (manualRefreshes.get(id) === task) manualRefreshes.delete(id);
                    if (refreshControllers.get(id) === controller) refreshControllers.delete(id);
                });
                manualRefreshes.set(id, task);
                return task;
            }
            if (typeof refreshAccountCode !== 'function') throw new Error('自动刷新服务不可用');
            const ok = await refreshAccountCode(id, 'manual');
            return {
                ok,
                source: 'wxid',
                error: ok ? '' : '微信 Code 刷新失败',
            };
        },

        setUITheme: async (theme, userId) => {
            const result = store.setUITheme(theme, userId);
            return { ui: result.ui || store.getUI(userId) };
        },

        broadcastConfig: (accountId) => {
            broadcastConfigToWorkers(accountId);
        },

        setRuntimeAccountName: (ref, name) => {
            const id = resolveAccountId(ref);
            if (!id) return;
            const worker = workers[id];
            if (worker) {
                worker.name = String(name || worker.name || id);
            }
        },

        // ========== 账号管理 ==========
        getAccounts: () => {
            const data = getAccounts();
            data.accounts.forEach(acc => {
                const worker = workers[acc.id];
                acc.running = !!worker;
                const runtime = typeof getWorkerRuntime === 'function' ? getWorkerRuntime(acc.id) : null;
                acc.connected = runtime?.connected ?? !!worker?.status?.connection?.connected;
                acc.runtimeState = runtime?.state || (acc.connected ? 'online' : worker ? 'starting' : 'stopped');
                acc.runtimeError = runtime?.error || '';
                acc.runtimeReconnect = runtime?.reconnect || null;
                acc.runtimeLogin = runtime?.login || null;
                if (worker && worker.status && worker.status.status && worker.status.status.name) {
                    acc.nick = worker.status.status.name;
                }
            });
            return data;
        },

        removeUserData: async (userId) => {
            deletingUsers.add(userId);
            const ids = getAllAccountList().filter(account => account.userId === userId).map(account => String(account.id));
            await suspendUser(userId);
            for (const logs of [globalLogs, accountLogs]) {
                for (let i = logs.length - 1; i >= 0; i--) if (ids.includes(String(logs[i].accountId))) logs.splice(i, 1);
            }
        },

        suspendUser,
        reloadProxyProfile: async (profileId) => {
            const accounts = getAllAccountList().filter(account => account.proxyMode === 'static' && account.proxyProfileId === profileId);
            const operations = [];
            for (const account of accounts) {
                const id = String(account.id);
                refreshControllers.get(id)?.abort();
                operations.push(deps.cancelCodeRefresh(id), deps.stopWorkerAndWait(id));
            }
            await Promise.all(operations);
            for (const previous of accounts) {
                const account = findAccount(previous.id);
                if (!account || account.autoStart === false || getAccountAccessRejection(account)) continue;
                scheduleAutoCodeRefresh(account.id);
                // Credentials may take a minute to refresh; the save response waits for
                // old connections to stop, while the new startup reports its own status.
                void Promise.resolve(startWorker(account, { automatic: true })).catch(error => deps.addAccountLog('start_failed', error.message, account.id, account.name));
            }
        },
        resumeUser: async (userId) => {
            if (suspendingUsers.has(userId)) await suspendingUsers.get(userId);
            const accounts = getAllAccountList().filter(account => account.userId === userId);
            for (const previous of accounts) {
                const account = findAccount(previous.id);
                if (!account || account.userId !== userId || account.deleting) continue;
                assertAccountAccess(account);
                scheduleAutoCodeRefresh(account.id);
                if (account.autoStart === true) await startWorker(account, { automatic: true });
            }
        },

        getAccountRuntime: (ref) => {
            const id = resolveAccountId(ref);
            if (!findAccount(id || ref)) return null;
            if (typeof getWorkerRuntime === 'function') return getWorkerRuntime(id);
            const running = !!workers[id];
            const connected = !!workers[id]?.status?.connection?.connected;
            return { state: connected ? 'online' : running ? 'starting' : 'stopped', connected, running, error: '' };
        },

        startAccount: (ref, options = {}) => {
            const id = resolveAccountId(ref);
            const account = findAccount(id || ref);
            if (!account) return false;
            assertAccountAccess(account);
            refreshControllers.get(id)?.abort();
            deps.cancelCodeRefresh?.(id);
            account.autoStart = true;
            store.addOrUpdateAccount({ id: account.id, autoStart: true });
            scheduleAutoCodeRefresh?.(id);
            const runtime = typeof getWorkerRuntime === 'function' ? getWorkerRuntime(account.id) : null;
            if (workers[account.id] && !workers[account.id]?.status?.connection?.connected && runtime?.state !== 'starting') {
                Promise.resolve(restartWorker(account, options)).catch(error => deps.addAccountLog('start_failed', error.message, id, account.name));
            } else {
                Promise.resolve(startWorker(account, options)).catch(error => deps.addAccountLog('start_failed', error.message, id, account.name));
            }
            return true;
        },

        stopAccount: (ref) => {
            const id = resolveAccountId(ref);
            const account = findAccount(id || ref);
            if (!account) return false;
            refreshControllers.get(id)?.abort();
            deps.cancelCodeRefresh?.(id);
            account.autoStart = false;
            store.addOrUpdateAccount({ id: account.id, autoStart: false });
            if (id) stopWorker(id);
            return true;
        },

        deleteAccount: (ref) => {
            const id = resolveAccountId(ref);
            if (accountDeletions.has(id)) return accountDeletions.get(id);
            const operation = Promise.resolve().then(async () => {
                const account = store.beginAccountDeletion(id);
                refreshControllers.get(id)?.abort();
                // Issue both cancellations before waiting; stop may itself wait
                // for the cancelled credential request to settle.
                const issue = action => { try { return Promise.resolve(action()); } catch (error) { return Promise.reject(error); } };
                const cancellations = [issue(() => deps.cancelCodeRefresh(id)), issue(() => deps.stopWorkerAndWait(id))];
                const [results] = await Promise.all([Promise.allSettled(cancellations), Promise.allSettled([manualRefreshes.get(id)])]);
                const failure = results.find(result => result.status === 'rejected');
                if (failure) throw failure.reason;
                await (deps.purgeQqAccount || (account => require('../services/qq-login-service').getQqLoginService().purgeAccount(account)))(account);
                const data = store.deleteAccount(id);
                for (const logs of [globalLogs, accountLogs]) {
                    for (let i = logs.length - 1; i >= 0; i--) if (String(logs[i].accountId) === id) logs.splice(i, 1);
                }
                return data;
            }).finally(() => { if (accountDeletions.get(id) === operation) accountDeletions.delete(id); });
            accountDeletions.set(id, operation);
            return operation;
        },

        restartAccount: (ref, options = {}) => {
            const id = resolveAccountId(ref);
            const account = findAccount(id || ref);
            if (!account) return false;
            refreshControllers.get(id)?.abort();
            deps.cancelCodeRefresh?.(id);
            assertAccountAccess(account);
            Promise.resolve(restartWorker(account, options)).catch(error => deps.addAccountLog('restart_failed', error.message, id, account.name));
            return true;
        },

        isAccountRunning: (ref) => {
            const id = resolveAccountId(ref);
            return !!(id && workers[id]);
        },

        getRunningAccountCount: () => Object.keys(workers).length,

        // ========== 调度器状态 ==========
        getSchedulerStatus: async (ref) => {
            const id = resolveAccountId(ref);
            const runtimeSchedulers = getSchedulerRegistrySnapshot();
            let workerSchedulers = null;
            let workerError = '';

            if (!id) {
                return { accountId: '', runtime: runtimeSchedulers, worker: workerSchedulers, workerError: '' };
            }

            if (!workers[id]) {
                return { accountId: id, runtime: runtimeSchedulers, worker: workerSchedulers, workerError: '账号未运行' };
            }

            try {
                workerSchedulers = await callWorkerApi(id, 'getSchedulers');
            } catch (err) {
                workerError = err && err.message ? err.message : String(err || 'unknown');
            }

            return { accountId: id, runtime: runtimeSchedulers, worker: workerSchedulers, workerError };
        }
    };
}

module.exports = { createDataProvider };
