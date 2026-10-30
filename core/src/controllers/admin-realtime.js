function createAdminRealtime({ provider, getIo, getSession, getSessionRejection, getAccessibleAccountIdsForUser, resolveAccountReference }) {
  function identity(socket) {
    const user = getSession(socket.data.adminToken);
    if (!require('../models/user-id').isUserIdentity(user) || getSessionRejection(user)) {
      socket.disconnect(true);
      return null;
    }
    return user;
  }
  function accessibleIds(user) {
    return new Set(getAccessibleAccountIdsForUser(user).map(String));
  }
  function filterLogs(logs, user, ids) {
    if (!Array.isArray(logs)) throw new Error('日志响应格式无效');
    return logs.filter(log => {
      const id = String(log.accountId || '');
      return id ? ids.has(id) : user.role === 'admin';
    });
  }
  function snapshot(socket, user, ids) {
    const accountId = socket.data.accountId;
    if (accountId) {
      socket.emit('status:update', { accountId, status: provider.getStatus(accountId) });
    }
    socket.emit('logs:snapshot', {
      accountId: accountId || 'all',
      logs: filterLogs(provider.getLogs(accountId, { limit: 100 }), user, ids),
    });
    const logs = filterLogs(provider.getAccountLogs(100), user, ids);
    socket.emit('account-logs:snapshot', { logs: accountId ? logs.filter(log => String(log.accountId) === accountId) : logs });
  }
  function subscribe(socket, ref = '') {
    const user = identity(socket);
    if (!user) return;
    const ids = accessibleIds(user);
    const accountId = ref && ref !== 'all' ? resolveAccountReference(ref) : '';
    if ((ref && ref !== 'all' && !accountId) || (accountId && !ids.has(String(accountId)))) {
      socket.emit('subscribed', { error: '无权访问此账号' });
      socket.disconnect(true);
      return;
    }
    socket.data.accountId = accountId;
    socket.emit('subscribed', { accountId: accountId || 'all' });
    snapshot(socket, user, ids);
  }
  function forSubscribers(accountId, send) {
    const io = getIo();
    if (!io) return;
    for (const socket of io.sockets.sockets.values()) {
      const user = identity(socket);
      if (!user) continue;
      const ids = accessibleIds(user);
      const selected = socket.data.accountId;
      if (selected && !ids.has(String(selected))) {
        socket.disconnect(true);
        continue;
      }
      if (!accountId) { if (selected || user.role !== 'admin') continue; }
      else if ((selected && selected !== String(accountId)) || !ids.has(String(accountId))) continue;
      send(socket, user, ids);
    }
  }
  function emit(accountId, event, payload) {
    forSubscribers(String(accountId), socket => socket.emit(event, payload));
  }
  function refreshLogs(accountId) {
    forSubscribers(String(accountId), snapshot);
  }
  return { subscribe, emit, refreshLogs };
}

module.exports = { createAdminRealtime };
