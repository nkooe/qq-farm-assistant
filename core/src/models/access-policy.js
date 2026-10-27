const fs = require('node:fs');
const { ensureDataDir, getDataFile } = require('../config/runtime-paths');

function getAccessPolicy() {
  try {
    const data = JSON.parse(fs.readFileSync(getDataFile('access-policy.json'), 'utf8'));
    return { cardVerificationEnabled: data.cardVerificationEnabled !== false };
  } catch {
    // Missing or damaged configuration keeps the existing verification policy.
    return { cardVerificationEnabled: true };
  }
}

function setAccessPolicy(config) {
  if (typeof config?.cardVerificationEnabled !== 'boolean') {
    throw new Error('卡密验证开关必须为布尔值');
  }
  const policy = { cardVerificationEnabled: config.cardVerificationEnabled };
  ensureDataDir();
  const file = getDataFile('access-policy.json');
  const temporaryFile = `${file}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(policy, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryFile, file);
  return policy;
}

function getUserAccessRejection(user) {
  if (!user || !['admin', 'user'].includes(user.role)) {
    return { reason: 'invalid_role', error: '登录状态已失效，请重新登录' };
  }
  if (user.role === 'admin') return null;
  if (user.card?.enabled === false) {
    return { reason: 'banned', error: '账号已被封禁，请联系管理员' };
  }
  if (!getAccessPolicy().cardVerificationEnabled) return null;
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
