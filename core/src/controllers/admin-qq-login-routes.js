const { QqScanError } = require('../services/qq-login-service');
const { proxySetting, resolveProxyURL, createSocksBridge } = require('../services/account-proxy');
const { createQqAccountImporter, getQqUpdateTarget } = require('../services/qq-account-import');

function registerAdminQqLoginRoutes({ app, requireAdminToken, qqLogin, provider, addOrUpdateAccount, userStore, resolveProxy = resolveProxyURL, bridgeProxy = createSocksBridge, probe }) {
  const importer = createQqAccountImporter({ qqLogin, provider, addOrUpdateAccount, userStore, probe });
  const owner = req => `${req.currentUser.username}:${req.adminToken}`;
  const run = handler => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { await handler(req, res); }
    catch (error) {
      res.status(error instanceof QqScanError ? error.status : 503).json({ ok: false,
        error: error instanceof QqScanError ? error.message : 'QQ 扫码服务暂时不可用，请稍后重试' });
    }
  };
  app.get('/api/qq-login/status', requireAdminToken, run((_req, res) => res.json({ ok: true, data: qqLogin.status() })));
  app.post('/api/qq-login/sessions', requireAdminToken, run(async (req, res) => {
    const target = getQqUpdateTarget(provider, req.currentUser.username, req.body?.targetAccountId);
    let setting;
    try { setting = proxySetting({ ...(target ? { proxyMode: target.proxyMode, proxyProfileId: target.proxyProfileId } : {}), ...req.body }); } catch { throw new QqScanError('请选择有效的代理配置'); }
    const proxyURL = await resolveProxy(setting);
    const proxyBridge = proxyURL ? await bridgeProxy(proxyURL) : null;
    try {
      res.status(201).json({ ok: true, data: qqLogin.create(owner(req), { ...setting, proxyURL, proxyBridge, nativeProxyURL: proxyBridge?.url || '', targetAccountId: target ? String(target.id) : '' }) });
    } catch (error) { proxyBridge?.close(); throw error; }
  }));
  app.post('/api/qq-login/sessions/:id/import', requireAdminToken, run(async (req, res) => res.json({ ok: true, data: await importer(req) })));
  app.get('/api/qq-login/sessions/:id', requireAdminToken, run((req, res) => res.json({ ok: true, data: qqLogin.get(owner(req), req.params.id) })));
  app.delete('/api/qq-login/sessions/:id', requireAdminToken, run((req, res) => { qqLogin.cancel(owner(req), req.params.id); res.json({ ok: true }); }));
}

module.exports = { registerAdminQqLoginRoutes };
