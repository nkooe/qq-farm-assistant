const { getAccessPolicy, getUserAccessRejection } = require('../models/access-policy');

function getClientIp(req) {
  const remoteAddress = req.socket?.remoteAddress;
  if (remoteAddress?.startsWith("::ffff:")) return remoteAddress.substring(7);
  return remoteAddress || "unknown";
}

function registerAdminAuthRoutes({
  app,
  logger,
  userStore,
  requireAdminToken,
  createAdminSession,
  updateAdminSessions,
  invalidateAdminSessions,
}) {
  app.get('/api/public/access-policy', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, data: getAccessPolicy() });
  });
  app.post("/api/login", (req, res) => {
    const { username, password } = req.body || {};
    const ip = getClientIp(req);
    const userAgent = req.headers["user-agent"] || "";

    if (!username || !password) {
      return res.status(401).json({ ok: false, error: "请输入用户名和密码" });
    }

    const validationResult = userStore.validateUser(username, password, ip);
    const loginUserId = userStore.getUserByUsername(username)?.id ?? null;
    if (validationResult && validationResult.error) {
      const status =
        validationResult.error === "rate_limit"
          ? 429
          : validationResult.error === "locked"
            ? 423
            : 401;
      logger.warn("登录失败", {
        userId: loginUserId,
        error: validationResult.error,
        ip,
        message: validationResult.message,
      });
      userStore.addLoginLog(
        "login_failed",
        username,
        validationResult.error,
        ip,
        userAgent,
      );
      return res.status(status).json({
        ok: false,
        error: validationResult.message,
        errorType: validationResult.error,
        remainingMs: validationResult.remainingMs,
      });
    }

    if (!validationResult) {
      logger.warn("登录失败", {
        userId: loginUserId,
        ip,
        reason: "invalid_credentials",
      });
      userStore.addLoginLog(
        "login_failed",
        username,
        "invalid_credentials",
        ip,
        userAgent,
      );
      return res.status(401).json({ ok: false, error: "用户名或密码错误" });
    }

    const rejection = getUserAccessRejection(validationResult);
    if (rejection) {
      logger.warn("登录拒绝", { userId: validationResult.id, reason: rejection.reason });
      return res.status(403).json({ ok: false, error: rejection.error, errorType: rejection.reason });
    }

    userStore.addLoginLog("login_success", username, null, ip, userAgent);
    const token = createAdminSession(validationResult);
    return res.json({
      ok: true,
      data: {
        token,
        role: validationResult.role,
        card: validationResult.card,
        cardVerificationEnabled: getAccessPolicy().cardVerificationEnabled,
        accountLimit:
          validationResult.accountLimit || userStore.DEFAULT_ACCOUNT_LIMIT || 2,
        user: { id: validationResult.id, username: validationResult.username },
        mustChangePassword: validationResult.mustChangePassword || false,
      },
    });
  });

  app.post("/api/register", (req, res) => {
    const { username, password, cardCode } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: "请填写完整信息" });
    }

    const result = userStore.registerUser(username, password, cardCode);
    if (!result.ok) return res.status(400).json(result);
    res.json({ ok: true, data: result.user });
  });

  app.get("/api/card/info/:code", (req, res) => {
    try {
      const { code } = req.params;
      const card = userStore.getAllCards().find((item) => item.code === code);
      if (!card) {
        return res.status(404).json({ ok: false, error: "卡密不存在" });
      }
      if (!card.enabled) {
        return res.status(400).json({ ok: false, error: "卡密已被禁用" });
      }
      if (card.usedBy) {
        return res.status(400).json({ ok: false, error: "卡密已被使用" });
      }

      res.json({
        ok: true,
        data: {
          type: card.type || "time",
          days: card.days,
          value: card.value,
          durationValue: card.durationValue,
          durationUnit: card.durationUnit,
          durationMs: card.durationMs,
          isPermanent: card.isPermanent === true || card.days === -1,
          description: card.description,
        },
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/user/renew", requireAdminToken, (req, res) => {
    const { cardCode } = req.body || {};
    const userId = req.currentUser?.id;
    if (!userId) {
      return res.status(401).json({ ok: false, error: "未登录" });
    }
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
    res.json({
      ok: true,
      data: {
        card: result.card,
        accountLimit: result.accountLimit,
        cardType: result.cardType,
      },
    });
  });

  app.post("/api/public/renew", (req, res) => {
    try {
      const ip = getClientIp(req);
      const { username, password, cardCode } = req.body || {};
      if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
        return res.status(400).json({ ok: false, error: "请提供用户名和账号密码" });
      }
      if (!cardCode) {
        return res.status(400).json({ ok: false, error: "请提供卡密" });
      }

      // Expired users can prove their identity without receiving a panel session.
      const user = userStore.validateUser(username, password, ip);
      if (!user || user.error) {
        return res.status(user?.error === 'rate_limit' ? 429 : user?.error === 'locked' ? 423 : 401).json({
          ok: false, error: user?.message || '用户名或密码错误', errorType: user?.error,
          remainingMs: user?.remainingMs,
        });
      }
      if (user.role !== 'user' || user.deleting || user.card?.enabled === false) {
        return res.status(403).json({ ok: false, error: '该账号不支持公开续费，请联系管理员' });
      }
      const result = userStore.renewUser(user.id, cardCode);
      if (!result.ok) return res.status(400).json(result);

      logger.info("公开续费成功", { userId: user.id, cardType: result.cardType, ip });
      res.json({
        ok: true,
        data: {
          card: result.card ? Object.fromEntries(Object.entries(result.card).filter(([key]) => !['code', 'description'].includes(key))) : null,
          accountLimit: result.accountLimit,
          cardType: result.cardType,
        },
      });
    } catch (error) {
      logger.error("公开续费失败", { error: error.message });
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/public/reset-password/verify", (req, res) => {
    try {
      const ip = getClientIp(req);
      const rateLimit = userStore.checkRateLimit(ip);
      if (!rateLimit.allowed) {
        return res.status(429).json({
          ok: false,
          error: rateLimit.message,
          errorType: "rate_limit",
          remainingMs: rateLimit.remainingMs,
        });
      }

      const { username, cardCode } = req.body || {};
      if (!username || !cardCode) {
        return res.status(400).json({ ok: false, error: "请提供用户名和卡密" });
      }

      const result = userStore.verifyCardOwnership(username, cardCode);
      if (!result.ok) return res.status(400).json(result);
      res.json({ ok: true });
    } catch (error) {
      logger.error("找回密码验证失败", { error: error.message });
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/public/reset-password/confirm", (req, res) => {
    try {
      const ip = getClientIp(req);
      const rateLimit = userStore.checkRateLimit(ip);
      if (!rateLimit.allowed) {
        return res.status(429).json({
          ok: false,
          error: rateLimit.message,
          errorType: "rate_limit",
          remainingMs: rateLimit.remainingMs,
        });
      }

      const { username, cardCode, newPassword } = req.body || {};
      if (!username || !cardCode || !newPassword) {
        return res
          .status(400)
          .json({ ok: false, error: "请提供用户名、卡密和新密码" });
      }

      const result = userStore.resetPasswordByCard(
        username,
        cardCode,
        newPassword,
      );
      if (!result.ok) return res.status(400).json(result);

      const userId = userStore.getUserByUsername(username).id;
      invalidateAdminSessions(session => session.id === userId);
      logger.info("找回密码重置成功", { userId, ip });
      res.json({ ok: true, message: result.message });
    } catch (error) {
      logger.error("找回密码重置失败", { error: error.message });
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/user/change-password", requireAdminToken, (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    const userId = req.currentUser?.id;
    if (!userId) {
      return res.status(401).json({ ok: false, error: "未登录" });
    }
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ ok: false, error: "请提供原密码和新密码" });
    }

    const result = userStore.changePassword(userId, oldPassword, newPassword);
    if (result.ok) invalidateAdminSessions(session => session.id === userId);
    res.json(result);
  });
}

module.exports = { registerAdminAuthRoutes };
