function trustedUserHeaders(userId) {
  const user = require('../models/user-store').getUser(userId);
  if (!user || user.deleting || !require('../models/user-id').isUserIdentity(user)) throw new Error('账号所属用户已停用或不存在');
  return { 'X-Farm-User-ID': String(user.id), 'X-Farm-Role': user.role };
}

module.exports = { trustedUserHeaders };
