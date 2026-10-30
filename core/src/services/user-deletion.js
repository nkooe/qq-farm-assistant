const { callYybApi, resolveYybCreds } = require('../controllers/admin-yyb-routes');

function createUserDeletion({ userStore, store, provider, qqLogin, invalidateSessions, purgeRefreshJobs, purgeYyb, purgeYybState = async () => {}, purgeLogs = require('./logger').purgeUserLogs }) {
  const deleting = new Map();
  async function perform(userId) {
    const begun = userStore.beginUserDeletion(userId);
    if (!begun.ok) throw new Error(begun.error);
    const accountIds = store.getAccountsByUser(userId).accounts.map(account => String(account.id));
    invalidateSessions(session => session.id === userId);
    // Cancellation is issued before waiting for workers and native login processes.
    const jobs = purgeRefreshJobs(userId, accountIds);
    await Promise.all([provider.removeUserData(userId), jobs, purgeYybState(userId)]);
    await qqLogin.purgeUser(userId);
    if (purgeYyb) await purgeYyb(userId);
    else {
      const { apiBase, apiKey } = resolveYybCreds();
      const result = await callYybApi(apiBase, '/internal/users', apiKey, {
        method: 'DELETE', body: JSON.stringify({ userId }),
        headers: { 'X-Farm-Role': 'admin', 'X-Farm-User-ID': '1000' },
      });
      if (!result.ok || result.data?.deleted !== true) throw new Error('应用宝用户数据清理失败，用户保持停用状态，请检查服务后重试删除');
    }
    await purgeLogs(userId, accountIds);
    store.deleteAccountsByUser(userId);
    store.deleteUserConfig(userId);
    const result = userStore.deleteUser(userId, true);
    if (!result.ok) throw new Error(result.error);
    return result;
  }
  return function deleteUser(userId) {
    if (deleting.has(userId)) return deleting.get(userId);
    const operation = perform(userId).finally(() => deleting.delete(userId));
    deleting.set(userId, operation);
    return operation;
  };
}

module.exports = { createUserDeletion };
