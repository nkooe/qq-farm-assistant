const { callYybApi, resolveYybCreds } = require('./admin-yyb-routes');

function registerAdminAccountRuntimeRoutes({
  app,
  provider,
  resolveAccountReference,
  canAccessAccount,
}) {
  app.get("/api/accounts/:id/health", async (req, res) => {
    try {
      const accountId = resolveAccountReference(req.params.id);
      if (!canAccessAccount(req, accountId)) return res.status(403).json({ ok: false, error: "无权访问此账号" });
      const account = provider.getAccounts().accounts.find(item => String(item.id) === String(accountId));
      if (!account) return res.status(404).json({ ok: false, error: "账号不存在" });
      const runtime = provider.getAccountRuntime(accountId);
      if (!account.yybOpenid || account.provider === 'thirdparty') {
        return res.json({ ok: true, data: { runtime, yyb: null, supported: false } });
      }
      const { apiBase, apiKey } = resolveYybCreds();
      const [service, credentials] = await Promise.all([
        callYybApi(apiBase, '/health', apiKey, { signal: AbortSignal.timeout(4000) }),
        callYybApi(apiBase, `/accounts/health?ref=${encodeURIComponent(account.yybOpenid)}`, apiKey, { signal: AbortSignal.timeout(4000) }),
      ]);
      return res.json({ ok: true, data: {
        runtime, supported: true,
        yyb: { available: !!(service.ok && service.data?.ok), checkedAt: Date.now(), error: service.ok ? '' : '应用宝服务暂时不可用' },
        credentials: credentials.ok ? credentials.data : null,
        credentialError: credentials.ok ? '' : '凭据健康信息读取失败，请稍后重试',
      } });
    } catch {
      return res.status(500).json({ ok: false, error: "账号健康信息读取失败，请稍后重试" });
    }
  });

  app.get("/api/accounts/:id/runtime", (req, res) => {
    try {
      const accountId = resolveAccountReference(req.params.id);
      if (!canAccessAccount(req, accountId)) return res.status(403).json({ ok: false, error: "无权访问此账号" });
      const runtime = provider.getAccountRuntime(accountId);
      if (!runtime) return res.status(404).json({ ok: false, error: "账号不存在" });
      return res.json({ ok: true, data: runtime });
    } catch {
      return res.status(500).json({ ok: false, error: "账号运行状态读取失败，请稍后重试" });
    }
  });

  app.post("/api/accounts/:id/start", (req, res) => {
    try {
      const accountId = resolveAccountReference(req.params.id);
      if (!canAccessAccount(req, accountId)) {
        return res.status(403).json({ ok: false, error: "无权访问此账号" });
      }

      const started = provider.startAccount(accountId);
      if (!started) {
        return res.status(404).json({ ok: false, error: "Account not found" });
      }

      res.status(202).json({ ok: true, data: { state: "starting", message: "已接受启动请求，请以游戏连接状态为准" } });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/accounts/:id/stop", (req, res) => {
    try {
      const accountId = resolveAccountReference(req.params.id);
      if (!canAccessAccount(req, accountId)) {
        return res.status(403).json({ ok: false, error: "无权访问此账号" });
      }

      const stopped = provider.stopAccount(accountId);
      if (!stopped) {
        return res.status(404).json({ ok: false, error: "Account not found" });
      }

      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });
}

module.exports = { registerAdminAccountRuntimeRoutes };
