const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAdminYybRoutes } = require('../src/controllers/admin-yyb-routes');

function registeredRoutes() {
  const routes = new Map();
  const app = {
    get(path, _auth, handler) { routes.set(`GET ${path}`, handler); },
    post(path, _auth, handler) { routes.set(`POST ${path}`, handler); },
    put(path, _auth, handler) { routes.set(`PUT ${path}`, handler); },
    delete(path, _auth, handler) { routes.set(`DELETE ${path}`, handler); },
  };
  registerAdminYybRoutes({
    app,
    requireAdminToken() {},
  });
  return routes;
}

function pollHandler() {
  return registeredRoutes().get('POST /api/yyb/qr/poll');
}

async function poll() {
  const response = {
    statusCode: 200,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
  await pollHandler()({ body: { apiBase: 'http://yyb.test', apiKey: 'test-token', sessionId: 'test-session' } }, response);
  return response;
}

test('QR proxy preserves waiting, scanned and unknown states without marking them expired', async (t) => {
  for (const status of ['pending', 'scanned', 'unknown']) {
    t.mock.method(globalThis, 'fetch', async () => ({
      status: 200,
      json: async () => ({ code: 0, data: { status, errcode: status === 'pending' ? 408 : 404 } }),
    }));
    const response = await poll();
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.data.status, status);
    t.mock.restoreAll();
  }
});

test('QR proxy exposes upstream unavailability as a retryable HTTP failure', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    status: 502,
    json: async () => ({ code: 502, msg: 'upstream unavailable', data: null }),
  }));
  const response = await poll();
  assert.equal(response.statusCode, 502);
  assert.equal(response.body.ok, false);
});

test('QR proxy exposes network timeout as retryable instead of a bad request', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('request timed out'); });
  const response = await poll();
  assert.equal(response.statusCode, 502);
  assert.equal(response.body.ok, false);
});

test('QR create forwards the selected static proxy profile', async (t) => {
  let forwardedBody = null;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    forwardedBody = JSON.parse(init.body);
    return {
      status: 200,
      json: async () => ({ code: 0, data: { session_id: 'session-1', status: 'pending' } }),
    };
  });

  const response = {
    statusCode: 200,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
  const handler = registeredRoutes().get('POST /api/yyb/qr/create');
  await handler({
    body: {
      apiBase: 'http://yyb.test',
      apiKey: 'test-token',
      proxyMode: 'static',
      proxyProfileId: 7,
    },
  }, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(forwardedBody, { proxy_mode: 'static', proxy_profile_id: 7 });
});

test('getcode preserves transient failures as retryable and token rejection as rescan', async (t) => {
  for (const status of [502, 409]) {
    t.mock.method(globalThis, 'fetch', async () => ({ status, json: async () => ({ code: status, msg: 'test failure' }) }));
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await registeredRoutes().get('POST /api/yyb/getcode')({ body: { apiBase: 'http://yyb.test', apiKey: 'test-token', openid: 'wx-a' } }, res);
    assert.equal(res.statusCode, status);
    assert.equal(res.body.retryable, status === 502);
    assert.equal(res.body.needsRescan, status === 409);
    t.mock.restoreAll();
  }
});
