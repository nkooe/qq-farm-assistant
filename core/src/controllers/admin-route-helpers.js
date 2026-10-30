const { ADMIN_USER_ID, assertUserId, isUserIdentity } = require('../models/user-id');
function toBooleanFlag(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function createAdminRouteHelpers({ userStore }) {
  function requireDangerConfirmation(req, res, requiredConfirmation) {
    const confirmed = req && req.body ? toBooleanFlag(req.body.confirmed) : false;
    if (!confirmed) {
      return (
        res.status(400).json({
          ok: false,
          error: '危险操作未确认',
          requiredConfirmation,
        }),
        false
      );
    }
    return true;
  }

  function getAdminUserMutationError(currentUser, targetUserId) {
    assertUserId(targetUserId);
    if (!isUserIdentity(currentUser) || currentUser.id !== ADMIN_USER_ID) return '需要管理员权限';
    return null;
  }

  function isExpectedProviderError(err) {
    const message = String((err && err.message) || '');
    return message === '账号未运行' || message === 'API Timeout';
  }

  function sendProviderError(res, err) {
    if (res.headersSent || res.writableEnded || res.destroyed || res.locals?.requestTimedOut)
      return;

    if (isExpectedProviderError(err)) {
      return res.json({
        ok: false,
        error: err.message,
      });
    }
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }

  function requireAdminRole(req, res, next) {
    if (!isUserIdentity(req.currentUser) || req.currentUser.id !== ADMIN_USER_ID) {
      return res.status(403).json({
        ok: false,
        error: '需要管理员权限',
      });
    }
    next();
  }

  return {
    getAdminUserMutationError,
    requireAdminRole,
    requireDangerConfirmation,
    sendProviderError,
  };
}

module.exports = {
  createAdminRouteHelpers,
};
