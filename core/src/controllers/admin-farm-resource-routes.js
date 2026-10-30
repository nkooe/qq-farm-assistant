const { getLevelExpProgress } = require("../config/gameConfig");
const { normalizeFertilizerCheckOptions } = require("../services/mall");

function sendMissingAccount(res, statusCode = 400) {
  const payload = { ok: false, error: "Missing x-account-id" };
  return statusCode ? res.status(statusCode).json(payload) : res.json(payload);
}

function requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount, missingStatusCode = 400) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    sendMissingAccount(res, missingStatusCode);
    return null;
  }

  if (!canAccessAccount(req, accountId)) {
    res.status(403).json({ ok: false, error: "无权访问此账号" });
    return null;
  }

  return accountId;
}

function withLevelProgress(statusPayload) {
  if (statusPayload?.status) {
    const { level, exp } = statusPayload.status;
    statusPayload.levelProgress = getLevelExpProgress(level, exp);
  }
  return statusPayload;
}

function registerAdminFarmResourceRoutes({
  app,
  provider,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
}) {
  app.get("/api/status", async (req, res) => {
    const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount, null);
    if (!accountId)
      return;

    try {
      const status = withLevelProgress(provider.getStatus(accountId));
      res.json({ ok: true, data: status });
    }
    catch (error) {
      res.json({ ok: false, error: error.message });
    }
  });

  app.post("/api/automation", async (req, res) => {
    const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
    if (!accountId)
      return;

    try {
      let result = null;
      for (const [key, value] of Object.entries(req.body)) {
        result = await provider.setAutomation(accountId, key, value);
      }
      res.json({ ok: true, data: result || {} });
    }
    catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/fertilizer/buy", async (req, res) => {
    const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
    if (!accountId)
      return;

    try {
      const { type, count } = req.body || {};
      if (!["organic", "normal"].includes(type) || !Number.isSafeInteger(count) || count <= 0)
        return res.status(400).json({ ok: false, error: "化肥类型或购买数量无效" });
      const bought = await provider.buyFertilizer(accountId, type, count);
      res.json({ ok: true, bought });
    }
    catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/fertilizer/check-and-buy", async (req, res) => {
    const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
    if (!accountId)
      return;

    let options;
    try { options = normalizeFertilizerCheckOptions(req.body); }
    catch (error) { return res.status(400).json({ ok: false, error: error.message }); }
    try {
      const result = await provider.checkAndBuyFertilizer(
        accountId,
        options,
      );
      res.json({ ok: true, ...result });
    }
    catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/lands", async (req, res) => {
    const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
    if (!accountId)
      return;

    try {
      const lands = await provider.getLands(accountId);
      res.json({ ok: true, data: lands });
    }
    catch (error) {
      sendProviderError(res, error);
    }
  });
}

module.exports = { registerAdminFarmResourceRoutes };
