const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAdminYybRoutes } = require('../src/controllers/admin-yyb-routes');

function registeredRoutes(options = {}) {
  const routes = new Map();
  const app = {
    get(path, _auth, handler) { routes.set(`GET ${path}`, (req, res) => handler({ currentUser: { id: 1000, role: 'admin' }, ...req }, res)); },
    post(path, _auth, handler) { routes.set(`POST ${path}`, (req, res) => handler({ currentUser: { id: 1000, role: 'admin' }, ...req }, res)); },
    put(path, _auth, handler) { routes.set(`PUT ${path}`, (req, res) => handler({ currentUser: { id: 1000, role: 'admin' }, ...req }, res)); },
    delete(path, _auth, handler) { routes.set(`DELETE ${path}`, (req, res) => handler({ currentUser: { id: 1000, role: 'admin' }, ...req }, res)); },
  };
  const lifecycle = registerAdminYybRoutes({
    app,
    requireAdminToken() {},
    getAccountsForUser: () => [],
    canAccessAccount: () => false,
    ...options,
  });
  routes.lifecycle = lifecycle;
  return routes;
}

test('proxy edits and deletion notify running connections only after a successful upstream mutation', async t => {
  const changed = [];
  const routes = registeredRoutes({ onProxyProfileChanged: async (id, base) => changed.push([id, base]) });
  let ok = true;
  t.mock.method(globalThis, 'fetch', async () => ({ status: ok ? 200 : 403, json: async () => ok ? { code: 0, data: { id: 7 } } : { code: 403, msg: 'denied' } }));
  const response = { status() { return this; }, json(value) { this.body = value; return this; } };
  await routes.get('PUT /api/yyb/proxy-profiles')({ body: { id: 7, apiBase: 'http://yyb.test', apiKey: 'fixture' } }, response);
  await routes.get('DELETE /api/yyb/proxy-profiles/:id')({ params: { id: '7' }, query: { apiBase: 'http://yyb.test', apiKey: 'fixture' } }, response);
  assert.deepEqual(changed, [[7, 'http://yyb.test'], [7, 'http://yyb.test']]);
  ok = false;
  await routes.get('PUT /api/yyb/proxy-profiles')({ body: { id: 7, apiBase: 'http://yyb.test', apiKey: 'fixture' } }, response);
  assert.equal(changed.length, 2);
});

test('suspension rejects late YYB results and unban permits new requests', async t => {
  const routes = registeredRoutes(); let release;
  t.mock.method(globalThis, 'fetch', async () => new Promise(resolve => { release = () => resolve({ status: 200, json: async () => ({ code: 0, data: { openid: 'fixture' } }) }); }));
  const response = { status() { return this; }, json(value) { this.body = value; return this; } };
  const req = { body: { apiBase: 'http://yyb.test', apiKey: 'fixture', sessionId: 'fixture' } };
  const pending = routes.get('POST /api/yyb/qr/confirm')(req, response);
  const suspension = routes.lifecycle.suspendUserState(1000);
  release(); await suspension; await pending; assert.equal(response.body.ok, false);
  routes.lifecycle.resumeUserState(1000);
  const next = routes.get('POST /api/yyb/qr/confirm')(req, response);
  release(); await next; assert.equal(response.body.ok, true);
});

test('third-party code requests are cancelled on suspension and deletion and discard late credentials', async t => {
  for (const action of ['suspendUserState', 'purgeUserState']) {
    const routes = registeredRoutes();
    let release, signal;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      signal = init.signal;
      return new Promise(resolve => { release = () => resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { openid: 'fixture-openid', code: 'fixture-secret-code' } }) }); });
    });
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    const pending = routes.get('POST /api/yyb/thirdparty-code')({ body: { apiBase: 'https://fixture.invalid', apiToken: 'fixture-token', openid: 'fixture-openid' } }, response);
    const cleanup = routes.lifecycle[action](1000);
    const cancelled = signal.aborted;
    release(); await cleanup; await pending;
    assert.equal(cancelled, true, action);
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.ok, false);
    assert.equal(JSON.stringify(response.body).includes('fixture-secret-code'), false);
    t.mock.restoreAll();
  }
});

test('revoking one user cancels only their third-party request while another user still receives their own code', async t => {
  const routes = registeredRoutes(), pending = new Map();
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { openid } = JSON.parse(init.body);
    return new Promise(resolve => pending.set(openid, { signal: init.signal, release: () => resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { openid, code: `private-${openid}` } }) }) }));
  });
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  const a = response(), b = response();
  const request = (id, res) => routes.get('POST /api/yyb/thirdparty-code')({ currentUser: { id, role: 'user' }, body: { apiBase: 'https://fixture.invalid', apiToken: 'fixture-token', openid: String(id) } }, res);
  const operations = [request(1001, a), request(1002, b)];
  const cleanup = routes.lifecycle.suspendUserState(1001);
  assert.equal(pending.get('1001').signal.aborted, true);
  assert.equal(pending.get('1002').signal.aborted, false);
  for (const item of pending.values()) item.release();
  await cleanup; await Promise.all(operations);
  assert.equal(a.statusCode, 403); assert.equal(a.body.ok, false);
  assert.equal(b.body.data.code, 'private-1002');
  assert.equal(JSON.stringify(a.body).includes('private-1001'), false);
});

test('deletion aborts pending upstream calls and prevents late QR confirmation from restoring identity', async t => {
  const routes = registeredRoutes();
  let abortSignal;
  let release;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    abortSignal = init.signal;
    return new Promise(resolve => { release = () => resolve({ status: 200, json: async () => ({ code: 0, data: { openid: 'wx-retired' } }) }); });
  });
  const response = { status() { return this; }, json(value) { this.body = value; return this; } };
  const pending = routes.get('POST /api/yyb/qr/confirm')({ body: { apiBase: 'http://yyb.test', apiKey: 'fixture', sessionId: 'fixture' } }, response);
  const cleanup = routes.lifecycle.purgeUserState(1000);
  assert.equal(abortSignal.aborted, true);
  release(); await cleanup; await pending;
  assert.equal(response.body.ok, false);
  assert.match(response.body.error, /用户已停用/);
  await routes.get('POST /api/yyb/qr/confirm')({ body: { apiBase: 'http://yyb.test', apiKey: 'fixture', sessionId: 'fixture' } }, response);
  assert.equal(response.body.ok, false);
});

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
