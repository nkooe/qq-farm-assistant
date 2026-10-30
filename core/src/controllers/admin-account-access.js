const { isUserIdentity, assertUserId } = require('../models/user-id');
const {
  normalizeAccountRef,
} = require('../services/account-resolver');

function createAdminAccountAccess({ getProvider }) {
  function getAccountsForUser(userId = null) {
    if (userId !== null) assertUserId(userId);
    const data = getProvider().getAccounts();
    if (!Array.isArray(data?.accounts)) throw new Error('账号数据格式异常');
    return userId === null ? data.accounts : data.accounts.filter(account => account.userId === userId);
  }

  function canAccessAccount(req, accountId) {
    const currentUser = req.currentUser;
    if (!isUserIdentity(currentUser)) return false;
    if (currentUser.role === 'admin')
      return true;
    if (currentUser.role !== 'user' || !currentUser.id) return false;
    const accountList = getAccountsForUser();
    const account = accountList.find(item => String(item.id) === String(accountId));
    if (!account) return false;
    return account.userId === currentUser.id;
  }

  function getAccessibleAccountIdsFromRequest(req) {
    return getAccessibleAccountIdsForUser(req.currentUser);
  }

  function getAccessibleAccountIdsForUser(user) {
    if (!isUserIdentity(user)) return [];
    if (user.role === 'admin') {
      const accountList = getAccountsForUser();
      return accountList.map(account => account.id);
    }
    if (user.role !== 'user' || !user.id) return [];
    const accountList = getAccountsForUser(user.id);
    return accountList.map(account => account.id);
  }

  function resolveAccountReference(ref) {
    return normalizeAccountRef(ref);
  }

  function getAccountIdFromRequest(req) {
    return resolveAccountReference(req.headers['x-account-id']);
  }

  return {
    canAccessAccount,
    getAccessibleAccountIdsForUser,
    getAccessibleAccountIdsFromRequest,
    getAccountIdFromRequest,
    getAccountsForUser,
    resolveAccountReference,
  };
}

module.exports = {
  createAdminAccountAccess,
};
