const { assertUserId, isUserId, parseUserId } = require('./user-id');
const process = require('node:process');
const fs = require('node:fs');
const path = require('node:path');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const { getDefaultSystemConfig } = require('../config/config');
const { readJsonFile, readJsonFileStrict, writeJsonFileAtomic, storageError } = require('../services/json-db');
const { createConfigStorage } = require('./store/config-storage');

// ==================== 文件路径 ====================

const STORE_FILE = getDataFile('store.json');
const ACCOUNTS_FILE = getDataFile('accounts.json');
const configStorage = createConfigStorage(STORE_FILE);
const KNOWN_FRIEND_GIDS_DIR = getDataFile('known_friend_gids');
const FRIEND_DOG_INFO_DIR = getDataFile('friend_dog_info');
const FRIEND_LIST_CACHE_DIR = getDataFile('friend_list_cache');

// ==================== 缓存目录辅助 ====================

function ensureKnownFriendGidsDir() {
    if (!fs.existsSync(KNOWN_FRIEND_GIDS_DIR)) {
        fs.mkdirSync(KNOWN_FRIEND_GIDS_DIR, { recursive: true });
    }
    return KNOWN_FRIEND_GIDS_DIR;
}

function ensureFriendDogInfoDir() {
    if (!fs.existsSync(FRIEND_DOG_INFO_DIR)) {
        fs.mkdirSync(FRIEND_DOG_INFO_DIR, { recursive: true });
    }
    return FRIEND_DOG_INFO_DIR;
}

function ensureFriendListCacheDir() {
    if (!fs.existsSync(FRIEND_LIST_CACHE_DIR)) {
        fs.mkdirSync(FRIEND_LIST_CACHE_DIR, { recursive: true });
    }
    return FRIEND_LIST_CACHE_DIR;
}

// ==================== 已知好友 GID 缓存 ====================

function getKnownFriendGidsCacheFile(accountId) {
    const safeName = String(accountId || '').replace(/[^\w-]/g, '_');
    return path.join(ensureKnownFriendGidsDir(), `${safeName  }.json`);
}

function readKnownFriendGidsCache(accountId) {
    const data = readJsonFile(getKnownFriendGidsCacheFile(accountId), null);
    if (data === null) return null;
    if (!Array.isArray(data.gids)) throw new Error('好友缓存格式无效');
    return data.gids;
}

function writeKnownFriendGidsCache(accountId, gids) {
    const filePath = getKnownFriendGidsCacheFile(accountId);
    writeJsonFileAtomic(filePath, { gids, updatedAt: Date.now() });
}

// ==================== 好友狗狗信息缓存 ====================

function getFriendDogInfoCacheFile(accountId) {
    const safeName = String(accountId || '').replace(/[^\w-]/g, '_');
    return path.join(ensureFriendDogInfoDir(), `${safeName  }.json`);
}

function readFriendDogInfoCache(accountId) {
    return require('../services/friend-pet-cache').guards(accountId);
}

function writeFriendDogInfoCache(accountId, dogInfo) {
    const cache = require('../services/friend-pet-cache');
    for (const gid of Object.keys(cache.guards(accountId))) {
        if (!dogInfo?.[gid]) cache.forget(gid, accountId);
    }
    for (const [gid, info] of Object.entries(dogInfo || {})) cache.record(gid, info.dogId, accountId);
}

// ==================== 好友列表缓存 ====================

function getFriendListCacheFile(accountId) {
    const safeName = String(accountId || '').replace(/[^\w-]/g, '_');
    return path.join(ensureFriendListCacheDir(), `${safeName  }.json`);
}

function readFriendListCache(accountId) {
    const data = readJsonFile(getFriendListCacheFile(accountId), null);
    if (data === null) return null;
    if (!Array.isArray(data.friends)) throw new Error('好友缓存格式无效');
    return data.friends;
}

function writeFriendListCache(accountId, friends) {
    const filePath = getFriendListCacheFile(accountId);
    writeJsonFileAtomic(filePath, { friends, updatedAt: Date.now() });
}

function removeFriendFromCache(accountId, gid) {
    const targetGid = Number(gid);
    if (!targetGid) return;

    const friends = readFriendListCache(accountId);
    if (friends) {
        const filtered = friends.filter(f => Number(f.gid) !== targetGid);
        if (filtered.length !== friends.length) writeFriendListCache(accountId, filtered);
    }
    require('../services/friend-pet-cache').forget(targetGid, accountId);
}

function deleteFriendListCache(accountId) {
    const file = getFriendListCacheFile(accountId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
}

function deleteFriendDogInfoCache(accountId) {
    require('../services/friend-pet-cache').clear(accountId);
    const retired = getFriendDogInfoCacheFile(accountId);
    if (fs.existsSync(retired)) fs.unlinkSync(retired);
}

function deleteKnownFriendGidsCache(accountId) {
    const file = getKnownFriendGidsCacheFile(accountId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
}

function deleteAccountCaches(accountId) {
    deleteFriendListCache(accountId);
    deleteFriendDogInfoCache(accountId);
    deleteKnownFriendGidsCache(accountId);
}

// ==================== 允许的策略 ====================

const ALLOWED_PLANTING_STRATEGIES = [
    'preferred', 'level', 'max_exp', 'max_fert_exp',
    'max_profit', 'max_fert_profit', 'bag_priority'
];
const ALLOWED_BAG_SEED_FALLBACK_STRATEGIES = ALLOWED_PLANTING_STRATEGIES.filter(s => s !== 'bag_priority');
const PUSHOO_CHANNELS = new Set([
    'webhook', 'qmsg', 'serverchan', 'pushplus', 'pushplushxtrip',
    'dingtalk', 'wecom', 'bark', 'gocqhttp', 'onebot', 'atri',
    'pushdeer', 'igot', 'telegram', 'feishu', 'ifttt', 'wecombot',
    'discord', 'wxpusher',
]);

// ==================== 默认配置 ====================

const DEFAULT_OFFLINE_REMINDER = {
    enabled: true,
    channel: 'smtp',
    endpoint: '',
    token: '',
    title: '账号下线提醒',
    msg: '账号下线',
    offlineDeleteSec: 0,
    smtpHost: '',
    smtpPort: 465,
    smtpUser: '',
    smtpPass: '',
    senderName: '',
    recipientEmail: '',
    emailContent: ''
};

const DEFAULT_FERTILIZER_LAND_TYPES = ['purple', 'gold', 'black', 'red', 'normal'];
const FERTILIZER_LAND_TYPE_SET = new Set(DEFAULT_FERTILIZER_LAND_TYPES);

/** 默认自动化配置 */
const DEFAULT_AUTOMATION = {
    farm: true,
    farm_push: true,
    land_upgrade: false,
    friend: true,
    friend_help_exp_limit: true,
    friend_turbo_mode: false,
    friend_steal: true,
    friend_help: true,
    friend_bad: false,
    friend_golden_bug: false,
    task: true,
    milk_tea: true,
    fertilizer_gift: false,
    fertilizer_buy_organic: false,
    fertilizer_buy_normal: false,
    mystery_auto_buy: false,
    sell: false,
    fertilizer: 'smart_normal',
    fertilizer_multi_season: true,
    fertilizer_land_types: [...DEFAULT_FERTILIZER_LAND_TYPES],
    fertilizer_smart_seconds: 300,
    skip_own_weed_bug: true,
    golden_bug_clear: true,
    friend_turbo_scheduled: false,
    friend_turbo_schedule_time: '08:00-10:00'
};

/** 默认间隔配置（秒） */
const DEFAULT_INTERVALS = {
    farm: 2,
    farmMin: 2,
    farmMax: 5,
    helpMin: 30,
    helpMax: 35,
    stealMin: 25,
    stealMax: 30
};

/** 默认静默时段 */
const DEFAULT_QUIET_HOURS = {
    enabled: false,
    start: '01:00',
    end: '07:30'
};

/** 默认植物黑名单（一些特殊/活动作物ID） */
const DEFAULT_PLANT_BLACKLIST = [20002, 26739, 20059, 20065, 20064, 20060, 20061];

/** 默认账号配置 */
const DEFAULT_ACCOUNT_CONFIG = {
    automation: DEFAULT_AUTOMATION,
    autoCodeRefresh: {
        enabled: false,
        intervalMinutes: 60
    },
    plantingStrategy: 'max_exp',
    preferredSeedId: 0,
    prioritize2x2Crops: false,
    friendBadRetryDate: '',
    intervals: DEFAULT_INTERVALS,
    friendQuietHours: DEFAULT_QUIET_HOURS,
    knownFriendGids: [],
    friendBlacklist: [],
    plantBlacklist: DEFAULT_PLANT_BLACKLIST,
    stealDelaySeconds: 1,
    plantOrderRandom: true,
    plantDelaySeconds: 2,
    fertilizerBuyOrganicCount: 1,
    fertilizerBuyOrganicThresholdHours: 10,
    fertilizerBuyNormalCount: 1,
    fertilizerBuyNormalThresholdHours: 10,
    fertilizerBuyCheckIntervalMinutes: 60,
    mysteryAutoBuyCurrencies: [],
    bagSeedPriority: [],
    bagSeedFallbackStrategy: 'level',
    bagPriorityLandTypes: [...DEFAULT_FERTILIZER_LAND_TYPES],
    autoAcceptFriendMinLevel: 0,
    goldenBugKeepCount: 0,
    goldenBugRoundLimit: 24,
    friendHelpExpExhausted: false
};

const ALLOWED_AUTOMATION_KEYS = new Set(Object.keys(DEFAULT_ACCOUNT_CONFIG.automation));

// ==================== 标准化函数 ====================

function normalizeKnownFriendGids(rawGids, fallback = []) {
    const input = rawGids === undefined ? fallback : rawGids;
    if (!Array.isArray(input)) throw new Error('好友 GID 必须为列表');
    const result = [];
    for (const item of input) {
        const gid = Number.parseInt(item, 10);
        if (!Number.isFinite(gid) || gid <= 0) continue;
        if (result.includes(gid)) continue;
        result.push(gid);
    }
    return result;
}

function normalizeBagSeedPriority(rawList) {
    if (rawList === undefined) return [];
    if (!Array.isArray(rawList)) throw new Error('种子优先级必须为列表');
    const result = [];
    for (const item of rawList) {
        const seedId = Number.parseInt(item, 10);
        if (!Number.isFinite(seedId) || seedId <= 0) continue;
        if (result.includes(seedId)) continue;
        result.push(seedId);
    }
    return result;
}

function normalizeBagSeedFallbackStrategy(rawStrategy, fallback = 'level') {
    const strategy = String(rawStrategy || '').trim();
    if (ALLOWED_BAG_SEED_FALLBACK_STRATEGIES.includes(strategy)) return strategy;
    if (rawStrategy === undefined) return fallback;
    throw new Error('背包第二种植策略无效');
}

function normalizeFertilizerLandTypes(rawTypes, fallback = DEFAULT_FERTILIZER_LAND_TYPES) {
    const input = rawTypes === undefined ? fallback : rawTypes;
    if (!Array.isArray(input)) throw new Error('土地类型必须为列表');
    const result = [];
    for (const item of input) {
        const key = String(item || '').trim().toLowerCase();
        if (!FERTILIZER_LAND_TYPE_SET.has(key)) throw new Error('土地类型无效');
        if (result.includes(key)) continue;
        result.push(key);
    }
    return result;
}

// 背包种子优先策略：优先种植的指定品质地块（默认全选）
function normalizeBagPriorityLandTypes(rawTypes, fallback = DEFAULT_FERTILIZER_LAND_TYPES) {
    const input = rawTypes === undefined ? fallback : rawTypes;
    if (!Array.isArray(input)) throw new Error('土地类型必须为列表');
    const result = [];
    for (const item of input) {
        const key = String(item || '').trim().toLowerCase();
        if (!FERTILIZER_LAND_TYPE_SET.has(key)) throw new Error('土地类型无效');
        if (result.includes(key)) continue;
        result.push(key);
    }
    return result;
}

function normalizeOfflineReminder(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const def = DEFAULT_OFFLINE_REMINDER;

    const endpoint = input.endpoint !== undefined && input.endpoint !== null
        ? String(input.endpoint).trim() : def.endpoint;

    const rawChannel = input.channel !== undefined && input.channel !== null
        ? String(input.channel).trim().toLowerCase() : '';
    const channel = rawChannel || def.channel;
    if (channel !== 'smtp' && !PUSHOO_CHANNELS.has(channel)) throw new Error('推送渠道无效');

    let offlineDeleteSec = Number.parseInt(input.offlineDeleteSec, 10);
    if (!Number.isFinite(offlineDeleteSec) || offlineDeleteSec < 0) offlineDeleteSec = def.offlineDeleteSec;

    const token = input.token !== undefined && input.token !== null
        ? String(input.token).trim() : def.token;

    const title = input.title !== undefined && input.title !== null
        ? String(input.title).trim() : def.title;

    const msg = input.msg !== undefined && input.msg !== null
        ? String(input.msg).trim() : def.msg;

    const smtpHost = input.smtpHost !== undefined && input.smtpHost !== null
        ? String(input.smtpHost).trim() : def.smtpHost;

    const smtpPortRaw = Number.parseInt(input.smtpPort, 10);
    const smtpPort = (!Number.isFinite(smtpPortRaw) || smtpPortRaw <= 0 || smtpPortRaw > 65535)
        ? def.smtpPort : smtpPortRaw;

    const smtpUser = input.smtpUser !== undefined && input.smtpUser !== null
        ? String(input.smtpUser).trim() : def.smtpUser;

    const smtpPass = input.smtpPass !== undefined && input.smtpPass !== null
        ? String(input.smtpPass).trim() : def.smtpPass;

    const senderName = input.senderName !== undefined && input.senderName !== null
        ? String(input.senderName).trim() : def.senderName;

    const recipientEmail = input.recipientEmail !== undefined && input.recipientEmail !== null
        ? String(input.recipientEmail).trim() : def.recipientEmail;

    const emailContent = input.emailContent !== undefined && input.emailContent !== null
        ? String(input.emailContent).trim() : def.emailContent;

    return {
        enabled: input.enabled !== false,
        channel,
        endpoint,
        token,
        title,
        msg,
        offlineDeleteSec,
        smtpHost,
        smtpPort,
        smtpUser,
        smtpPass,
        senderName,
        recipientEmail,
        emailContent
    };
}

function normalizeTimeString(raw, fallback) {
    const str = String(raw || '').trim();
    const match = str.match(/^(\d{1,2}):(\d{1,2})$/);
    if (raw === undefined) return fallback;
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error('时间必须为有效 HH:mm');

    const hour = Math.max(0, Math.min(23, Number.parseInt(match[1], 10)));
    const minute = Math.max(0, Math.min(59, Number.parseInt(match[2], 10)));
    return `${String(hour).padStart(2, '0')  }:${  String(minute).padStart(2, '0')}`;
}

function normalizeIntervals(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const toInt = (val, def) => Math.max(1, Number.parseInt(val, 10) || def);

    const farm = toInt(input.farm, 2);
    let farmMin = toInt(input.farmMin, farm);
    let farmMax = toInt(input.farmMax, farm);
    if (farmMin > farmMax) [farmMin, farmMax] = [farmMax, farmMin];

    let helpMin = toInt(input.helpMin, 30);
    let helpMax = toInt(input.helpMax, 35);
    if (helpMin > helpMax) [helpMin, helpMax] = [helpMax, helpMin];

    let stealMin = toInt(input.stealMin, 25);
    let stealMax = toInt(input.stealMax, 30);
    if (stealMin > stealMax) [stealMin, stealMax] = [stealMax, stealMin];

    return { ...input, farm, farmMin, farmMax, helpMin, helpMax, stealMin, stealMax };
}

// ==================== 配置克隆/合并 ====================

function cloneAccountConfig(config = DEFAULT_ACCOUNT_CONFIG) {
    const srcAuto = config && config.automation && typeof config.automation === 'object'
        ? config.automation : {};
    const auto = { ...DEFAULT_ACCOUNT_CONFIG.automation };

    for (const key of Object.keys(auto)) {
        if (key === 'fertilizer_land_types') {
            auto[key] = normalizeFertilizerLandTypes(srcAuto[key], DEFAULT_FERTILIZER_LAND_TYPES);
            continue;
        }
        if (srcAuto[key] !== undefined) {
            auto[key] = srcAuto[key];
        }
    }

    const knownFriendGids = normalizeKnownFriendGids(config.knownFriendGids);
    const plantBlacklist = Array.isArray(config.plantBlacklist) ? config.plantBlacklist : [];

    return {
        ...config,
        automation: auto,
        autoCodeRefresh: {
            enabled: config.autoCodeRefresh && config.autoCodeRefresh.enabled === true,
            intervalMinutes: Math.max(1, Math.min(1440, Number(config.autoCodeRefresh && config.autoCodeRefresh.intervalMinutes) || 60))
        },
        intervals: { ...config.intervals || DEFAULT_ACCOUNT_CONFIG.intervals },
        friendQuietHours: { ...config.friendQuietHours || DEFAULT_ACCOUNT_CONFIG.friendQuietHours },
        knownFriendGids,
        friendBlacklist: normalizeFriendBlacklist(config.friendBlacklist),
        plantingStrategy: ALLOWED_PLANTING_STRATEGIES.includes(String(config.plantingStrategy || ''))
            ? String(config.plantingStrategy) : DEFAULT_ACCOUNT_CONFIG.plantingStrategy,
        preferredSeedId: Math.max(0, Number.parseInt(config.preferredSeedId, 10) || 0),
        prioritize2x2Crops: config.prioritize2x2Crops === true,
        plantBlacklist: plantBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0),
        stealDelaySeconds: Math.max(0, Math.min(60, Number(config.stealDelaySeconds) || 1)),
        plantOrderRandom: !!config.plantOrderRandom,
        plantDelaySeconds: Math.max(0, Math.min(60, Number(config.plantDelaySeconds) || 2)),
        fertilizerBuyOrganicCount: Math.max(0, Math.min(999, Number(config.fertilizerBuyOrganicCount) || 1)),
        fertilizerBuyOrganicThresholdHours: Math.max(0, Math.min(720, Number(config.fertilizerBuyOrganicThresholdHours) || 10)),
        fertilizerBuyNormalCount: Math.max(0, Math.min(999, Number(config.fertilizerBuyNormalCount) || 1)),
        fertilizerBuyNormalThresholdHours: Math.max(0, Math.min(720, Number(config.fertilizerBuyNormalThresholdHours) || 10)),
        fertilizerBuyCheckIntervalMinutes: Math.max(1, Math.min(1440, Number(config.fertilizerBuyCheckIntervalMinutes) || 60)),
        autoAcceptFriendMinLevel: Math.max(0, Math.min(200, Number(config.autoAcceptFriendMinLevel) || 0)),
        goldenBugKeepCount: Math.max(0, Math.min(9999, Number(config.goldenBugKeepCount) || 0)),
        goldenBugRoundLimit: Math.max(1, Math.min(100, Number(config.goldenBugRoundLimit) || 24)),
        bagSeedPriority: normalizeBagSeedPriority(config.bagSeedPriority),
        bagSeedFallbackStrategy: normalizeBagSeedFallbackStrategy(config.bagSeedFallbackStrategy),
        bagPriorityLandTypes: normalizeBagPriorityLandTypes(config.bagPriorityLandTypes)
    };
}

function resolveAccountId(accountId) {
    const fromParam = accountId !== undefined && accountId !== null ? String(accountId).trim() : '';
    if (fromParam) return fromParam;
    return String(process.env.FARM_ACCOUNT_ID || '').trim();
}

// ==================== 全局配置 ====================

const DEFAULT_LOGIN_LINKS = {
    logoUrl: '',
    title: 'QQ农场智能助手',
    loginSubtitle: '欢迎回来，开启智慧农耕之旅',
    registerSubtitle: '创建账号，开启智慧农耕之旅',
    purchaseUrl: '',
    qqGroupUrl: ''
};

let accountDefaults = (() => {
    const cfg = { ...DEFAULT_ACCOUNT_CONFIG };
    cfg.automation = { ...DEFAULT_ACCOUNT_CONFIG.automation };
    cfg.intervals = { ...DEFAULT_ACCOUNT_CONFIG.intervals };
    cfg.friendQuietHours = { ...DEFAULT_ACCOUNT_CONFIG.friendQuietHours };
    cfg.knownFriendGids = [];
    cfg.automation.fertilizer_land_types = [...DEFAULT_FERTILIZER_LAND_TYPES];
    return cfg;
})();

const globalConfig = {
    accountConfigs: {},
    defaultAccountConfig: cloneAccountConfig(DEFAULT_ACCOUNT_CONFIG),
    userDefaultAccountPlans: {},
    userUis: {},
    userWxConfigs: {},
    userOfflineReminders: {},
    announcement: { enabled: false, title: '系统公告', content: '', showOnce: true, updatedAt: 0 },
    announcementReadRecords: {},
    systemConfig: null,
    loginLinks: null,
    userDeviceProtocols: {}
};

function normalizeAccountConfig(raw, defaults = accountDefaults) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const cfg = cloneAccountConfig(defaults || DEFAULT_ACCOUNT_CONFIG);

    // 合并自动化配置
    if (input.automation && typeof input.automation === 'object') {
        for (const [key, value] of Object.entries(input.automation)) {
            if (!ALLOWED_AUTOMATION_KEYS.has(key)) continue;

            if (key === 'fertilizer') {
                const allowed = ['both', 'normal', 'organic', 'smart', 'smart_only', 'smart_normal', 'final_normal', 'final_organic', 'none'];
                cfg.automation[key] = allowed.includes(value) ? value : cfg.automation[key];
            } else if (key === 'fertilizer_land_types') {
                cfg.automation[key] = normalizeFertilizerLandTypes(value, cfg.automation[key]);
            } else if (key === 'fertilizer_smart_seconds') {
                cfg.automation[key] = Math.max(60, Math.min(7200, Number(value) || 300));
            } else if (typeof value === 'string') {
                // 字符串型自动化配置（如定时极速务农的 HH:mm）原样保留，避免被 !!value 强转成布尔
                cfg.automation[key] = value;
            } else {
                cfg.automation[key] = !!value;
            }
        }
    }

    // 自动刷新 Code
    if (input.autoCodeRefresh && typeof input.autoCodeRefresh === 'object') {
        cfg.autoCodeRefresh = {
            enabled: input.autoCodeRefresh.enabled === true,
            intervalMinutes: Math.max(1, Math.min(1440, Number(input.autoCodeRefresh.intervalMinutes) || 60))
        };
    }

    // 种植策略
    if (input.plantingStrategy && ALLOWED_PLANTING_STRATEGIES.includes(input.plantingStrategy)) {
        cfg.plantingStrategy = input.plantingStrategy;
    }

    // 首选种子
    if (input.preferredSeedId !== undefined && input.preferredSeedId !== null) {
        cfg.preferredSeedId = Math.max(0, Number.parseInt(input.preferredSeedId, 10) || 0);
    }
    if (input.prioritize2x2Crops !== undefined && input.prioritize2x2Crops !== null) {
        cfg.prioritize2x2Crops = input.prioritize2x2Crops === true;
    }
    cfg.friendBadRetryDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.friendBadRetryDate || ''))
        ? String(input.friendBadRetryDate) : '';

    // 间隔配置
    if (input.intervals && typeof input.intervals === 'object') {
        for (const [key, val] of Object.entries(input.intervals)) {
            if (cfg.intervals[key] === undefined) continue;
            cfg.intervals[key] = Math.max(1, Number.parseInt(val, 10) || cfg.intervals[key] || 1);
        }
        cfg.intervals = normalizeIntervals(cfg.intervals);
    } else {
        cfg.intervals = normalizeIntervals(cfg.intervals);
    }

    // 静默时段
    if (input.friendQuietHours && typeof input.friendQuietHours === 'object') {
        const prev = cfg.friendQuietHours || {};
        cfg.friendQuietHours = {
            enabled: input.friendQuietHours.enabled !== undefined
                ? !!input.friendQuietHours.enabled : !!prev.enabled,
            start: normalizeTimeString(input.friendQuietHours.start, prev.start || '23:00'),
            end: normalizeTimeString(input.friendQuietHours.end, prev.end || '07:00')
        };
    }

    // 黑名单
    if (Array.isArray(input.friendBlacklist)) {
        cfg.friendBlacklist = normalizeFriendBlacklist(input.friendBlacklist);
    }

    // 已知好友
    if (input.knownFriendGids !== undefined) {
        cfg.knownFriendGids = normalizeKnownFriendGids(input.knownFriendGids, cfg.knownFriendGids);
    }

    // 植物黑名单
    if (Array.isArray(input.plantBlacklist)) {
        cfg.plantBlacklist = input.plantBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0);
    }

    // 偷菜延迟
    if (input.stealDelaySeconds !== undefined && input.stealDelaySeconds !== null) {
        cfg.stealDelaySeconds = Math.max(0, Math.min(60, Number.parseInt(input.stealDelaySeconds, 10) || 1));
    }

    // 种植顺序随机
    if (input.plantOrderRandom !== undefined && input.plantOrderRandom !== null) {
        cfg.plantOrderRandom = !!input.plantOrderRandom;
    }

    // 种植延迟
    if (input.plantDelaySeconds !== undefined && input.plantDelaySeconds !== null) {
        cfg.plantDelaySeconds = Math.max(0, Math.min(60, Number(input.plantDelaySeconds) || 2));
    }

    // 肥料购买配置
    if (input.fertilizerBuyOrganicCount !== undefined && input.fertilizerBuyOrganicCount !== null) {
        cfg.fertilizerBuyOrganicCount = Math.max(0, Math.min(999, Number(input.fertilizerBuyOrganicCount) || 1));
    }
    if (input.fertilizerBuyOrganicThresholdHours !== undefined && input.fertilizerBuyOrganicThresholdHours !== null) {
        cfg.fertilizerBuyOrganicThresholdHours = Math.max(0, Math.min(720, Number(input.fertilizerBuyOrganicThresholdHours) || 10));
    }
    if (input.fertilizerBuyNormalCount !== undefined && input.fertilizerBuyNormalCount !== null) {
        cfg.fertilizerBuyNormalCount = Math.max(0, Math.min(999, Number(input.fertilizerBuyNormalCount) || 1));
    }
    if (input.fertilizerBuyNormalThresholdHours !== undefined && input.fertilizerBuyNormalThresholdHours !== null) {
        cfg.fertilizerBuyNormalThresholdHours = Math.max(0, Math.min(720, Number(input.fertilizerBuyNormalThresholdHours) || 10));
    }
    if (input.fertilizerBuyCheckIntervalMinutes !== undefined && input.fertilizerBuyCheckIntervalMinutes !== null) {
        cfg.fertilizerBuyCheckIntervalMinutes = Math.max(1, Math.min(1440, Number(input.fertilizerBuyCheckIntervalMinutes) || 60));
    }

    // 神秘商人自动购买货币类型
    if (Array.isArray(input.mysteryAutoBuyCurrencies)) {
        const ALLOWED_MYSTERY_CURRENCIES = [1001, 1002, 1003, 1005];
        cfg.mysteryAutoBuyCurrencies = input.mysteryAutoBuyCurrencies
            .map(n => Number(n))
            .filter(n => ALLOWED_MYSTERY_CURRENCIES.includes(n));
    }

    // 自动接受好友最低等级
    if (input.autoAcceptFriendMinLevel !== undefined && input.autoAcceptFriendMinLevel !== null) {
        cfg.autoAcceptFriendMinLevel = Math.max(0, Math.min(200, Number(input.autoAcceptFriendMinLevel) || 0));
    }
    if (input.goldenBugKeepCount !== undefined && input.goldenBugKeepCount !== null) {
        cfg.goldenBugKeepCount = Math.max(0, Math.min(9999, Number(input.goldenBugKeepCount) || 0));
    }
    if (input.goldenBugRoundLimit !== undefined && input.goldenBugRoundLimit !== null) {
        cfg.goldenBugRoundLimit = Math.max(1, Math.min(100, Number(input.goldenBugRoundLimit) || 24));
    }

    // 背包种子优先级
    if (input.bagSeedPriority !== undefined && input.bagSeedPriority !== null) {
        cfg.bagSeedPriority = normalizeBagSeedPriority(input.bagSeedPriority);
    }

    // 背包种子回退策略
    if (input.bagSeedFallbackStrategy !== undefined && input.bagSeedFallbackStrategy !== null) {
        cfg.bagSeedFallbackStrategy = normalizeBagSeedFallbackStrategy(input.bagSeedFallbackStrategy);
    }

    // 背包种子优先：指定品质地块
    if (input.bagPriorityLandTypes !== undefined && input.bagPriorityLandTypes !== null) {
        cfg.bagPriorityLandTypes = normalizeBagPriorityLandTypes(input.bagPriorityLandTypes);
    }

    return cfg;
}

function pickDefaultPlanConfig(raw) {
    const cfg = normalizeAccountConfig(raw, DEFAULT_ACCOUNT_CONFIG);
    return {
        automation: { ...cfg.automation },
        autoCodeRefresh: { ...cfg.autoCodeRefresh },
        plantingStrategy: cfg.plantingStrategy,
        preferredSeedId: cfg.preferredSeedId,
        prioritize2x2Crops: cfg.prioritize2x2Crops === true,
        intervals: { ...cfg.intervals },
        friendQuietHours: { ...cfg.friendQuietHours },
        stealDelaySeconds: cfg.stealDelaySeconds,
        plantOrderRandom: cfg.plantOrderRandom,
        plantDelaySeconds: cfg.plantDelaySeconds,
        fertilizerBuyOrganicCount: cfg.fertilizerBuyOrganicCount,
        fertilizerBuyOrganicThresholdHours: cfg.fertilizerBuyOrganicThresholdHours,
        fertilizerBuyNormalCount: cfg.fertilizerBuyNormalCount,
        fertilizerBuyNormalThresholdHours: cfg.fertilizerBuyNormalThresholdHours,
        fertilizerBuyCheckIntervalMinutes: cfg.fertilizerBuyCheckIntervalMinutes,
        mysteryAutoBuyCurrencies: [...cfg.mysteryAutoBuyCurrencies],
        goldenBugKeepCount: cfg.goldenBugKeepCount,
        goldenBugRoundLimit: cfg.goldenBugRoundLimit,
        autoAcceptFriendMinLevel: cfg.autoAcceptFriendMinLevel,
        bagSeedPriority: [...cfg.bagSeedPriority],
        bagSeedFallbackStrategy: cfg.bagSeedFallbackStrategy,
        bagPriorityLandTypes: [...cfg.bagPriorityLandTypes]
    };
}

function normalizeUserDefaultPlan(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    return {
        enabled: input.enabled !== false,
        config: pickDefaultPlanConfig(input.config),
        updatedAt: Math.max(0, Number(input.updatedAt) || 0)
    };
}

// ==================== 账号配置读写 ====================

function getAccountConfigSnapshot(accountId) {
    const id = resolveAccountId(accountId);
    if (!id) return cloneAccountConfig(accountDefaults);
    return normalizeAccountConfig(globalConfig.accountConfigs[id], accountDefaults);
}

function setAccountConfigSnapshot(accountId, config, save = true) {
    const id = resolveAccountId(accountId);
    if (!id) {
        const next = normalizeAccountConfig(config, accountDefaults);
        if (save) saveGlobalConfig({ defaultAccountConfig: cloneAccountConfig(next) });
        else {
            accountDefaults = next;
            globalConfig.defaultAccountConfig = cloneAccountConfig(next);
        }
        return cloneAccountConfig(accountDefaults);
    }

    const next = normalizeAccountConfig(config, accountDefaults);
    if (save) configStorage.saveAccount(id, next);
    globalConfig.accountConfigs[id] = next;
    return cloneAccountConfig(globalConfig.accountConfigs[id]);
}

function removeAccountConfig(accountId) {
    const id = resolveAccountId(accountId);
    if (!id) return;
    if (globalConfig.accountConfigs[id]) {
        configStorage.removeAccount(id);
        delete globalConfig.accountConfigs[id];
    }
}

function ensureAccountConfig(accountId, opts = {}) {
    const id = resolveAccountId(accountId);
    if (!id) return null;
    if (globalConfig.accountConfigs[id]) {
        return cloneAccountConfig(globalConfig.accountConfigs[id]);
    }
    return setAccountConfigSnapshot(id, DEFAULT_ACCOUNT_CONFIG, opts.persist !== false);
}

// ==================== 全局配置持久化 ====================

function loadGlobalConfig() {
    ensureDataDir();
    try {
        const data = configStorage.load();

        accountDefaults = cloneAccountConfig(DEFAULT_ACCOUNT_CONFIG);
        globalConfig.defaultAccountConfig = cloneAccountConfig(accountDefaults);

        // 加载各账号配置
        const rawConfigs = data.accountConfigs && typeof data.accountConfigs === 'object'
            ? data.accountConfigs : {};
        globalConfig.accountConfigs = Object.create(null);
        for (const [key, val] of Object.entries(rawConfigs)) {
            const id = String(key || '').trim();
            if (!id) continue;
            globalConfig.accountConfigs[id] = normalizeAccountConfig(val, DEFAULT_ACCOUNT_CONFIG);
        }
        const rawPlans = data.userDefaultAccountPlans && typeof data.userDefaultAccountPlans === 'object'
            ? data.userDefaultAccountPlans : {};
        globalConfig.userDefaultAccountPlans = {};
        for (const [key, val] of Object.entries(rawPlans)) {
            const userId = parseUserId(key);
            if (!userId || !val) continue;
            globalConfig.userDefaultAccountPlans[userId] = normalizeUserDefaultPlan(val);
        }

        // UI 配置
        globalConfig.userUis = { ...data.userUis };
        globalConfig.userWxConfigs = pickUserWxConfigs(data.userWxConfigs);

        // 用户离线提醒
        if (data.userOfflineReminders && typeof data.userOfflineReminders === 'object') {
            globalConfig.userOfflineReminders = {};
            for (const [key, val] of Object.entries(data.userOfflineReminders)) {
                if (key && val) {
                    globalConfig.userOfflineReminders[key] = normalizeOfflineReminder(val);
                }
            }
        }

        // 公告
        if (data.announcement && typeof data.announcement === 'object') {
            globalConfig.announcement = {
                enabled: data.announcement.enabled === true,
                title: String(data.announcement.title || '系统公告').trim(),
                content: String(data.announcement.content || '').trim(),
                showOnce: data.announcement.showOnce !== false,
                updatedAt: Number(data.announcement.updatedAt) || 0
            };
        }
        if (data.announcementReadRecords && typeof data.announcementReadRecords === 'object') {
            globalConfig.announcementReadRecords = { ...data.announcementReadRecords };
        }

        if (data.systemConfig !== undefined && data.systemConfig !== null) validateSystemConfig(data.systemConfig);
        globalConfig.systemConfig = data.systemConfig === undefined || data.systemConfig === null ? getDefaultSystemConfig() : { ...data.systemConfig };

        // 登录页链接
        if (data.loginLinks && typeof data.loginLinks === 'object') {
            globalConfig.loginLinks = {
                logoUrl: String(data.loginLinks.logoUrl ?? '').trim(),
                title: String(data.loginLinks.title || DEFAULT_LOGIN_LINKS.title).trim(),
                loginSubtitle: String(data.loginLinks.loginSubtitle || DEFAULT_LOGIN_LINKS.loginSubtitle).trim(),
                registerSubtitle: String(data.loginLinks.registerSubtitle || DEFAULT_LOGIN_LINKS.registerSubtitle).trim(),
                purchaseUrl: String(data.loginLinks.purchaseUrl ?? '').trim(),
                qqGroupUrl: String(data.loginLinks.qqGroupUrl ?? '').trim()
            };
        }

        // 用户设备协议
        if (data.userDeviceProtocols && typeof data.userDeviceProtocols === 'object') {
            globalConfig.userDeviceProtocols = {};
            for (const [key, val] of Object.entries(data.userDeviceProtocols)) {
                if (key && val) {
                    globalConfig.userDeviceProtocols[key] = {
                        enabled: val.enabled === true,
                        userAgent: String(val.userAgent || DEFAULT_DEVICE_PROTOCOL.userAgent).trim(),
                        deviceModel: String(val.deviceModel || DEFAULT_DEVICE_PROTOCOL.deviceModel).trim(),
                        deviceBrand: String(val.deviceBrand || DEFAULT_DEVICE_PROTOCOL.deviceBrand).trim(),
                        deviceMac: String(val.deviceMac || '').trim(),
                        deviceId: String(val.deviceId || '').trim(),
                        imei: String(val.imei || '').trim()
                    };
                }
            }
        }

    } catch (err) {
        throw storageError('读取', STORE_FILE, err);
    }
}

function sanitizeGlobalConfigBeforeSave(config) {
    config.defaultAccountConfig = cloneAccountConfig(normalizeAccountConfig(config.defaultAccountConfig, DEFAULT_ACCOUNT_CONFIG));

    const rawPlans = config.userDefaultAccountPlans && typeof config.userDefaultAccountPlans === 'object'
        ? config.userDefaultAccountPlans : {};
    const cleanPlans = {};
    for (const [key, val] of Object.entries(rawPlans)) {
        const userId = parseUserId(key);
        if (!userId || !val) continue;
        cleanPlans[userId] = normalizeUserDefaultPlan(val);
    }
    config.userDefaultAccountPlans = cleanPlans;

    const rawReminders = config.userOfflineReminders && typeof config.userOfflineReminders === 'object'
        ? config.userOfflineReminders : {};
    const cleanReminders = {};
    for (const [key, val] of Object.entries(rawReminders)) {
        const id = parseUserId(key);
        cleanReminders[id] = normalizeOfflineReminder(val);
    }
    config.userOfflineReminders = cleanReminders;

    const rawProtocols = config.userDeviceProtocols && typeof config.userDeviceProtocols === 'object'
        ? config.userDeviceProtocols : {};
    const cleanProtocols = {};
    for (const [key, val] of Object.entries(rawProtocols)) {
        const id = parseUserId(key);
        cleanProtocols[id] = {
            enabled: val.enabled === true,
            userAgent: String(val.userAgent || DEFAULT_DEVICE_PROTOCOL.userAgent).trim(),
            deviceModel: String(val.deviceModel || DEFAULT_DEVICE_PROTOCOL.deviceModel).trim(),
            deviceBrand: String(val.deviceBrand || DEFAULT_DEVICE_PROTOCOL.deviceBrand).trim(),
            deviceMac: String(val.deviceMac || '').trim(),
            deviceId: String(val.deviceId || '').trim(),
            imei: String(val.imei || '').trim()
        };
    }
    config.userDeviceProtocols = cleanProtocols;
    config.userWxConfigs = pickUserWxConfigs(config.userWxConfigs);
    for (const field of ['userUis', 'userWxConfigs', 'announcementReadRecords']) Object.keys(config[field]).forEach(parseUserId);
}

function saveGlobalConfig(changes = {}) {
    ensureDataDir();
    const next = { ...globalConfig, ...changes };
    sanitizeGlobalConfigBeforeSave(next);
    configStorage.saveGlobal(next);
    Object.assign(globalConfig, next);
    accountDefaults = normalizeAccountConfig(next.defaultAccountConfig, DEFAULT_ACCOUNT_CONFIG);
}

function getAutomation(accountId) {
    const auto = { ...getAccountConfigSnapshot(accountId).automation };
    auto.fertilizer_land_types = normalizeFertilizerLandTypes(auto.fertilizer_land_types);
    return auto;
}

function getConfigSnapshot(accountId) {
    const cfg = getAccountConfigSnapshot(accountId);
    const auto = { ...cfg.automation };
    const owner = accountId ? getAccounts().accounts.find(account => account.id === String(accountId)) : null;
    const ui = owner ? getUI(owner.userId) : { theme: 'light' };
    return {
        automation: auto,
        autoCodeRefresh: { ...cfg.autoCodeRefresh },
        plantingStrategy: cfg.plantingStrategy,
        preferredSeedId: cfg.preferredSeedId,
        prioritize2x2Crops: cfg.prioritize2x2Crops === true,
        friendBadRetryDate: String(cfg.friendBadRetryDate || ''),
        intervals: { ...cfg.intervals },
        friendQuietHours: { ...cfg.friendQuietHours },
        knownFriendGids: [...cfg.knownFriendGids || []],
        friendBlacklist: [...cfg.friendBlacklist || []],
        plantBlacklist: [...cfg.plantBlacklist || []],
        stealDelaySeconds: Math.max(0, Math.min(60, Number(cfg.stealDelaySeconds) || 1)),
        plantOrderRandom: !!cfg.plantOrderRandom,
        plantDelaySeconds: Math.max(0, Math.min(60, Number(cfg.plantDelaySeconds) || 2)),
        fertilizerBuyOrganicCount: Math.max(0, Math.min(999, Number(cfg.fertilizerBuyOrganicCount) || 1)),
        fertilizerBuyOrganicThresholdHours: Math.max(0, Math.min(720, Number(cfg.fertilizerBuyOrganicThresholdHours) || 10)),
        fertilizerBuyNormalCount: Math.max(0, Math.min(999, Number(cfg.fertilizerBuyNormalCount) || 1)),
        fertilizerBuyNormalThresholdHours: Math.max(0, Math.min(720, Number(cfg.fertilizerBuyNormalThresholdHours) || 10)),
        fertilizerBuyCheckIntervalMinutes: Math.max(1, Math.min(1440, Number(cfg.fertilizerBuyCheckIntervalMinutes) || 60)),
        goldenBugKeepCount: Math.max(0, Math.min(9999, Number(cfg.goldenBugKeepCount) || 0)),
        goldenBugRoundLimit: Math.max(1, Math.min(100, Number(cfg.goldenBugRoundLimit) || 24)),
        friendHelpExpExhausted: cfg.friendHelpExpExhausted === true,
        mysteryAutoBuyCurrencies: [...cfg.mysteryAutoBuyCurrencies || []],
        ui
    };
}

function applyConfigSnapshot(patch = {}, opts = {}) {
    const persist = opts.persist !== false;
    const accountId = opts.accountId;
    const base = getAccountConfigSnapshot(accountId);
    const cfg = normalizeAccountConfig(base, accountDefaults);

    if (patch.automation && typeof patch.automation === 'object') {
        for (const [key, value] of Object.entries(patch.automation)) {
            if (cfg.automation[key] === undefined) continue;
            if (key === 'fertilizer') {
                const allowed = ['both', 'normal', 'organic', 'smart', 'smart_only', 'smart_normal', 'final_normal', 'final_organic', 'none'];
                cfg.automation[key] = allowed.includes(value) ? value : cfg.automation[key];
            } else if (key === 'fertilizer_land_types') {
                cfg.automation[key] = normalizeFertilizerLandTypes(value, cfg.automation[key]);
            } else if (key === 'fertilizer_smart_seconds') {
                cfg.automation[key] = Math.max(60, Math.min(7200, Number(value) || 300));
            } else if (typeof value === 'string') {
                // 字符串型自动化配置（如定时极速务农的 HH:mm）原样保留，避免被 !!value 强转成布尔
                cfg.automation[key] = value;
            } else {
                cfg.automation[key] = !!value;
            }
        }
    }

    if (patch.autoCodeRefresh && typeof patch.autoCodeRefresh === 'object') {
        cfg.autoCodeRefresh = {
            enabled: patch.autoCodeRefresh.enabled === true,
            intervalMinutes: Math.max(1, Math.min(1440, Number(patch.autoCodeRefresh.intervalMinutes) || 60))
        };
    }

    if (patch.plantingStrategy && ALLOWED_PLANTING_STRATEGIES.includes(patch.plantingStrategy)) {
        cfg.plantingStrategy = patch.plantingStrategy;
    }
    if (patch.preferredSeedId !== undefined && patch.preferredSeedId !== null) {
        cfg.preferredSeedId = Math.max(0, Number.parseInt(patch.preferredSeedId, 10) || 0);
    }
    if (patch.prioritize2x2Crops !== undefined && patch.prioritize2x2Crops !== null) {
        cfg.prioritize2x2Crops = patch.prioritize2x2Crops === true;
    }
    if (patch.friendBadRetryDate !== undefined && patch.friendBadRetryDate !== null) {
        const retryDate = String(patch.friendBadRetryDate || '');
        cfg.friendBadRetryDate = /^\d{4}-\d{2}-\d{2}$/.test(retryDate) ? retryDate : '';
    }
    if (patch.intervals && typeof patch.intervals === 'object') {
        for (const [key, val] of Object.entries(patch.intervals)) {
            if (cfg.intervals[key] === undefined) continue;
            cfg.intervals[key] = Math.max(1, Number.parseInt(val, 10) || cfg.intervals[key] || 1);
        }
        cfg.intervals = normalizeIntervals(cfg.intervals);
    }
    if (patch.friendQuietHours && typeof patch.friendQuietHours === 'object') {
        const prev = cfg.friendQuietHours || {};
        cfg.friendQuietHours = {
            enabled: patch.friendQuietHours.enabled !== undefined
                ? !!patch.friendQuietHours.enabled : !!prev.enabled,
            start: normalizeTimeString(patch.friendQuietHours.start, prev.start || '23:00'),
            end: normalizeTimeString(patch.friendQuietHours.end, prev.end || '07:00')
        };
    }
    if (Array.isArray(patch.friendBlacklist)) {
        cfg.friendBlacklist = normalizeFriendBlacklist(patch.friendBlacklist);
    }
    if (patch.knownFriendGids !== undefined) {
        cfg.knownFriendGids = normalizeKnownFriendGids(patch.knownFriendGids, cfg.knownFriendGids);
        if (accountId) writeKnownFriendGidsCache(accountId, cfg.knownFriendGids);
    }
    if (Array.isArray(patch.plantBlacklist)) {
        cfg.plantBlacklist = patch.plantBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0);
    }
    if (patch.stealDelaySeconds !== undefined && patch.stealDelaySeconds !== null) {
        cfg.stealDelaySeconds = Math.max(0, Math.min(60, Number(patch.stealDelaySeconds) || 1));
    }
    if (patch.plantOrderRandom !== undefined && patch.plantOrderRandom !== null) {
        cfg.plantOrderRandom = !!patch.plantOrderRandom;
    }
    if (patch.plantDelaySeconds !== undefined && patch.plantDelaySeconds !== null) {
        cfg.plantDelaySeconds = Math.max(0, Math.min(60, Number(patch.plantDelaySeconds) || 2));
    }
    if (patch.fertilizerBuyOrganicCount !== undefined && patch.fertilizerBuyOrganicCount !== null) {
        cfg.fertilizerBuyOrganicCount = Math.max(0, Math.min(999, Number(patch.fertilizerBuyOrganicCount) || 1));
    }
    if (patch.fertilizerBuyOrganicThresholdHours !== undefined && patch.fertilizerBuyOrganicThresholdHours !== null) {
        cfg.fertilizerBuyOrganicThresholdHours = Math.max(0, Math.min(720, Number(patch.fertilizerBuyOrganicThresholdHours) || 10));
    }
    if (patch.fertilizerBuyNormalCount !== undefined && patch.fertilizerBuyNormalCount !== null) {
        cfg.fertilizerBuyNormalCount = Math.max(0, Math.min(999, Number(patch.fertilizerBuyNormalCount) || 1));
    }
    if (patch.fertilizerBuyNormalThresholdHours !== undefined && patch.fertilizerBuyNormalThresholdHours !== null) {
        cfg.fertilizerBuyNormalThresholdHours = Math.max(0, Math.min(720, Number(patch.fertilizerBuyNormalThresholdHours) || 10));
    }
    if (patch.fertilizerBuyCheckIntervalMinutes !== undefined && patch.fertilizerBuyCheckIntervalMinutes !== null) {
        cfg.fertilizerBuyCheckIntervalMinutes = Math.max(1, Math.min(1440, Number(patch.fertilizerBuyCheckIntervalMinutes) || 60));
    }
    if (Array.isArray(patch.mysteryAutoBuyCurrencies)) {
        const ALLOWED_MYSTERY_CURRENCIES = [1001, 1002, 1003, 1005];
        cfg.mysteryAutoBuyCurrencies = patch.mysteryAutoBuyCurrencies
            .map(n => Number(n))
            .filter(n => ALLOWED_MYSTERY_CURRENCIES.includes(n));
    }
    if (patch.autoAcceptFriendMinLevel !== undefined && patch.autoAcceptFriendMinLevel !== null) {
        cfg.autoAcceptFriendMinLevel = Math.max(0, Math.min(200, Number(patch.autoAcceptFriendMinLevel) || 0));
    }
    if (patch.goldenBugKeepCount !== undefined && patch.goldenBugKeepCount !== null) {
        cfg.goldenBugKeepCount = Math.max(0, Math.min(9999, Number(patch.goldenBugKeepCount) || 0));
    }
    if (patch.goldenBugRoundLimit !== undefined && patch.goldenBugRoundLimit !== null) {
        cfg.goldenBugRoundLimit = Math.max(1, Math.min(100, Number(patch.goldenBugRoundLimit) || 24));
    }
    if (patch.friendHelpExpExhausted !== undefined) {
        cfg.friendHelpExpExhausted = patch.friendHelpExpExhausted === true;
    }
    if (patch.bagSeedPriority !== undefined && patch.bagSeedPriority !== null) {
        cfg.bagSeedPriority = normalizeBagSeedPriority(patch.bagSeedPriority);
    }
    if (patch.bagSeedFallbackStrategy !== undefined && patch.bagSeedFallbackStrategy !== null) {
        cfg.bagSeedFallbackStrategy = normalizeBagSeedFallbackStrategy(patch.bagSeedFallbackStrategy);
    }
    if (patch.bagPriorityLandTypes !== undefined && patch.bagPriorityLandTypes !== null) {
        cfg.bagPriorityLandTypes = normalizeBagPriorityLandTypes(patch.bagPriorityLandTypes);
    }
    setAccountConfigSnapshot(accountId, cfg, persist);

    return getConfigSnapshot(accountId);
}

function setAutomation(key, value, accountId) {
    const patch = { automation: { [key]: value } };
    if (key === 'friend_bad' && value === true) {
        patch.friendBadRetryDate = '';
    }
    return applyConfigSnapshot(patch, { accountId });
}

function getAutoCodeRefresh(accountId) {
    const cfg = getAccountConfigSnapshot(accountId).autoCodeRefresh || DEFAULT_ACCOUNT_CONFIG.autoCodeRefresh;
    return {
        enabled: cfg.enabled === true,
        intervalMinutes: Math.max(1, Math.min(1440, Number(cfg.intervalMinutes) || 60))
    };
}

function setAutoCodeRefresh(accountId, config) {
    const data = config && typeof config === 'object' ? config : {};
    const result = applyConfigSnapshot({
        autoCodeRefresh: {
            enabled: data.enabled === true,
            intervalMinutes: data.intervalMinutes
        }
    }, { accountId });
    return result.autoCodeRefresh;
}

function isAutomationOn(key, accountId) {
    return !!getAccountConfigSnapshot(accountId).automation[key];
}

function getPreferredSeed(accountId) {
    return getAccountConfigSnapshot(accountId).preferredSeedId;
}

function getPlantingStrategy(accountId) {
    return getAccountConfigSnapshot(accountId).plantingStrategy;
}

function getPrioritize2x2Crops(accountId) {
    return getAccountConfigSnapshot(accountId).prioritize2x2Crops === true;
}

function getFriendBadRetryDate(accountId) {
    return String(getAccountConfigSnapshot(accountId).friendBadRetryDate || '');
}

function getBagSeedPriority(accountId) {
    return [...getAccountConfigSnapshot(accountId).bagSeedPriority || []];
}

function getBagSeedFallbackStrategy(accountId) {
    return normalizeBagSeedFallbackStrategy(getAccountConfigSnapshot(accountId).bagSeedFallbackStrategy);
}

function getBagPriorityLandTypes(accountId) {
    return normalizeBagPriorityLandTypes(getAccountConfigSnapshot(accountId).bagPriorityLandTypes);
}

function getIntervals(accountId) {
    return { ...getAccountConfigSnapshot(accountId).intervals };
}

function getFriendQuietHours(accountId) {
    return { ...getAccountConfigSnapshot(accountId).friendQuietHours };
}

function getKnownFriendGids(accountId) {
    const cfg = getAccountConfigSnapshot(accountId);
    const gids = cfg.knownFriendGids || [];
    if (gids.length > 0) return [...gids];
    const cached = readKnownFriendGidsCache(accountId);
    if (cached && cached.length > 0) return [...cached];
    return [];
}

function setKnownFriendGids(accountId, gids) {
    const base = getAccountConfigSnapshot(accountId);
    const cfg = normalizeAccountConfig(base, accountDefaults);
    const normalized = normalizeKnownFriendGids(gids, cfg.knownFriendGids);
    cfg.knownFriendGids = normalized;
    setAccountConfigSnapshot(accountId, cfg);
    writeKnownFriendGidsCache(accountId, normalized);
    return [...normalized];
}

function normalizeFriendBlacklist(raw) {
    if (!Array.isArray(raw))
        return [];
    const seen = new Set();
    const out = [];
    for (const item of raw) {
        let gid;
        let skipSteal = true;
        let skipHelp = true;
        if (typeof item === 'number' || typeof item === 'string') {
            gid = Number(item);
        }
        else if (item && typeof item === 'object') {
            gid = Number(item.gid);
            if (typeof item.skipSteal === 'boolean')
                skipSteal = item.skipSteal;
            if (typeof item.skipHelp === 'boolean')
                skipHelp = item.skipHelp;
        }
        else {
            continue;
        }
        if (!gid || gid <= 0 || seen.has(gid))
            continue;
        seen.add(gid);
        out.push({ gid, skipSteal, skipHelp });
    }
    return out;
}

// 黑名单（精细化跳过）：返回纯 gid 数组，供既有逻辑用 Set.has(gid) 快速排除。
function getFriendBlacklist(accountId) {
    return normalizeFriendBlacklist(getAccountConfigSnapshot(accountId).friendBlacklist).map(w => w.gid);
}

// 黑名单明细：返回 [{ gid, skipSteal, skipHelp }]，供偷菜/帮忙精细化跳过判断。
function getFriendBlacklistDetails(accountId) {
    return normalizeFriendBlacklist(getAccountConfigSnapshot(accountId).friendBlacklist);
}

function setFriendBlacklist(accountId, list) {
    const base = getAccountConfigSnapshot(accountId);
    const cfg = normalizeAccountConfig(base, accountDefaults);
    cfg.friendBlacklist = normalizeFriendBlacklist(list);
    setAccountConfigSnapshot(accountId, cfg);
    return getFriendBlacklistDetails(accountId);
}

function addFriendToBlacklist(accountId, gid, skipSteal = true, skipHelp = true) {
    const targetGid = Number(gid);
    if (!targetGid || targetGid <= 0)
        return false;
    const list = getFriendBlacklistDetails(accountId);
    if (list.some(w => w.gid === targetGid))
        return false;
    setFriendBlacklist(accountId, [...list, { gid: targetGid, skipSteal: !!skipSteal, skipHelp: !!skipHelp }]);
    return true;
}

function removeFriendFromBlacklist(accountId, gid) {
    const targetGid = Number(gid);
    if (!targetGid || targetGid <= 0)
        return false;
    const list = getFriendBlacklistDetails(accountId);
    if (!list.some(w => w.gid === targetGid))
        return false;
    setFriendBlacklist(accountId, list.filter(w => w.gid !== targetGid));
    return true;
}

function updateBlacklistItem(accountId, gid, opts) {
    const targetGid = Number(gid);
    if (!targetGid || targetGid <= 0)
        return false;
    if (!opts || typeof opts !== 'object')
        return false;
    const list = getFriendBlacklistDetails(accountId);
    const idx = list.findIndex(w => w.gid === targetGid);
    if (idx < 0)
        return false;
    if (typeof opts.skipSteal === 'boolean')
        list[idx].skipSteal = opts.skipSteal;
    if (typeof opts.skipHelp === 'boolean')
        list[idx].skipHelp = opts.skipHelp;
    setFriendBlacklist(accountId, list);
    return true;
}

function getStealDelaySeconds(accountId) {
    return Math.max(0, Math.min(60, Number(getAccountConfigSnapshot(accountId).stealDelaySeconds) || 1));
}

function getPlantOrderRandom(accountId) {
    return !!getAccountConfigSnapshot(accountId).plantOrderRandom;
}

function getPlantDelaySeconds(accountId) {
    return Math.max(0, Math.min(60, Number(getAccountConfigSnapshot(accountId).plantDelaySeconds) || 2));
}

function getAutoAcceptFriendMinLevel(accountId) {
    return Math.max(0, Math.min(200, Number(getAccountConfigSnapshot(accountId).autoAcceptFriendMinLevel) || 0));
}

function getFertilizerBuyOrganicCount(accountId) {
    return Math.max(0, Math.min(999, Number(getAccountConfigSnapshot(accountId).fertilizerBuyOrganicCount) || 1));
}

function getFertilizerBuyOrganicThresholdHours(accountId) {
    return Math.max(0, Math.min(720, Number(getAccountConfigSnapshot(accountId).fertilizerBuyOrganicThresholdHours) || 10));
}

function getFertilizerBuyNormalCount(accountId) {
    return Math.max(0, Math.min(999, Number(getAccountConfigSnapshot(accountId).fertilizerBuyNormalCount) || 1));
}

function getFertilizerBuyNormalThresholdHours(accountId) {
    return Math.max(0, Math.min(720, Number(getAccountConfigSnapshot(accountId).fertilizerBuyNormalThresholdHours) || 10));
}

function getFertilizerBuyCheckIntervalMinutes(accountId) {
    return Math.max(1, Math.min(1440, Number(getAccountConfigSnapshot(accountId).fertilizerBuyCheckIntervalMinutes) || 60));
}

function isMysteryAutoBuyOn(accountId) {
    return !!getAccountConfigSnapshot(accountId).automation.mystery_auto_buy;
}

function getMysteryAutoBuyCurrencies(accountId) {
    const snapshot = getAccountConfigSnapshot(accountId);
    return Array.isArray(snapshot.mysteryAutoBuyCurrencies) ? [...snapshot.mysteryAutoBuyCurrencies] : [];
}

function getPlantBlacklist(accountId) {
    return [...getAccountConfigSnapshot(accountId).plantBlacklist || []];
}

function setPlantBlacklist(accountId, blacklist) {
    const base = getAccountConfigSnapshot(accountId);
    const cfg = normalizeAccountConfig(base, accountDefaults);
    cfg.plantBlacklist = Array.isArray(blacklist)
        ? blacklist.map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
    setAccountConfigSnapshot(accountId, cfg);
    return [...cfg.plantBlacklist];
}

function getUI(userId) {
    assertUserId(userId);
    return { theme: globalConfig.userUis[userId]?.theme ?? 'light' };
}

function setUITheme(theme, userId) {
    assertUserId(userId);
    if (!['light', 'dark'].includes(theme)) throw new Error('无效的主题');
    saveGlobalConfig({ userUis: { ...globalConfig.userUis, [userId]: { theme } } });
    return { ui: getUI(userId) };
}

function getOfflineReminder(userId) {
    assertUserId(userId);
    const userReminder = globalConfig.userOfflineReminders && globalConfig.userOfflineReminders[userId];
    if (userReminder) return normalizeOfflineReminder(userReminder);
    return normalizeOfflineReminder({});
}

function setOfflineReminder(config, userId) {
    assertUserId(userId);
    const current = normalizeOfflineReminder(globalConfig.userOfflineReminders?.[userId] || {});
    saveGlobalConfig({ userOfflineReminders: {
        ...globalConfig.userOfflineReminders,
        [userId]: normalizeOfflineReminder({ ...current, ...config || {} })
    } });
    return getOfflineReminder(userId);
}

function deleteUserOfflineReminder(userId) {
    assertUserId(userId);
    if (globalConfig.userOfflineReminders && globalConfig.userOfflineReminders[userId]) {
        const next = { ...globalConfig.userOfflineReminders };
        delete next[userId];
        saveGlobalConfig({ userOfflineReminders: next });
    }
}


// ==================== 账号管理 ====================

let accountsCache = null;

function cloneAccounts(data) {
    return JSON.parse(JSON.stringify(data));
}

function loadAccounts() {
    ensureDataDir();
    const data = readJsonFileStrict(ACCOUNTS_FILE, () => ({ schemaVersion: 3, accounts: [], nextId: 1 }));
    try { accountsCache = normalizeAccountsData(data); }
    catch (error) { throw storageError('读取', ACCOUNTS_FILE, error); }
    return cloneAccounts(accountsCache);
}

function saveAccounts(data) {
    ensureDataDir();
    const next = normalizeAccountsData(data);
    try { writeJsonFileAtomic(ACCOUNTS_FILE, next); }
    catch (error) { throw storageError('保存', ACCOUNTS_FILE, error); }
    accountsCache = cloneAccounts(next);
}

function getAccounts() {
    return accountsCache ? cloneAccounts(accountsCache) : loadAccounts();
}

function normalizeAccountsData(data) {
    if (data?.schemaVersion !== 3 || !Array.isArray(data.accounts) || !Number.isSafeInteger(data.nextId)) throw new Error('Invalid accounts document');
    const ids = new Set();
    for (const account of data.accounts) {
        if (!account || typeof account.id !== 'string' || !/^[1-9]\d*$/.test(account.id)
            || !Number.isSafeInteger(Number(account.id)) || ids.has(account.id)
            || !isUserId(account.userId) || Object.hasOwn(account, 'username')
            || typeof account.autoStart !== 'boolean') throw new Error('Invalid account identity');
        ids.add(account.id);
    }
    const maxId = data.accounts.reduce((max, account) => Math.max(max, Number(account.id)), 0);
    if (data.nextId <= maxId) throw new Error('Invalid next account ID');
    return cloneAccounts(data);
}

// 第三方应用宝配置脱敏哨兵：API 响应中 token 被替换为该值，
// 更新时若传入该值（或空），则沿用已存储的真实 token，避免被误清空。
const THIRDPARTY_TOKEN_MASK = "***";
function isThirdpartyTokenKeep(value) {
    return !value || value === THIRDPARTY_TOKEN_MASK || value === "__KEEP__";
}

/**
 * 规范化第三方应用宝配置对象。
 * @param {object} input 入站 thirdparty 配置
 * @param {object|null} existing 已存储的 thirdparty 配置（更新时用于保留原 token）
 */
function sanitizeThirdparty(input, existing) {
    if (input === null) return null;
    if (!input || typeof input !== "object") return existing || null;
    const apiToken = input.apiToken;
    const keep = isThirdpartyTokenKeep(apiToken);
    // 账号级离线重连配置：undefined 表示“不修改”（更新时保留原值），否则用传入值或默认。
    const autoReconnect = input.autoReconnect === undefined
        ? (existing && existing.autoReconnect !== undefined ? existing.autoReconnect : true)
        : input.autoReconnect === true;
    const reconnectDelayMin = input.reconnectDelayMin === undefined || input.reconnectDelayMin === null || input.reconnectDelayMin === ''
        ? (existing && existing.reconnectDelayMin !== undefined ? existing.reconnectDelayMin : 5)
        : Math.max(1, Number(input.reconnectDelayMin) || 5);
    const reconnectMaxAttempts = input.reconnectMaxAttempts === undefined || input.reconnectMaxAttempts === null || input.reconnectMaxAttempts === ''
        ? (existing && existing.reconnectMaxAttempts !== undefined ? existing.reconnectMaxAttempts : 3)
        : Math.max(1, Number(input.reconnectMaxAttempts) || 3);
    return {
        apiBase: String(input.apiBase || "").trim(),
        apiToken: keep
            ? (existing && existing.apiToken ? existing.apiToken : "")
            : String(apiToken).trim(),
        openid: String(input.openid || "").trim(),
        autoReconnect,
        reconnectDelayMin,
        reconnectMaxAttempts,
    };
}

function addOrUpdateAccount(account) {
    if (Object.hasOwn(account, 'username')) throw new Error('账号仅接受 userId 归属');
    for (const field of ['autoStart', 'qqAutoReconnect']) {
        if (Object.hasOwn(account, field) && typeof account[field] !== 'boolean') throw Object.assign(new Error(`${field} 必须是布尔值`), { status: 400 });
    }
    const data = getAccounts();
    const previous = account.id ? data.accounts.find(item => item.id === account.id) : null;
    if (account.id) {
        const existing = data.accounts.find(item => item.id === account.id);
        if (!existing) throw new Error('账号不存在');
        if (existing.deleting) throw Object.assign(new Error('账号正在删除，禁止修改'), { status: 409 });
        if (account.userId !== undefined && account.userId !== existing.userId) throw new Error('账号用户 ID 创建后不可修改');
    } else { assertUserId(account.userId); }
    if (!account.id || Object.hasOwn(account, 'proxyMode') || Object.hasOwn(account, 'proxyProfileId')) {
        const setting = {
            proxyMode: account.proxyMode === undefined ? previous?.proxyMode ?? 'direct' : account.proxyMode,
            proxyProfileId: account.proxyProfileId === undefined ? previous?.proxyProfileId : account.proxyProfileId,
        };
        if (!['direct', 'static'].includes(setting.proxyMode)) throw Object.assign(new Error('请选择有效的代理模式'), { status: 400 });
        const id = Number(setting.proxyProfileId);
        if (setting.proxyMode === 'static' && (!Number.isSafeInteger(id) || id <= 0)) throw Object.assign(new Error('请选择有效的代理配置'), { status: 400 });
        account = { ...account, proxyMode: setting.proxyMode, proxyProfileId: setting.proxyMode === 'static' ? id : null };
    }
    let accountId = '';
    let created = false;
    const nextAvatar = account.avatar;
    const nextOpenId = account.openId;

    if (account.id) {
        // 更新已有账号
        const idx = data.accounts.findIndex(a => a.id === account.id);
        if (idx >= 0) {
            const mergedThirdparty = account.thirdparty !== undefined
                ? (account.thirdparty === null
                    ? null
                    : sanitizeThirdparty(account.thirdparty, data.accounts[idx].thirdparty))
                : data.accounts[idx].thirdparty;
            data.accounts[idx] = {
                ...data.accounts[idx],
                ...account,
                name: account.name !== undefined ? account.name : data.accounts[idx].name,
                ...(nextAvatar !== undefined ? { avatar: nextAvatar } : {}),
                ...(nextOpenId !== undefined ? { openId: nextOpenId } : {}),
                ...(account.provider === 'thirdparty' || account.provider === 'builtin'
                    ? { provider: account.provider }
                    : {}),
                thirdparty: mergedThirdparty,
                updatedAt: Date.now()
            };
            accountId = String(data.accounts[idx].id || '');
        }
    } else {
        // 新建账号
        created = true;
        const id = data.nextId++;
        accountId = String(id);
        data.accounts.push({
            id: accountId,
            name: account.name || `账号${  id}`,
            code: account.code || '',
            platform: account.platform || 'qq',
            loginType: account.loginType || 'manual',
            proxyMode: account.proxyMode === 'static' ? 'static' : 'direct',
            proxyProfileId: account.proxyMode === 'static' ? Number(account.proxyProfileId) : null,
            provider: account.provider === 'thirdparty' ? 'thirdparty' : 'builtin',
            thirdparty: account.provider === 'thirdparty' && account.thirdparty
                ? sanitizeThirdparty(account.thirdparty, null)
                : null,
            wxid: account.wxid ? String(account.wxid) : '',
            uin: account.uin ? String(account.uin) : '',
            qq: account.qq ? String(account.qq) : (account.uin ? String(account.uin) : ''),
            gid: account.gid ? String(account.gid) : '',
            openId: nextOpenId ? String(nextOpenId) : '',
            avatar: nextAvatar || '',
            userId: assertUserId(account.userId),
            yybOpenid: account.yybOpenid ? String(account.yybOpenid) : '',
            qqLoginProfile: account.qqLoginProfile || '',
            qqAutoReconnect: account.qqAutoReconnect !== false,
            autoStart: account.autoStart !== false,
            createdAt: Date.now(),
            updatedAt: Date.now()
        });
    }

    if (accountId) {
        const userId = assertUserId(data.accounts.find(item => item.id === accountId).userId);
        const plan = created && userId ? globalConfig.userDefaultAccountPlans[userId] : null;
        if (plan && plan.enabled !== false) {
            setAccountConfigSnapshot(accountId, plan.config);
        } else {
            ensureAccountConfig(accountId);
        }
    }
    saveAccounts(data);
    return data;
}

function removeAccountArtifacts(accountId) {
    removeAccountConfig(accountId);
    deleteAccountCaches(accountId);
    const digest = require('node:crypto').createHash('sha256').update(String(accountId)).digest('hex');
    for (const file of [getDataFile(`stats/${accountId}.json`), getDataFile(`activity-center-state-${digest}.json`)]) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
    }
}

function beginAccountDeletion(accountId) {
    const data = getAccounts();
    const account = data.accounts.find(item => item.id === String(accountId));
    if (!account) throw Object.assign(new Error('账号不存在'), { status: 404 });
    if (!account.deleting) {
        account.deleting = true;
        account.autoStart = false;
        saveAccounts(data);
    }
    return { ...account };
}

function deleteAccount(accountId) {
    const data = getAccounts();
    removeAccountArtifacts(String(accountId));
    data.accounts = data.accounts.filter(a => a.id !== String(accountId));
    saveAccounts(data);
    return data;
}

function getAccountsByUser(userId) {
    assertUserId(userId);
    const data = getAccounts();
    return { accounts: data.accounts.filter(a => a.userId === userId), nextId: data.nextId };
}

function deleteAccountsByUser(userId) {
    assertUserId(userId);
    const data = getAccounts();
    const deletedIds = data.accounts.filter(a => a.userId === userId).map(a => a.id);
    for (const id of deletedIds) removeAccountArtifacts(id);
    data.accounts = data.accounts.filter(a => a.userId !== userId);
    saveAccounts(data);
    return { deletedCount: deletedIds.length, deletedIds };
}

function deleteUserConfig(userId) {
    assertUserId(userId);
    const userUis = { ...globalConfig.userUis }; delete userUis[userId];
    const userWxConfigs = { ...globalConfig.userWxConfigs }; delete userWxConfigs[userId];
    saveGlobalConfig({ userUis, userWxConfigs });
    const reads = { ...globalConfig.announcementReadRecords };
    delete reads[userId];
    saveGlobalConfig({ announcementReadRecords: reads });
    deleteUserOfflineReminder(userId);
    deleteUserDeviceProtocol(userId);
    if (globalConfig.userDefaultAccountPlans && globalConfig.userDefaultAccountPlans[userId]) {
        const next = { ...globalConfig.userDefaultAccountPlans };
        delete next[userId];
        saveGlobalConfig({ userDefaultAccountPlans: next });
    }
}

function getUserDefaultAccountPlan(userId) {
    const key = String(assertUserId(userId));
    const saved = key ? globalConfig.userDefaultAccountPlans[key] : null;
    if (!saved) {
        return {
            exists: false,
            enabled: true,
            config: pickDefaultPlanConfig(DEFAULT_ACCOUNT_CONFIG),
            updatedAt: 0
        };
    }
    const plan = normalizeUserDefaultPlan(saved);
    return { exists: true, ...plan };
}

function setUserDefaultAccountPlan(userId, rawConfig, options = {}) {
    const key = String(assertUserId(userId));
    if (!key) throw new Error('Missing userId');
    const plan = {
        enabled: options.enabled !== false,
        config: pickDefaultPlanConfig(rawConfig),
        updatedAt: Date.now()
    };
    saveGlobalConfig({ userDefaultAccountPlans: { ...globalConfig.userDefaultAccountPlans, [key]: plan } });
    return { exists: true, ...normalizeUserDefaultPlan(plan) };
}

function applyUserDefaultAccountPlan(userId, accountId) {
    if (!getAccountsByUser(userId).accounts.some(account => account.id === String(accountId))) throw new Error('账号不属于该用户');
    const plan = getUserDefaultAccountPlan(userId);
    if (!plan.exists) throw new Error('尚未保存默认方案');
    setAccountConfigSnapshot(accountId, plan.config);
    return getConfigSnapshot(accountId);
}

function getDefaultAccountConfig() {
    return cloneAccountConfig(DEFAULT_ACCOUNT_CONFIG);
}

// ==================== 公告管理 ====================

function getAnnouncement() {
    return {
        enabled: globalConfig.announcement?.enabled === true,
        title: globalConfig.announcement?.title || '系统公告',
        content: globalConfig.announcement?.content || '',
        showOnce: globalConfig.announcement?.showOnce ?? true,
        updatedAt: globalConfig.announcement?.updatedAt || 0
    };
}

function setAnnouncement(content, showOnce = true, options = {}) {
    const previous = getAnnouncement();
    const next = {
        enabled: options.enabled === undefined ? previous.enabled : options.enabled === true,
        title: String(options.title ?? previous.title).trim() || '系统公告',
        content: String(content || '').trim(),
        showOnce: !!showOnce,
        updatedAt: previous.updatedAt
    };
    if (next.enabled !== previous.enabled || next.title !== previous.title
        || next.content !== previous.content || next.showOnce !== previous.showOnce) {
        next.updatedAt = Math.max(Date.now(), previous.updatedAt + 1);
    }
    saveGlobalConfig({ announcement: next });
    return getAnnouncement();
}

function getAnnouncementReadRecord(userId) {
    assertUserId(userId);
    return globalConfig.announcementReadRecords?.[userId] || 0;
}

function markAnnouncementRead(userId, revision = getAnnouncement().updatedAt) {
    assertUserId(userId);
    const announcement = getAnnouncement();
    if (!announcement.enabled || Number(revision) !== announcement.updatedAt) return;
    saveGlobalConfig({ announcementReadRecords: { ...globalConfig.announcementReadRecords, [userId]: announcement.updatedAt } });
}

function shouldShowAnnouncement(userId) {
    const announcement = getAnnouncement();
    if (!announcement.enabled || !announcement.content) return false;
    assertUserId(userId);
    if (!announcement.showOnce) return true;
    return getAnnouncementReadRecord(userId) < announcement.updatedAt;
}

// ==================== 系统配置 ====================

function getSystemConfig() {
    return globalConfig.systemConfig ? { ...globalConfig.systemConfig } : null;
}

function validateSystemConfig(config) {
    if (!config || typeof config !== 'object' || ['serverUrl', 'clientVersion', 'wxClientVersion', 'platform', 'os'].some(key => typeof config[key] !== 'string' || !config[key].trim())) throw new Error('系统配置字段必须完整');
    const url = new URL(config.serverUrl);
    if (!['ws:', 'wss:'].includes(url.protocol) || !['qq', 'wx'].includes(config.platform)) throw new Error('系统配置格式无效');
}
function setSystemConfig(config) {
    validateSystemConfig(config);
    const next = Object.fromEntries(['serverUrl', 'clientVersion', 'wxClientVersion', 'platform', 'os'].map(key => [key, config[key].trim()]));
    saveGlobalConfig({ systemConfig: next });
    return { ...globalConfig.systemConfig };
}

// ==================== 登录页链接 ====================

function getLoginLinks() {
    return { ...DEFAULT_LOGIN_LINKS, ...globalConfig.loginLinks || {} };
}

function setLoginLinks(config) {
    const current = getLoginLinks();
    const next = {
        logoUrl: String(config?.logoUrl ?? current.logoUrl).trim(),
        title: String(config?.title || DEFAULT_LOGIN_LINKS.title).trim(),
        loginSubtitle: String(config?.loginSubtitle || DEFAULT_LOGIN_LINKS.loginSubtitle).trim(),
        registerSubtitle: String(config?.registerSubtitle || DEFAULT_LOGIN_LINKS.registerSubtitle).trim(),
        purchaseUrl: String(config?.purchaseUrl ?? current.purchaseUrl).trim(),
        qqGroupUrl: String(config?.qqGroupUrl ?? current.qqGroupUrl).trim()
    };
    saveGlobalConfig({ loginLinks: next });
    return { ...globalConfig.loginLinks };
}

// ==================== 微信配置 ====================

const DEFAULT_WX_CONFIG = {
    enabled: false,
    apiBase: 'https://code.z74d.top/api',
    apiKey: '',
    proxyApiUrl: 'https://code.z74d.top/api',
    appId: 'wx5306c5978fdb76e4',

    // 【2026-08-12 修复】内置 YYB 自动重连默认为开（原 false 导致多数用户从未触发重连，
    // 表现为"老是没重连"）。第三方 YYB 账号级默认本就是 true，二者对齐。
    autoReconnect: true,
    reconnectDelayMin: 5,
    reconnectMaxAttempts: 3
};

function pickUserWxConfigs(configs = {}) {
    return Object.fromEntries(Object.entries(configs).map(([id, config]) => [
        id, Object.fromEntries(Object.entries(config).filter(([key]) => Object.hasOwn(DEFAULT_WX_CONFIG, key))),
    ]));
}

function getUserWxConfig(userId) {
    assertUserId(userId);
    return { ...DEFAULT_WX_CONFIG, ...globalConfig.userWxConfigs[userId] };
}

function setUserWxConfig(config, userId) {
    assertUserId(userId);
    if (!config || typeof config !== 'object') throw new Error('无效的微信配置');
    const next = {
        enabled: config.enabled !== false,
        apiBase: String(config.apiBase ?? DEFAULT_WX_CONFIG.apiBase).trim(),
        apiKey: String(config.apiKey ?? '').trim(),
        proxyApiUrl: String(config.proxyApiUrl ?? DEFAULT_WX_CONFIG.proxyApiUrl).trim(),
        appId: String(config.appId ?? DEFAULT_WX_CONFIG.appId).trim(),
        autoReconnect: config.autoReconnect !== false,
        reconnectDelayMin: Number(config.reconnectDelayMin ?? 5),
        reconnectMaxAttempts: Number(config.reconnectMaxAttempts ?? 3),
    };
    if (!Number.isFinite(next.reconnectDelayMin) || next.reconnectDelayMin <= 0 || !Number.isSafeInteger(next.reconnectMaxAttempts) || next.reconnectMaxAttempts < 0) throw new Error('无效的重连设置');
    saveGlobalConfig({ userWxConfigs: { ...globalConfig.userWxConfigs, [userId]: next } });
    return getUserWxConfig(userId);
}

// ==================== 设备协议 ====================

const DEFAULT_DEVICE_PROTOCOL = {
    enabled: false,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13)',
    deviceModel: 'iPhone 15 Pro Max',
    deviceBrand: 'Apple',
    deviceMac: '',
    deviceId: '',
    imei: ''
};

function getUserDeviceProtocol(userId) {
    assertUserId(userId);
    const userProtocol = globalConfig.userDeviceProtocols && globalConfig.userDeviceProtocols[userId];
    if (userProtocol) return { ...userProtocol };
    return { ...DEFAULT_DEVICE_PROTOCOL };
}

function setUserDeviceProtocol(config, userId) {
    assertUserId(userId);
    const next = {
        enabled: config.enabled === true,
        userAgent: String(config.userAgent || DEFAULT_DEVICE_PROTOCOL.userAgent).trim(),
        deviceModel: String(config.deviceModel || DEFAULT_DEVICE_PROTOCOL.deviceModel).trim(),
        deviceBrand: String(config.deviceBrand || DEFAULT_DEVICE_PROTOCOL.deviceBrand).trim(),
        deviceMac: String(config.deviceMac || '').trim(),
        deviceId: String(config.deviceId || '').trim(),
        imei: String(config.imei || '').trim()
    };
    saveGlobalConfig({ userDeviceProtocols: { ...globalConfig.userDeviceProtocols, [userId]: next } });
    return getUserDeviceProtocol(userId);
}

function deleteUserDeviceProtocol(userId) {
    assertUserId(userId);
    if (globalConfig.userDeviceProtocols && globalConfig.userDeviceProtocols[userId]) {
        const next = { ...globalConfig.userDeviceProtocols };
        delete next[userId];
        saveGlobalConfig({ userDeviceProtocols: next });
    }
}

loadGlobalConfig();

// ==================== 模块导出 ====================

module.exports = {
    getConfigSnapshot,
    applyConfigSnapshot,
    getAutomation,
    setAutomation,
    getAutoCodeRefresh,
    setAutoCodeRefresh,
    isAutomationOn,
    getPreferredSeed,
    getPlantingStrategy,
    getPrioritize2x2Crops,
    getFriendBadRetryDate,
    getBagSeedPriority,
    getBagSeedFallbackStrategy,
    getBagPriorityLandTypes,
    getIntervals,
    getFriendQuietHours,
    getKnownFriendGids,
    setKnownFriendGids,
    getFriendBlacklist,
    getFriendBlacklistDetails,
    setFriendBlacklist,
    addFriendToBlacklist,
    removeFriendFromBlacklist,
    updateBlacklistItem,
    getStealDelaySeconds,
    getPlantOrderRandom,
    getPlantDelaySeconds,
    getAutoAcceptFriendMinLevel,
    getFertilizerBuyOrganicCount,
    getFertilizerBuyOrganicThresholdHours,
    getFertilizerBuyNormalCount,
    getFertilizerBuyNormalThresholdHours,
    getFertilizerBuyCheckIntervalMinutes,
    isMysteryAutoBuyOn,
    getMysteryAutoBuyCurrencies,
    getUI,
    setUITheme,
    getOfflineReminder,
    setOfflineReminder,
    deleteUserOfflineReminder,
    getAccounts,
    loadAccounts,
    addOrUpdateAccount,
    beginAccountDeletion,
    deleteAccount,
    getAccountsByUser,
    deleteAccountsByUser,
    deleteUserConfig,
    getUserDefaultAccountPlan,
    setUserDefaultAccountPlan,
    applyUserDefaultAccountPlan,
    getPlantBlacklist,
    setPlantBlacklist,
    getDefaultAccountConfig,
    getAnnouncement,
    setAnnouncement,
    getAnnouncementReadRecord,
    markAnnouncementRead,
    shouldShowAnnouncement,
    getSystemConfig,
    setSystemConfig,
    getLoginLinks,
    setLoginLinks,
    DEFAULT_LOGIN_LINKS,
    getUserWxConfig,
    setUserWxConfig,
    DEFAULT_WX_CONFIG,
    DEFAULT_DEVICE_PROTOCOL,
    getUserDeviceProtocol,
    setUserDeviceProtocol,
    deleteUserDeviceProtocol,
    readFriendDogInfoCache,
    writeFriendDogInfoCache,
    readFriendListCache,
    writeFriendListCache,
    getFriendListCacheFile,
    removeFriendFromCache
};
