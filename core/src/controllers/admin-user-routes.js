const { parseUserId } = require('../models/user-id');
function registerAdminUserRoutes({
  app,
  requireAdminToken,
  requireAdminRole,
  requireDangerConfirmation,
  getAdminUserMutationError,
  userStore,
  adminLogger,
  invalidateAdminSessions,
  updateAdminSessions,
  deleteUserData,
  enforceUserAccess,
}) {
  app.get("/api/admin/users", requireAdminToken, requireAdminRole, (req, res) => {
    try {
      res.json({ ok: true, data: userStore.getAllUsers() });
    } catch (error) {
      res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  app.post(
    "/api/admin/users/clear-expired",
    requireAdminToken,
    requireAdminRole,
    async (req, res) => {
      try {
        if (!requireDangerConfirmation(req, res, "CLEAR_EXPIRED_USERS")) return;
        const deletedUsers = [];
        for (const userId of userStore.getExpiredUserIds()) {
          await deleteUserData(userId);
          deletedUsers.push(userId);
        }
        const result = { ok: true, deletedCount: deletedUsers.length, deletedUsers };
        if (result.ok && result.deletedCount > 0) {
          for (const userId of result.deletedUsers) {
            invalidateAdminSessions((session) => session.id === userId);
          }
          adminLogger.info("清理到期用户", {
            admin: req.currentUser.id,
            deletedCount: result.deletedCount,
          });
        }
        res.json(result);
      } catch (error) {
        res.status(error.status || 500).json({ ok: false, error: error.message });
      }
    },
  );

  app.post(
    "/api/admin/users/:userId",
    requireAdminToken,
    requireAdminRole,
    async (req, res) => {
      try {
        if (!requireDangerConfirmation(req, res, "UPDATE_USER_STATUS")) return;
        const userId = parseUserId(req.params.userId);
        const mutationError = getAdminUserMutationError(
          req.currentUser,
          userId,
        );
        if (mutationError) {
          return res.status(403).json({ ok: false, error: mutationError });
        }

        const user = userStore.updateUser(userId, req.body || {});
        if (!user) {
          return res.status(404).json({ ok: false, error: "用户不存在" });
        }
        invalidateAdminSessions(session => session.id === userId);
        if (enforceUserAccess) await enforceUserAccess();

        adminLogger.warn("更新用户状态", {
          admin: req.currentUser?.id || "",
          userId,
          enabled: user && user.card ? user.card.enabled !== false : null,
          expiresAt: user && user.card ? user.card.expiresAt || null : null,
          confirmation: "UPDATE_USER_STATUS",
        });
        res.json({ ok: true, data: user });
      } catch (error) {
        res.status(error.status || 500).json({ ok: false, error: error.message });
      }
    },
  );

  app.post(
    "/api/admin/users/:userId/edit",
    requireAdminToken,
    requireAdminRole,
    async (req, res) => {
      try {
        if (!requireDangerConfirmation(req, res, "EDIT_USER")) return;
        const userId = parseUserId(req.params.userId);
        const mutationError = getAdminUserMutationError(
          req.currentUser,
          userId,
        );
        if (mutationError) {
          return res.status(403).json({ ok: false, error: mutationError });
        }

        const {
          newUsername,
          password,
          accountLimit,
          expiresAt,
          isPermanent,
        } = req.body || {};
        const result = userStore.editUser(userId, {
          newUsername,
          password,
          accountLimit,
          expiresAt,
          isPermanent,
        });
        if (!result.ok) return res.status(400).json(result);
        if (password) invalidateAdminSessions(session => session.id === userId);
        if (enforceUserAccess) await enforceUserAccess();

        adminLogger.warn("编辑用户资料", {
          admin: req.currentUser?.id || "",
          userId,
          newUsername: result.user?.username,
          changedPassword: !!String(password || "").trim(),
          accountLimit: result.user?.accountLimit || accountLimit || null,
          isPermanent: isPermanent === true,
          expiresAt: expiresAt ?? null,
          confirmation: "EDIT_USER",
        });
        updateAdminSessions(
          (session) =>
            session.id === userId,
          (session) => {
            session.username = result.user.username;
            session.card = result.user.card;
            session.accountLimit = result.user.accountLimit;
          },
        );
        res.json({ ok: true, data: result.user });
      } catch (error) {
        res.status(error.status || 500).json({ ok: false, error: error.message });
      }
    },
  );

  app.delete(
    "/api/admin/users/:userId",
    requireAdminToken,
    requireAdminRole,
    async (req, res) => {
      try {
        if (!requireDangerConfirmation(req, res, "DELETE_USER")) return;
        const userId = parseUserId(req.params.userId);
        const currentUser = req.currentUser;
        if (currentUser && currentUser.id === userId) {
          return res
            .status(400)
            .json({ ok: false, error: "不能删除自己的账号" });
        }

        const mutationError = getAdminUserMutationError(currentUser, userId);
        if (mutationError) {
          return res.status(403).json({ ok: false, error: mutationError });
        }

        const result = await deleteUserData(userId);
        if (!result.ok) return res.status(400).json(result);

        adminLogger.warn("删除用户", {
          admin: req.currentUser?.id || "",
          confirmation: "DELETE_USER",
        });
        invalidateAdminSessions((session) => session.id === userId);
        res.json({ ok: true });
      } catch (error) {
        res.status(error.status || 500).json({ ok: false, error: error.message });
      }
    },
  );

  app.post(
    "/api/admin/users/:userId/renew",
    requireAdminToken,
    requireAdminRole,
    (req, res) => {
      try {
        if (!requireDangerConfirmation(req, res, "RENEW_USER")) return;
        const userId = parseUserId(req.params.userId);
        const { cardCode } = req.body || {};
        if (!cardCode) {
          return res.status(400).json({ ok: false, error: "请提供卡密" });
        }

        const result = userStore.renewUser(userId, cardCode);
        if (!result.ok) return res.status(400).json(result);

        updateAdminSessions(
          (session) => session.id === userId,
          (session) => {
            session.card = result.card;
            session.accountLimit = result.accountLimit;
          },
        );
        const data = {
          card: result.card,
          accountLimit: result.accountLimit,
          cardType: result.cardType,
        };
        adminLogger.warn("用户续费", {
          admin: req.currentUser?.id || "",
          userId,
          cardCode,
          cardType: result.cardType || null,
          accountLimit: result.accountLimit ?? null,
          confirmation: "RENEW_USER",
        });
        res.json({ ok: true, data });
      } catch (error) {
        res.status(error.status || 500).json({ ok: false, error: error.message });
      }
    },
  );
}

module.exports = { registerAdminUserRoutes };
