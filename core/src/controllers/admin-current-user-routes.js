const { getAccessPolicy } = require('../models/access-policy');

function requireCurrentUser(req, res) {
  const currentUser = req.currentUser;
  if (!currentUser) {
    res.status(401).json({ ok: false, error: "未登录" });
    return null;
  }
  return currentUser;
}

function registerAdminCurrentUserRoutes({
  app,
  requireAdminToken,
  requireAdminRole,
  userStore,
  store,
}) {
  app.get("/api/user/me", requireAdminToken, (req, res) => {
    try {
      const currentUser = requireCurrentUser(req, res);
      if (!currentUser) return;

      res.json({
        ok: true,
        data: {
          id: currentUser.id,
          username: currentUser.username,
          role: currentUser.role,
          card: currentUser.card,
          cardVerificationEnabled: getAccessPolicy().cardVerificationEnabled,
          accountLimit:
            currentUser.accountLimit || userStore.DEFAULT_ACCOUNT_LIMIT || 2,
        },
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post(
    "/api/user/wxlogin-config",
    requireAdminToken,
    (req, res) => {
      try {
        const currentUser = requireCurrentUser(req, res);
        if (!currentUser) return;

        const config = store.setUserWxConfig(req.body || {}, currentUser.id);
        res.json({ ok: true, config });
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    },
  );

  app.get("/api/user/wxlogin-config", requireAdminToken, (req, res) => {
    try {
      const currentUser = requireCurrentUser(req, res);
      if (!currentUser) return;

      res.json({ ok: true, config: store.getUserWxConfig(currentUser.id) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/user/device-protocol", requireAdminToken, (req, res) => {
    try {
      const currentUser = requireCurrentUser(req, res);
      if (!currentUser) return;

      const config = store.setUserDeviceProtocol(
        req.body || {},
        currentUser.id,
      );
      res.json({ ok: true, config });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/user/device-protocol", requireAdminToken, (req, res) => {
    try {
      const currentUser = requireCurrentUser(req, res);
      if (!currentUser) return;

      res.json({
        ok: true,
        config: store.getUserDeviceProtocol(currentUser.id),
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });
}

module.exports = { registerAdminCurrentUserRoutes };
