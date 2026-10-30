const { isUserId } = require('../models/user-id');
const { getUserAccessRejection } = require('../models/access-policy');

function getAccountAccessRejection(account) {
  if (account?.deleting) return { reason: 'deleting', error: '账号数据正在删除，账号已停用' };
  const user = isUserId(account?.userId) ? require('../models/user-store').getUser(account.userId) : null;
  return getUserAccessRejection(user);
}

module.exports = { getAccountAccessRejection };
