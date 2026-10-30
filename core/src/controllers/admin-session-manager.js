const { isUserIdentity } = require('../models/user-id');
const crypto = require('node:crypto');
const { getUserAccessRejection } = require('../models/access-policy');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_USER_SESSIONS = 10;

function createAdminSessionManager({ logger, getIo, getUser, now = Date.now }) {
  if (typeof getUser !== 'function') throw new Error('Session manager requires an authoritative user lookup');
  const adminTokens = new Set();
  const adminSessions = new Map();
  const sessionExpirations = new Map();

  function generateAdminToken() {
    return crypto.randomBytes(24).toString('hex');
  }

  function sendUnauthorized(res) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized',
    });
  }

  function logAdminSessionRejected(reason, userId) {
    logger.warn('admin session rejected', {
      reason,
      userId,
    });
  }

  function logAdminSessionEvent(event, reason, userId) {
    logger.info(event, {
      reason,
      userId,
    });
  }

  function createAdminSession(user) {
    if (!isUserIdentity(user)) {
      throw new Error('无效的用户角色');
    }
    for (const [token, expiresAt] of sessionExpirations) {
      if (expiresAt <= now()) invalidateAdminSessionAndDisconnect(token);
    }
    const ownTokens = [...adminSessions].filter(([, session]) => session.id === user.id).map(([token]) => token);
    while (ownTokens.length >= MAX_USER_SESSIONS) invalidateAdminSessionAndDisconnect(ownTokens.shift());
    const token = generateAdminToken();
    adminTokens.add(token);
    adminSessions.set(token, user);
    sessionExpirations.set(token, now() + SESSION_TTL_MS);
    return token;
  }

  function invalidateAdminSession(token) {
    adminTokens.delete(token);
    adminSessions.delete(token);
    sessionExpirations.delete(token);
  }

  function disconnectAdminTokenSockets(token) {
    const io = typeof getIo === 'function' ? getIo() : null;
    if (!io) return;
    for (const socket of io.sockets.sockets.values()) {
      String(socket.data.adminToken || '') === String(token)
        && socket.disconnect(true);
    }
  }

  function invalidateAdminSessionAndDisconnect(token) {
    invalidateAdminSession(token);
    disconnectAdminTokenSockets(token);
  }

  function invalidateAdminSessions(predicate) {
    for (const [token, session] of adminSessions.entries()) {
      if (predicate(session, token))
        invalidateAdminSessionAndDisconnect(token);
    }
  }

  function updateAdminSessions(predicate, updateSession) {
    for (const [token, session] of adminSessions.entries()) {
      if (predicate(session, token)) {
        updateSession(session, token);
        adminSessions.set(token, session);
      }
    }
  }

  function getAdminSessionRejection(currentUser) {
    return getUserAccessRejection(currentUser);
  }

  function requireAdminToken(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!token || !adminTokens.has(token))
      return sendUnauthorized(res);
    req.adminToken = token;
    req.currentUser = getSession(token);
    const rejection = getAdminSessionRejection(req.currentUser);
    if (rejection) {
      logAdminSessionRejected(rejection.reason, adminSessions.get(token)?.id);
      invalidateAdminSessionAndDisconnect(token);
      return res.status(403).json({
        ok: false,
        error: rejection.error,
        errorType: rejection.reason,
      });
    }
    next();
  }

  function cleanupInvalidAdminSessions() {
    const expiredSessions = [];
    for (const [token, session] of adminSessions.entries()) {
      const rejection = getAdminSessionRejection(getSession(token));
      if (!rejection) continue;
      logAdminSessionEvent(
        'admin session cleanup queued',
        rejection.reason,
        session?.id,
      );
      expiredSessions.push({
        token,
        userId: session?.id,
        reason: rejection.reason,
      });
    }
    for (const { token, userId, reason } of expiredSessions) {
      invalidateAdminSessionAndDisconnect(token);
      logAdminSessionEvent('admin session force logout', reason, userId);
    }
  }

  function hasToken(token) {
    return !!getSession(token);
  }

  function getSession(token) {
    const session = adminSessions.get(token);
    if (session && sessionExpirations.get(token) <= now()) {
      invalidateAdminSessionAndDisconnect(token);
      return null;
    }
    return session ? getUser(session.id) : null;
  }

  return {
    cleanupInvalidAdminSessions,
    createAdminSession,
    getSession,
    getAdminSessionRejection,
    hasToken,
    invalidateAdminSessionAndDisconnect,
    invalidateAdminSessions,
    requireAdminToken,
    updateAdminSessions,
  };
}

module.exports = {
  createAdminSessionManager,
  SESSION_TTL_MS,
  MAX_USER_SESSIONS,
};
