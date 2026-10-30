const ADMIN_USER_ID = 1000;

function isUserId(value) {
  return Number.isSafeInteger(value) && value >= ADMIN_USER_ID;
}

function assertUserId(value) {
  if (!isUserId(value)) throw Object.assign(new Error('无效的用户 ID'), { status: 400 });
  return value;
}

function parseUserId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw Object.assign(new Error('无效的用户 ID'), { status: 400 });
  return assertUserId(Number(value));
}

function isUserIdentity(user) {
  return !!user && isUserId(user.id)
    && (user.id === ADMIN_USER_ID ? user.role === 'admin' : user.role === 'user');
}

module.exports = { ADMIN_USER_ID, isUserId, assertUserId, parseUserId, isUserIdentity };
