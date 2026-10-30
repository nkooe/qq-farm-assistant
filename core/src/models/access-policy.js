const { isUserIdentity } = require('./user-id');
const fs = require('node:fs');
const { ensureDataDir, getDataFile } = require('../config/runtime-paths');
const { readJsonFileStrict, writeJsonFileAtomic } = require('../services/json-db');

function getAccessPolicy() {
  const file = getDataFile('access-policy.json');
  if (!fs.existsSync(file)) setAccessPolicy({ cardVerificationEnabled: true });
  const data = readJsonFileStrict(file);
  if (typeof data?.cardVerificationEnabled !== 'boolean') throw new Error('卡密验证配置格式无效');
  return { cardVerificationEnabled: data.cardVerificationEnabled };
}

function setAccessPolicy(config) {
  if (typeof config?.cardVerificationEnabled !== 'boolean') {
    throw new Error('卡密验证开关必须为布尔值');
  }
  const policy = { cardVerificationEnabled: config.cardVerificationEnabled };
  ensureDataDir();
  const file = getDataFile('access-policy.json');
  writeJsonFileAtomic(file, policy);
  return policy;
}

function getUserAccessRejection(user, policy) {
  if (!isUserIdentity(user)) {
    return { reason: 'invalid_role', error: '登录状态已失效，请重新登录' };
  }
  if (user.deleting) return { reason: 'banned', error: '用户数据正在删除，账号已停用' };
  if (user.role === 'admin') return null;
  if (user.card?.enabled === false) {
    return { reason: 'banned', error: '账号已被封禁，请联系管理员' };
  }
  if (!(policy || getAccessPolicy()).cardVerificationEnabled) return null;
  const expiresAt = Number(user.card?.expiresAt);
  const permanent = user.card?.isPermanent === true || user.card?.days === -1 || user.card?.durationValue === -1;
  if (!user.card || (!permanent && (!Number.isFinite(expiresAt) || expiresAt <= 0))) {
    return { reason: 'card_required', error: '当前已开启卡密验证，请先激活卡密后登录' };
  }
  if (!permanent && expiresAt <= Date.now()) {
    return { reason: 'expired', error: '账号已过期，请续费后重新登录' };
  }
  return null;
}

module.exports = { getAccessPolicy, setAccessPolicy, getUserAccessRejection };
