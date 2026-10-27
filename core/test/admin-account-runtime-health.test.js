const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAdminAccountRuntimeRoutes } = require('../src/controllers/admin-account-runtime-routes');

function harness(access = true) {
  const routes = new Map();
  const runtime = { state: 'starting', connected: false, running: true, error: '' };
  const account = { id: '1', yybOpenid: 'wx-a' };
  registerAdminAccountRuntimeRoutes({
    app: { get: (path, handler) => routes.set(`GET ${path}`, handler), post: (path, handler) => routes.set(`POST ${path}`, handler) },
    provider: { getAccounts: () => ({ accounts: [account] }), getAccountRuntime: () => runtime, startAccount: () => true },
    resolveAccountReference: id => id,
    canAccessAccount: () => access,
  });
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  return { routes, runtime, res, req: { params: { id: '1' } } };
}

test('startup returns accepted and runtime remains starting until a real connection', async () => {
  const h = harness();
  h.routes.get('POST /api/accounts/:id/start')(h.req, h.res);
  assert.equal(h.res.statusCode, 202);
  assert.equal(h.res.body.data.state, 'starting');
  h.routes.get('GET /api/accounts/:id/runtime')(h.req, h.res);
  assert.equal(h.res.body.data.connected, false);
  h.runtime.connected = true;
  h.runtime.state = 'online';
  h.routes.get('GET /api/accounts/:id/runtime')(h.req, h.res);
  assert.equal(h.res.body.data.connected, true);
});

test('account health enforces access before querying any YYB data', async (t) => {
  const h = harness(false);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; });
  await h.routes.get('GET /api/accounts/:id/health')(h.req, h.res);
  assert.equal(h.res.statusCode, 403);
  assert.equal(calls, 0);
});

test('health separates unavailable YYB service from a running game and hides upstream secrets', async (t) => {
  const h = harness();
  const savedUrl = process.env.YYB_API_URL;
  const savedKey = process.env.YYB_API_KEY;
  process.env.YYB_API_URL = 'http://yyb.test';
  process.env.YYB_API_KEY = 'secret-test-key';
  t.after(() => {
    if (savedUrl === undefined) delete process.env.YYB_API_URL; else process.env.YYB_API_URL = savedUrl;
    if (savedKey === undefined) delete process.env.YYB_API_KEY; else process.env.YYB_API_KEY = savedKey;
  });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('http://user:secret@proxy.test secret-test-key'); });
  h.runtime.state = 'online';
  h.runtime.connected = true;
  await h.routes.get('GET /api/accounts/:id/health')(h.req, h.res);
  assert.equal(h.res.statusCode, 200);
  assert.equal(h.res.body.data.runtime.connected, true);
  assert.equal(h.res.body.data.yyb.available, false);
  assert.equal(h.res.body.data.credentials, null);
  assert.doesNotMatch(JSON.stringify(h.res.body), /secret/);
});
