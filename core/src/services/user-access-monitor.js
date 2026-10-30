const { getAccessPolicy, getUserAccessRejection } = require('../models/access-policy');

// The HTTP gate protects new requests; this monitor also revokes already running work.
function createUserAccessMonitor({ userStore, provider, qqLogin, yybRoutes, cancelUserJobs, cleanupSessions, logger }) {
  const blocked = new Set();
  const pending = new Map();
  let timer;
  let closed = false;
  const issue = action => { try { return Promise.resolve(action()); } catch (error) { return Promise.reject(error); } };

  function reconcile() {
    if (closed) return Promise.resolve();
    const users = new Map(userStore.getAllUsers().map(user => [user.id, user]));
    const policy = getAccessPolicy();
    const accounts = provider.getAccounts().accounts;
    for (const account of accounts) {
      if (!users.has(account.userId)) users.set(account.userId, null);
    }
    cleanupSessions();
    for (const [userId, user] of users) {
      if (pending.has(userId)) continue;
      const rejection = getUserAccessRejection(user, policy);
      if (!!rejection === blocked.has(userId)) continue;
      let work;
      if (rejection) {
        blocked.add(userId);
        const ids = accounts.filter(account => account.userId === userId).map(account => String(account.id));
        work = Promise.allSettled([
          issue(() => provider.suspendUser(userId)), issue(() => qqLogin.suspendUser(userId)), issue(() => cancelUserJobs(userId, ids)),
          issue(() => yybRoutes.suspendUserState(userId)),
        ]).then(results => {
          const failures = results.filter(result => result.status === 'rejected');
          if (failures.length) throw new Error('部分后台任务停止失败，将继续重试');
          logger.info('用户后台权限已撤销', { userId, reason: rejection.reason });
        });
      } else {
        blocked.delete(userId);
        work = issue(() => { qqLogin.resumeUser(userId); yybRoutes.resumeUserState(userId); return provider.resumeUser(userId); });
      }
      const operation = Promise.resolve(work).catch(error => {
        // Retrying a failed transition must not clear the authoritative access check.
        if (rejection) blocked.delete(userId); else blocked.add(userId);
        logger.error('同步用户后台权限失败', { userId, error: error.message });
        throw error;
      }).finally(() => { if (pending.get(userId) === operation) pending.delete(userId); });
      pending.set(userId, operation);
    }
    return Promise.all([...pending.values()]);
  }

  function start() {
    if (timer || closed) return;
    const tick = () => {
      try { reconcile().catch(() => {}); }
      catch (error) { logger.error('检查用户后台权限失败', { error: error.message }); }
    };
    tick();
    timer = setInterval(tick, 1000);
    timer.unref?.();
  }
  function close() { closed = true; clearInterval(timer); timer = null; }
  return { reconcile, start, close };
}

module.exports = { createUserAccessMonitor };
