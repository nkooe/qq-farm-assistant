const fs = require('fs');
const path = require('path');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const crypto = require('crypto');
const { getAccessPolicy, getUserAccessRejection } = require('./access-policy');
const { readJsonFileStrict, writeJsonFileAtomic, storageError } = require('../services/json-db');
const { ADMIN_USER_ID, assertUserId, isUserIdentity } = require('./user-id');
const { createIdentityTransaction } = require('../services/identity-transaction');
const USER_SCHEMA_VERSION = 3;

// ==================== 文件路径 ====================

const USERS_FILE = getDataFile('users.json');
const CARDS_FILE = getDataFile('cards.json');
const LOGIN_ATTEMPTS_FILE = getDataFile('login-attempts.json');
const CARD_CLAIM_FILE = getDataFile('card-claim.json');
const identityTransaction = createIdentityTransaction(path.dirname(USERS_FILE));
identityTransaction.recover();

// ==================== 常量 ====================

const DEFAULT_ACCOUNT_LIMIT = 2;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// 卡密领取状态
let cardClaimEnabled = true;
let cardClaimRecords = [];

// PBKDF2 参数
const SALT_LENGTH = 32;
const ITERATIONS = 100000;
const KEY_LENGTH = 64;
const DIGEST = 'sha512';

// 登录限制
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000;       // 15 分钟
const RATE_LIMIT_WINDOW = 60 * 1000;            // 1 分钟
const MAX_ATTEMPTS_PER_IP = 6;
const IP_LOCKOUT_DURATION = 10 * 60 * 1000;     // 10 分钟

// ==================== 登录尝试追踪 ====================

let loginAttempts = {};

function loadLoginAttempts() {
    const data = readJsonFileStrict(LOGIN_ATTEMPTS_FILE, () => ({}));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('登录限制记录格式无效');
    loginAttempts = data;
}

function saveLoginAttempts() {
    writeJsonFileAtomic(LOGIN_ATTEMPTS_FILE, loginAttempts);
}

function cleanExpiredAttempts() {
    const now = Date.now();
    let changed = false;

    for (const key of Object.keys(loginAttempts)) {
        const entry = loginAttempts[key];
        if (entry.lockedUntil && entry.lockedUntil < now) {
            delete loginAttempts[key];
            changed = true;
        } else if (
            entry.windowStart &&
            now - entry.windowStart > RATE_LIMIT_WINDOW &&
            !entry.lockedUntil
        ) {
            delete loginAttempts[key];
            changed = true;
        }
    }

    if (changed) saveLoginAttempts();
}

function checkRateLimit(ip) {
    cleanExpiredAttempts();

    const key = `ip:${  ip}`;
    const now = Date.now();

    if (!loginAttempts[key]) {
        loginAttempts[key] = { count: 1, windowStart: now };
        saveLoginAttempts();
        return { allowed: true };
    }

    const entry = loginAttempts[key];

    if (entry.lockedUntil) {
        if (entry.lockedUntil > now) {
            const remainingMs = entry.lockedUntil - now;
            return {
                allowed: false,
                remainingMs,
                message: `该 IP 登录失败过多，请 ${  Math.ceil(remainingMs / 1000)  } 秒后重试`
            };
        }
        delete loginAttempts[key];
        saveLoginAttempts();
        return { allowed: true };
    }

    // 窗口过期，重置
    if (now - entry.windowStart > RATE_LIMIT_WINDOW) {
        loginAttempts[key] = { count: 1, windowStart: now };
        saveLoginAttempts();
        return { allowed: true };
    }

    // 超过限制
    if (entry.count >= MAX_ATTEMPTS_PER_IP) {
        entry.lockedUntil = now + IP_LOCKOUT_DURATION;
        saveLoginAttempts();
        const remainingMs = IP_LOCKOUT_DURATION;
        return {
            allowed: false,
            remainingMs,
            message: `该 IP 登录失败过多，请 ${  Math.ceil(remainingMs / 1000)  } 秒后重试`
        };
    }

    entry.count++;
    saveLoginAttempts();
    return { allowed: true };
}

function checkAccountLockout(userId) {
    cleanExpiredAttempts();

    const key = `user:${userId}`;
    const now = Date.now();

    if (loginAttempts[key] && loginAttempts[key].lockedUntil) {
        if (loginAttempts[key].lockedUntil > now) {
            const remainingMs = loginAttempts[key].lockedUntil - now;
            return {
                locked: true,
                remainingMs,
                message: `账户已被锁定，请 ${  Math.ceil(remainingMs / 60000)  } 分钟后重试`
            };
        } else {
            delete loginAttempts[key];
            saveLoginAttempts();
        }
    }

    return { locked: false };
}

function recordFailedAttempt(userId) {
    const key = `user:${userId}`;
    const now = Date.now();

    if (!loginAttempts[key]) {
        loginAttempts[key] = { count: 1, firstAttempt: now };
    } else {
        loginAttempts[key].count++;
        loginAttempts[key].lastAttempt = now;
    }

    if (loginAttempts[key].count >= MAX_LOGIN_ATTEMPTS) {
        loginAttempts[key].lockedUntil = now + LOCKOUT_DURATION;
        saveLoginAttempts();
        return {
            locked: true,
            message: `登录失败次数过多，账户已被锁定 ${  LOCKOUT_DURATION / 60000  } 分钟`
        };
    }

    saveLoginAttempts();
    return {
        locked: false,
        remainingAttempts: MAX_LOGIN_ATTEMPTS - loginAttempts[key].count
    };
}

function clearFailedAttempts(userId) {
    const key = `user:${userId}`;
    if (loginAttempts[key]) {
        delete loginAttempts[key];
        saveLoginAttempts();
    }
}

function clearIpAttempts(ip) {
    const key = `ip:${  ip}`;
    if (loginAttempts[key]) {
        delete loginAttempts[key];
        saveLoginAttempts();
    }
}

// ==================== 密码工具 ====================

function validatePasswordStrength(password) {
    if (typeof password !== 'string') return { valid: false, errors: ['密码必须为字符串'] };
    const errors = [];

    if (password.length < 6) errors.push('密码长度至少6位');
    if (password.length > 128) errors.push('密码长度不能超过128位');

    let complexity = 0;
    if (/[a-z]/.test(password)) complexity++;
    if (/[A-Z]/.test(password)) complexity++;
    if (/\d/.test(password)) complexity++;
    if (/[!@#$%^&*(),.?":{}|<>_\-+=[\]\\;'/`~]/.test(password)) complexity++;

    if (complexity < 2) errors.push('密码必须包含大写字母、小写字母、数字、特殊符号中的至少两种');

    const weakPasswords = ['password', '123456', 'qwerty', 'abc123', '111111', '000000'];
    if (weakPasswords.includes(password.toLowerCase())) {
        errors.push('密码过于简单，请使用更复杂的密码');
    }

    return { valid: errors.length === 0, errors };
}

function hashPassword(password, salt = null) {
    if (!salt) {
        salt = crypto.randomBytes(SALT_LENGTH).toString('hex');
    }
    const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString('hex');
    return `${salt  }:${  hash}`;
}

function verifyPassword(password, stored) {
    if (typeof password !== 'string') return false;
    if (typeof stored !== 'string' || !/^[a-f0-9]{64}:[a-f0-9]{128}$/.test(stored)) {
        throw new Error('密码记录格式无效，请重新初始化测试用户');
    }
    const [salt, hash] = stored.split(':');
    const computed = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST);
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), computed);
}

// ==================== 卡密系统 ====================

const generateCardCode = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 16; i++) {
        code += chars.charAt(crypto.randomInt(chars.length));
    }
    return cards.some(card => card.code === code) ? generateCardCode() : code;
};

function normalizeDurationUnit(unit) {
    return unit === 'hour' ? 'hour' : 'day';
}

function toPositiveNumber(value, fallback = 1) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : fallback;
}

function getQuotaValue(card) {
    return Math.max(Number.parseInt(card?.value ?? card?.days, 10) || 1, 1);
}

function normalizeTimeDuration(input = {}) {
    const isPermanent = input.isPermanent === true
        || Number(input.durationValue) === -1
        || Number(input.days) === -1;

    if (isPermanent) {
        return {
            days: -1,
            durationValue: -1,
            durationUnit: 'day',
            durationMs: null,
            isPermanent: true
        };
    }

    if (Number.isFinite(Number(input.durationMs)) && Number(input.durationMs) > 0) {
        const durationMs = Number(input.durationMs);
        const durationUnit = normalizeDurationUnit(input.durationUnit);
        const durationValue = Number.isFinite(Number(input.durationValue)) && Number(input.durationValue) > 0
            ? Number(input.durationValue)
            : durationMs / (durationUnit === 'hour' ? HOUR_MS : DAY_MS);
        return {
            days: durationMs / DAY_MS,
            durationValue,
            durationUnit,
            durationMs,
            isPermanent: false
        };
    }

    const durationUnit = input.durationUnit ? normalizeDurationUnit(input.durationUnit) : 'day';
    const rawValue = input.durationValue !== undefined ? input.durationValue : input.days;
    const rawNumber = Number(rawValue);
    const durationValue = input.allowZero === true && Number.isFinite(rawNumber) && rawNumber >= 0
        ? rawNumber
        : toPositiveNumber(rawValue, 1);
    const durationMs = durationUnit === 'hour' ? durationValue * HOUR_MS : durationValue * DAY_MS;

    return {
        days: durationMs / DAY_MS,
        durationValue,
        durationUnit,
        durationMs,
        isPermanent: false
    };
}

function assignDurationFields(target, duration) {
    target.days = duration.days;
    target.durationValue = duration.durationValue;
    target.durationUnit = duration.durationUnit;
    target.durationMs = duration.durationMs;
    target.isPermanent = duration.isPermanent;
}

function normalizeCardForResponse(card) {
    if (!card || card.type === 'quota') return card;
    const duration = normalizeTimeDuration(card);
    return { ...card, ...duration };
}

let users = [];
let retiredUsernames = [];
let nextUserId = ADMIN_USER_ID + 1;
let cards = [];

function loadUsers() {
    identityTransaction.recover();
    const data = readJsonFileStrict(USERS_FILE);
    if (data?.schemaVersion !== USER_SCHEMA_VERSION || !Array.isArray(data.users) || !Array.isArray(data.retiredUsernames) || !Number.isSafeInteger(data.nextUserId) || data.nextUserId <= ADMIN_USER_ID) {
        throw storageError('读取', USERS_FILE, new Error('Unsupported user schema; initialize new test data'));
    }
    const names = new Set(data.retiredUsernames.map(name => typeof name === 'string' ? name.toLowerCase() : name));
    if (names.size !== data.retiredUsernames.length || [...names].some(name => typeof name !== 'string' || !/^\w{3,32}$/.test(name))) {
        throw new Error('用户身份记录无效');
    }
    const ids = new Set();
    for (const user of data.users) {
        if (!isUserIdentity(user) || ids.has(user.id) || user.id >= data.nextUserId || !/^\w{3,32}$/.test(user.username) || names.has(user.username.toLowerCase()) || !['admin', 'user'].includes(user.role)
            || !/^[a-f0-9]{64}:[a-f0-9]{128}$/.test(user.password)) throw new Error('用户记录无效');
        names.add(user.username.toLowerCase());
        ids.add(user.id);
    }
    if (!ids.has(ADMIN_USER_ID)) throw new Error('缺少 ID 1000 管理员');
    users = data.users;
    nextUserId = data.nextUserId;
    retiredUsernames = data.retiredUsernames;
}

function saveUsers() {
    try { writeJsonFileAtomic(USERS_FILE, { schemaVersion: USER_SCHEMA_VERSION, users, retiredUsernames, nextUserId }); }
    catch (error) { throw storageError('保存', USERS_FILE, error); }
}

function loadCards() {
    identityTransaction.recover();
    const data = readJsonFileStrict(CARDS_FILE, () => ({ cards: [] }));
    if (!Array.isArray(data?.cards)) throw new Error('卡密记录格式无效');
    cards = data.cards;
}

function saveCards() {
    writeJsonFileAtomic(CARDS_FILE, { cards });
}

function saveIdentity() {
    identityTransaction.commit({
        'users.json': { schemaVersion: USER_SCHEMA_VERSION, users, retiredUsernames, nextUserId },
        'cards.json': { cards },
        'card-claim.json': { enabled: cardClaimEnabled, records: cardClaimRecords },
    });
}

function bindCardClaim(cardCode, userId) {
    for (const record of cardClaimRecords) {
        if (record.cardCode === cardCode) record.userId = userId;
    }
}

// ==================== 默认管理员初始化 ====================

function initDefaultAdmin() {
    if (fs.existsSync(USERS_FILE)) {
        loadUsers();
        return;
    }
    users = [{ id: ADMIN_USER_ID, username: 'admin', password: hashPassword('admin'), role: 'admin', createdAt: Date.now() }];
    retiredUsernames = [];
    nextUserId = ADMIN_USER_ID + 1;
    saveUsers();
    console.log('[用户系统] 已初始化管理员账号，请首次登录后修改密码');
}

initDefaultAdmin();

// ==================== 用户验证 ====================

function validateUser(username, password, ip = 'unknown') {
    loadUsers();
    loadLoginAttempts();

    // IP 频率限制
    const rateLimit = checkRateLimit(ip);
    if (!rateLimit.allowed) {
        return { error: 'rate_limit', message: rateLimit.message, remainingMs: rateLimit.remainingMs };
    }

    const user = users.find(u => u.username === username);
    // 账户锁定按不可变 ID 记录。
    const lockout = user ? checkAccountLockout(user.id) : { locked: false };
    if (lockout.locked) {
        return { error: 'locked', message: lockout.message, remainingMs: lockout.remainingMs };
    }

    // 查找用户
    if (!user || !['admin', 'user'].includes(user.role)) {
        return { error: 'invalid_credentials', message: '用户名或密码错误' };
    }

    // 验证密码
    if (!verifyPassword(password, user.password)) {
        const result = recordFailedAttempt(user.id);
        if (result.locked) {
            return { error: 'locked', message: result.message };
        }
        return {
            error: 'invalid_credentials',
            message: `用户名或密码错误，剩余尝试次数: ${  result.remainingAttempts}`
        };
    }

    clearFailedAttempts(user.id);
    clearIpAttempts(ip);

    return {
        id: user.id,
        username: user.username,
        role: user.role,
        deleting: user.deleting === true,
        cardCode: user.cardCode || null,
        card: user.card || null,
        accountLimit: user.accountLimit || DEFAULT_ACCOUNT_LIMIT
    };
}

// ==================== 用户注册 ====================

function registerUser(username, password, cardCode) {
    loadUsers();
    loadCards();
    loadCardClaimRecords();

    // 用户名验证
    if (typeof username !== 'string' || username.length < 3 || username.length > 32) {
        return { ok: false, error: '用户名长度需在3-32位之间' };
    }
    if (!/^\w+$/.test(username)) {
        return { ok: false, error: '用户名只能包含字母、数字和下划线' };
    }
    if (retiredUsernames.some(name => name.toLowerCase() === username.toLowerCase())) return { ok: false, error: '该用户名已永久停用，请使用新的用户名' };
    if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
        return { ok: false, error: '用户名已存在' };
    }

    // 密码强度
    const pwdResult = validatePasswordStrength(password);
    if (!pwdResult.valid) return { ok: false, error: pwdResult.errors.join('；') };

    // Verification disabled: ignore stale form values and never consume a card.
    const verificationEnabled = getAccessPolicy().cardVerificationEnabled;
    const card = verificationEnabled ? cards.find(c => c.code === cardCode) : null;
    if (verificationEnabled) {
        if (!card) return { ok: false, error: '卡密不存在' };
        if (!card.enabled) return { ok: false, error: '卡密已被禁用' };
        if (card.usedBy) return { ok: false, error: '卡密已被使用' };
        if (card.type === 'quota') {
            return { ok: false, error: '注册只能使用时间卡密，额度卡密请登录后在续费中使用' };
        }
    }

    const now = Date.now();
    const duration = card ? normalizeTimeDuration(card) : null;
    const cardRecord = card ? {
        code: card.code,
        description: card.description,
        expiresAt: duration.isPermanent ? null : now + duration.durationMs,
        enabled: true
    } : null;
    if (cardRecord) assignDurationFields(cardRecord, duration);

    // 创建用户
    if (!Number.isSafeInteger(nextUserId + 1)) throw new Error('用户 ID 已耗尽');
    const newUser = {
        id: nextUserId++,
        username,
        password: hashPassword(password),
        role: 'user',
        cardCode: card ? card.code : null,
        card: cardRecord,
        accountLimit: DEFAULT_ACCOUNT_LIMIT,
        createdAt: now
    };

    users.push(newUser);
    if (card) {
        card.usedBy = newUser.id;
        card.usedAt = now;
        bindCardClaim(card.code, newUser.id);
    }
    saveIdentity();
    clearFailedAttempts(newUser.id);

    return {
        ok: true,
        user: {
            id: newUser.id,
            username: newUser.username,
            role: newUser.role,
            card: newUser.card,
            accountLimit: newUser.accountLimit
        }
    };
}

// ==================== 用户续费 ====================

function renewUser(userId, cardCode) {
    assertUserId(userId);
    loadUsers();
    loadCards();
    loadCardClaimRecords();

    const user = users.find(u => u.id === userId);
    if (!user) return { ok: false, error: '用户不存在' };

    const card = cards.find(c => c.code === cardCode);
    if (!card) return { ok: false, error: '卡密不存在' };
    if (!card.enabled) return { ok: false, error: '卡密已被禁用' };
    if (card.usedBy) return { ok: false, error: '卡密已被使用' };

    const now = Date.now();
    const cardType = card.type || 'time';

    if (cardType === 'quota') {
        // 额度卡密：增加账号限额
        const current = user.accountLimit || DEFAULT_ACCOUNT_LIMIT;
        user.accountLimit = current + getQuotaValue(card);
    } else {
        // 时间卡密
        const duration = normalizeTimeDuration(card);
        if (!user.card) {
            user.card = {
                code: card.code,
                description: card.description,
                days: 0,
                expiresAt: null,
                enabled: true
            };
        }

        const prevExpiresAt = user.card.expiresAt || 0;
        const prevDuration = normalizeTimeDuration({ ...user.card, allowZero: true });

        if (duration.isPermanent) {
            // 永久卡
            user.card.expiresAt = null;
            assignDurationFields(user.card, duration);
        } else if (prevDuration.isPermanent) {
            // 已经是永久，不需要叠加
            user.card.expiresAt = null;
        } else {
            const totalDuration = normalizeTimeDuration({
                durationMs: (prevDuration.durationMs || 0) + duration.durationMs,
                durationUnit: ((prevDuration.durationMs || 0) + duration.durationMs) % DAY_MS === 0 ? 'day' : 'hour'
            });
            assignDurationFields(user.card, totalDuration);
            if (prevExpiresAt && prevExpiresAt > now) {
                user.card.expiresAt = prevExpiresAt + duration.durationMs;
            } else {
                user.card.expiresAt = now + duration.durationMs;
            }
        }
    }

    card.usedBy = user.id;
    card.usedAt = now;
    bindCardClaim(card.code, user.id);
    saveIdentity();

    return {
        ok: true,
        card: user.card,
        accountLimit: user.accountLimit || DEFAULT_ACCOUNT_LIMIT,
        cardType
    };
}

// ==================== 用户管理 ====================

function getUser(userId) {
    assertUserId(userId);
    return getAllUsers().find(user => user.id === userId) || null;
}

function getUserByUsername(username) {
    return getAllUsers().find(user => user.username === username) || null;
}

function getAllUsers() {
    loadUsers();
    const policy = getAccessPolicy();
    return users
        .map(u => ({
            id: u.id,
            username: u.username,
            role: u.role,
            createdAt: u.createdAt,
            accessStatus: u.deleting ? 'deleting' : getUserAccessRejection(u, policy)?.reason || 'normal',
            deleting: u.deleting === true,
            card: u.card,
            accountLimit: u.accountLimit || DEFAULT_ACCOUNT_LIMIT
        }));
}

function updateUser(userId, updates) {
    assertUserId(userId);
    loadUsers();
    const user = users.find(u => u.id === userId);
    if (!user) return null;
    const error = validateUserUpdates(updates);
    if (error) throw Object.assign(new Error(error), { status: 400 });

    if (updates.expiresAt !== undefined) {
        if (!user.card) user.card = {};
        assignUserExpiry(user.card, updates.expiresAt);
    }
    if (updates.enabled !== undefined) {
        if (!user.card) user.card = {};
        user.card.enabled = updates.enabled;
    }

    saveUsers();
    return {
        id: user.id,
        username: user.username,
        role: user.role,
        deleting: user.deleting === true,
        card: user.card,
        accountLimit: user.accountLimit || DEFAULT_ACCOUNT_LIMIT
    };
}

function validateUserUpdates(updates) {
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return '用户修改参数必须为对象';
    if (updates.accountLimit !== undefined && (!Number.isSafeInteger(updates.accountLimit) || updates.accountLimit <= 0)) return '账号限额必须为正整数';
    if (updates.expiresAt !== undefined && updates.expiresAt !== null
        && (!Number.isSafeInteger(updates.expiresAt) || updates.expiresAt <= 0 || updates.expiresAt > 8.64e15)) return '过期时间必须为有效时间戳或 null';
    for (const field of ['enabled', 'isPermanent']) {
        if (updates[field] !== undefined && typeof updates[field] !== 'boolean') return `${field} 必须为布尔值`;
    }
    if (updates.isPermanent === true && updates.expiresAt != null) return '永久权限与过期时间不能同时设置';
    if (updates.password !== undefined) {
        const result = validatePasswordStrength(updates.password);
        if (!result.valid) return result.errors.join('；');
    }
    return null;
}

function assignUserExpiry(card, expiresAt) {
    const durationMs = expiresAt === null ? 0 : Math.max(0, expiresAt - Date.now());
    assignDurationFields(card, {
        days: durationMs / DAY_MS, durationValue: durationMs / HOUR_MS,
        durationUnit: 'hour', durationMs, isPermanent: false,
    });
    card.expiresAt = expiresAt;
}

function editUser(userId, updates) {
    assertUserId(userId);
    loadUsers();
    const user = users.find(u => u.id === userId);
    if (!user) return { ok: false, error: '用户不存在' };
    const error = validateUserUpdates(updates);
    if (error) return { ok: false, error };

    // 修改用户名
    if (updates.newUsername !== undefined && updates.newUsername !== user.username) {
        return { ok: false, error: '用户名创建后不可修改' };
    }

    // 修改密码
    if (updates.password !== undefined) {
        user.password = hashPassword(updates.password);
    }

    // 账号限额
    if (updates.accountLimit !== undefined) {
        user.accountLimit = updates.accountLimit;
    }

    // 设置永久/过期时间
    if (updates.isPermanent === true) {
        if (!user.card) user.card = {};
        assignDurationFields(user.card, normalizeTimeDuration({ isPermanent: true }));
        user.card.expiresAt = null;
    } else if (updates.expiresAt !== undefined || updates.isPermanent === false) {
        if (!user.card) user.card = {};
        assignUserExpiry(user.card, updates.expiresAt === undefined ? user.card.expiresAt ?? null : updates.expiresAt);
    }

    saveUsers();
    return {
        ok: true,
        user: {
            id: user.id,
        username: user.username,
            role: user.role,
            card: user.card,
            accountLimit: user.accountLimit || DEFAULT_ACCOUNT_LIMIT
        }
    };
}

// ==================== 卡密管理 ====================

function getAllCards() {
    loadCards();
    loadCardClaimRecords();
    return cards.map(card => {
        const record = cardClaimRecords.find(record => record.cardCode === card.code);
        return { ...normalizeCardForResponse(card), claimedAt: card.claimedAt ?? record?.claimTime ?? null };
    });
}

function createCard(description, days, type = 'time', options = {}) {
    loadCards();
    const cardType = type === 'quota' ? 'quota' : 'time';
    const card = {
        code: generateCardCode(),
        description,
        type: cardType,
        enabled: true,
        usedBy: null,
        usedAt: null,
        createdAt: Date.now()
    };
    if (cardType === 'quota') {
        const value = getQuotaValue({ value: options.value, days });
        card.days = value;
        card.value = value;
    } else {
        assignDurationFields(card, normalizeTimeDuration({ ...options, days }));
    }
    cards.push(card);
    saveCards();
    return card;
}

function createCardsBatch(description, days, count, type = 'time', options = {}) {
    loadCards();
    const created = [];
    const countNum = Math.min(Math.max(Number.parseInt(count, 10) || 1, 1), 100);
    const cardType = type === 'quota' ? 'quota' : 'time';
    const quotaValue = getQuotaValue({ value: options.value, days });
    const duration = normalizeTimeDuration({ ...options, days });

    for (let i = 0; i < countNum; i++) {
        const card = {
            code: generateCardCode(),
            description,
            type: cardType,
            enabled: true,
            usedBy: null,
            usedAt: null,
            createdAt: Date.now()
        };
        if (cardType === 'quota') {
            card.days = quotaValue;
            card.value = quotaValue;
        } else {
            assignDurationFields(card, duration);
        }
        cards.push(card);
        created.push(card);
    }

    saveCards();
    return created;
}

function updateCard(code, updates) {
    loadCards();
    const card = cards.find(c => c.code === code);
    if (!card) return null;

    if (updates.description !== undefined) card.description = updates.description;
    if (updates.enabled !== undefined) card.enabled = updates.enabled;

    saveCards();
    return card;
}

function deleteCard(code) {
    loadCards();
    const idx = cards.findIndex(c => c.code === code);
    if (idx === -1) return false;

    cards.splice(idx, 1);
    saveCards();
    return true;
}

function deleteCardsBatch(codes) {
    loadCards();
    if (!Array.isArray(codes) || codes.length === 0) {
        return { ok: false, error: '请提供要删除的卡密列表' };
    }

    let deletedCount = 0;
    const notFound = [];

    for (const code of codes) {
        const idx = cards.findIndex(c => c.code === code);
        if (idx !== -1) {
            cards.splice(idx, 1);
            deletedCount++;
        } else {
            notFound.push(code);
        }
    }

    saveCards();
    return {
        ok: true,
        deletedCount,
        notFoundCount: notFound.length,
        notFoundCodes: notFound.length > 0 ? notFound : undefined
    };
}

function beginUserDeletion(userId) {
    assertUserId(userId);
    loadUsers();
    const user = users.find(user => user.id === userId);
    if (!user) return { ok: false, error: '用户不存在' };
    if (user.id === ADMIN_USER_ID) return { ok: false, error: '管理员账号保留' };
    user.deleting = true;
    saveUsers();
    return { ok: true };
}

function getExpiredUserIds() {
    if (!getAccessPolicy().cardVerificationEnabled) throw new Error('卡密验证已关闭，禁止按到期清理用户');
    loadUsers();
    return users.filter(user => user.role !== 'admin' && user.card?.expiresAt && user.card.expiresAt < Date.now()).map(user => user.id);
}

function deleteUser(userId, force = false) {
    assertUserId(userId);
    loadUsers();
    const idx = users.findIndex(u => u.id === userId);
    if (idx === -1) return { ok: false, error: '用户不存在' };
    if (users[idx].id === ADMIN_USER_ID) {
        return { ok: false, error: '不能删除管理员账号' };
    }

    if (!users[idx].deleting) return { ok: false, error: '请先停用用户并清理全部数据' };
    loadCards();
    loadCardClaimRecords();
    const removedCards = new Set(cards.filter(card => card.usedBy === userId).map(card => card.code));
    cardClaimRecords.filter(record => record.userId === userId).forEach(record => removedCards.add(record.cardCode));
    cards = cards.filter(card => !removedCards.has(card.code));
    saveCards();
    loadLoginAttempts();
    delete loginAttempts[`user:${userId}`];
    saveLoginAttempts();
    loadLoginLogs();
    loginLogs = loginLogs.filter(log => log.userId !== userId);
    saveLoginLogs();
    cardClaimRecords = cardClaimRecords.filter(record => record.userId !== userId && !removedCards.has(record.cardCode));
    saveCardClaimRecords();
    retiredUsernames.push(users[idx].username);
    users.splice(idx, 1);
    saveUsers();
    return { ok: true };
}

function changePassword(userId, currentPassword, newPassword) {
    assertUserId(userId);
    loadUsers();
    const user = users.find(u => u.id === userId);
    if (!user) return { ok: false, error: '用户不存在' };

    if (!verifyPassword(currentPassword, user.password)) {
        return { ok: false, error: '当前密码错误' };
    }

    const pwdResult = validatePasswordStrength(newPassword);
    if (!pwdResult.valid) return { ok: false, error: pwdResult.errors.join('；') };

    user.password = hashPassword(newPassword);
    if (user.mustChangePassword) delete user.mustChangePassword;
    saveUsers();

    return { ok: true, message: '密码修改成功' };
}


// ==================== 卡密领取系统 ====================

function loadCardClaimRecords() {
    identityTransaction.recover();
    const data = readJsonFileStrict(CARD_CLAIM_FILE, () => ({ enabled: true, records: [] }));
    if (typeof data?.enabled !== 'boolean' || !Array.isArray(data.records)) throw new Error('卡密领取记录格式无效');
    cardClaimEnabled = data.enabled;
    cardClaimRecords = data.records;
}

function saveCardClaimRecords() {
    writeJsonFileAtomic(CARD_CLAIM_FILE, { enabled: cardClaimEnabled, records: cardClaimRecords });
}

function getCardClaimStatus() {
    loadCardClaimRecords();
    return { enabled: cardClaimEnabled };
}

function getAvailableTimeCardCount() {
    loadCards();
    loadCardClaimRecords();
    const reserved = new Set(cardClaimRecords.map(record => record.cardCode));
    return cards.filter(card =>
        card.type === 'time' && !card.usedBy && !card.claimedAt && !reserved.has(card.code) && card.enabled
    ).length;
}

function setCardClaimStatus(enabled) {
    if (typeof enabled !== 'boolean') throw Object.assign(new Error('卡密领取开关必须为布尔值'), { status: 400 });
    loadCardClaimRecords();
    cardClaimEnabled = enabled;
    saveCardClaimRecords();
    return { enabled: cardClaimEnabled };
}

function checkClaimLimit(ipHash) {
    const now = Date.now();
    // User-Agent identifies a browser build, not a person. Shared browser
    // versions must not consume each other's daily allowance.
    const latest = cardClaimRecords.filter(record => record.ipHash === ipHash)
        .reduce((latest, record) => Math.max(latest, record.claimTime), 0);

    if (latest) {
        const elapsed = now - latest;
        if (elapsed < 86400000) {  // 24 小时内
            const remainingMs = 86400000 - elapsed;
            return {
                allowed: false,
                remainingMs,
                message: '您已经在24小时内领取过一次卡密了！'
            };
        }
    }

    return { allowed: true };
}

function claimCard(ua, ip) {
    loadCards();
    loadCardClaimRecords();
    const { isIP } = require('node:net');
    const source = typeof ip === 'string' ? ip.replace(/^::ffff:/i, '') : '';
    if (typeof ua !== 'string' || !isIP(source)) return { ok: false, error: '领取请求来源无效' };
    const uaHash = crypto.createHash('sha256').update(ua).digest('hex');
    const ipHash = crypto.createHash('sha256').update(source).digest('hex');

    if (!cardClaimEnabled) {
        return { ok: false, error: '卡密领取功能未开启' };
    }

    const limit = checkClaimLimit(ipHash);
    if (!limit.allowed) {
        return { ok: false, error: limit.message, remainingMs: limit.remainingMs };
    }

    // 筛选可用的时间卡密
    const reserved = new Set(cardClaimRecords.map(record => record.cardCode));
    const availableCards = cards.filter(c =>
        c.type === 'time' && !c.usedBy && !c.claimedAt && !reserved.has(c.code) && c.enabled
    );

    if (availableCards.length === 0) {
        return { ok: false, error: '卡密库存不足，请联系管理员！' };
    }

    // 随机选一张
    const selected = availableCards[crypto.randomInt(availableCards.length)];
    const selectedCard = normalizeCardForResponse(selected);

    // 记录领取
    selected.claimedAt = Date.now();
    cardClaimRecords.push({
        uaHash,
        ipHash,
        claimTime: selected.claimedAt,
        cardCode: selectedCard.code,
        userId: null
    });
    identityTransaction.commit({
        'cards.json': { cards },
        'card-claim.json': { enabled: cardClaimEnabled, records: cardClaimRecords },
    });

    return {
        ok: true,
        cardCode: selectedCard.code,
        days: selectedCard.days,
        durationValue: selectedCard.durationValue,
        durationUnit: selectedCard.durationUnit,
        durationMs: selectedCard.durationMs,
        isPermanent: selectedCard.isPermanent === true,
        description: selectedCard.description
    };
}

function getCardClaimRecords() {
    loadCardClaimRecords();
    return cardClaimRecords;
}

function clearExpiredClaimRecords() {
    loadCards();
    loadCardClaimRecords();
    const now = Date.now();
    const thirtyDays = 2592000000;  // 30 天
    const before = cardClaimRecords.length;

    const unredeemed = new Set(cards.filter(card => !card.usedBy).map(card => card.code));
    cardClaimRecords = cardClaimRecords.filter(r => now - r.claimTime < thirtyDays || unredeemed.has(r.cardCode));

    if (cardClaimRecords.length !== before) saveCardClaimRecords();
    return { cleared: before - cardClaimRecords.length };
}

// ==================== 清理 ====================


function getUserCount() {
    loadUsers();
    return users.length;
}

// ==================== 密码重置（通过卡密） ====================

function verifyCardOwnership(username, cardCode) {
    loadUsers();
    loadCards();

    if (!username || !cardCode) {
        return { ok: false, error: '请提供用户名和卡密' };
    }

    const user = users.find(u => u.username === username);
    if (!user) return { ok: false, error: '用户名或卡密错误' };

    const card = cards.find(c => c.code === cardCode);
    if (!card) return { ok: false, error: '用户名或卡密错误' };

    // Renewal can be paid by a third party. Only the original registration
    // credential proves ownership; a later payment must never grant recovery.
    if (user.role !== 'user' || user.deleting || !user.cardCode || user.cardCode !== cardCode
        || card.type === 'quota' || card.usedBy !== user.id) {
        return { ok: false, error: '请提供该用户注册时使用的卡密' };
    }

    return { ok: true };
}

function resetPasswordByCard(username, cardCode, newPassword) {
    loadUsers();
    const ownership = verifyCardOwnership(username, cardCode);
    if (!ownership.ok) return ownership;

    const pwdResult = validatePasswordStrength(newPassword);
    if (!pwdResult.valid) return { ok: false, error: pwdResult.errors.join('；') };

    const user = users.find(u => u.username === username);
    user.password = hashPassword(newPassword);
    if (user.mustChangePassword) delete user.mustChangePassword;
    clearFailedAttempts(user.id);
    saveUsers();

    return { ok: true, message: '密码重置成功' };
}

// ==================== 登录日志系统 ====================

const LOGIN_LOGS_FILE = getDataFile('login-logs.json');
let loginLogs = [];
let logIdCounter = 0;

function loadLoginLogs() {
    const data = readJsonFileStrict(LOGIN_LOGS_FILE, () => ({ logs: [], counter: 0 }));
    if (!Array.isArray(data?.logs) || !Number.isSafeInteger(data.counter) || data.counter < 0) throw new Error('登录日志格式无效');
    loginLogs = data.logs;
    logIdCounter = data.counter;
}

function saveLoginLogs() {
    writeJsonFileAtomic(LOGIN_LOGS_FILE, { logs: loginLogs, counter: logIdCounter });
}

function addLoginLog(event, username, errorType, ip, userAgent) {
    loadLoginLogs();
    const user = getUserByUsername(username);
    logIdCounter++;
    loginLogs.push({
        id: String(logIdCounter),
        timestamp: Date.now(),
        event,
        userId: user?.id ?? null,
        username: user?.username ?? '',
        errorType: errorType || null,
        ip,
        userAgent: userAgent || 'unknown'
    });

    // 只保留最近 5000 条日志
    if (loginLogs.length > 5000) {
        loginLogs = loginLogs.slice(-5000);
    }

    saveLoginLogs();
}

function getLoginLogs(limit = 100, offset = 0) {
    loadLoginLogs();
    const numLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
    const numOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const reversed = loginLogs.slice().reverse();
    return {
        logs: reversed.slice(numOffset, numOffset + numLimit),
        total: reversed.length
    };
}

function clearLoginLogs() {
    loginLogs = [];
    logIdCounter = 0;
    saveLoginLogs();
    return { ok: true };
}

// 初始化
loadLoginLogs();

// ==================== 模块导出 ====================

module.exports = {
    validateUser,
    registerUser,
    renewUser,
    getAllUsers,
    getUser,
    getUserByUsername,
    updateUser,
    editUser,
    getAllCards,
    createCard,
    createCardsBatch,
    updateCard,
    deleteCard,
    deleteCardsBatch,
    deleteUser,
    beginUserDeletion,
    getExpiredUserIds,
    changePassword,
    DEFAULT_ACCOUNT_LIMIT,
    getCardClaimStatus,
    getAvailableTimeCardCount,
    setCardClaimStatus,
    claimCard,
    getCardClaimRecords,
    clearExpiredClaimRecords,
    getUserCount,
    checkRateLimit,
    clearIpAttempts,
    verifyCardOwnership,
    resetPasswordByCard,
    addLoginLog,
    getLoginLogs,
    clearLoginLogs
};
