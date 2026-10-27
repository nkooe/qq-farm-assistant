const test = require('node:test');
const assert = require('node:assert/strict');
const { registerModernFeatureRoutes } = require('../src/controllers/admin-modern-feature-routes');

function routesHarness() {
  const routes = [];
  const calls = [];
  registerModernFeatureRoutes({
    app: Object.fromEntries(['get', 'post'].map(verb => [verb, (path, handler) => routes.push({ verb, path, handler })])),
    provider: {
      getStatus: id => ({ connection: { connected: id !== 'offline' } }),
      featureCall: async (id, method, args) => { calls.push({ id, method, args }); return { accountId: id }; },
    },
    getAccountIdFromRequest: req => req.headers['x-account-id'],
    canAccessAccount: (req, id) => id !== 'other-user',
  });
  const invoke = async (route, accountId, extra = {}) => {
    const res = { statusCode: 200, headersSent: false, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; this.headersSent = true; return this; } };
    await route.handler({ headers: { 'x-account-id': accountId }, params: {}, body: {}, query: {}, ...extra }, res);
    return res;
  };
  return { routes, calls, invoke };
}

test('every new activity and inventory route checks ownership and connection before dispatch', async () => {
  const h = routesHarness();
  assert.ok(h.routes.length >= 40);
  for (const route of h.routes) {
    assert.equal((await h.invoke(route, '')).statusCode, 400, route.path);
    assert.equal((await h.invoke(route, 'other-user')).statusCode, 403, route.path);
    assert.equal((await h.invoke(route, 'offline')).body.ok, false, route.path);
  }
  assert.equal(h.calls.length, 0);
});

test('account switching pins feature calls to the requested worker and validates locks', async () => {
  const h = routesHarness();
  const directory = h.routes.find(r => r.path === '/api/activity-center/activities');
  const results = await Promise.all(['account-A', 'account-B'].map(id => h.invoke(directory, id)));
  assert.deepEqual(results.map(r => r.body.data.accountId), ['account-A', 'account-B']);
  assert.deepEqual(h.calls.map(c => c.id), ['account-A', 'account-B']);
  const lock = h.routes.find(r => r.path === '/api/bag/lock');
  assert.equal((await h.invoke(lock, 'account-A', { body: { uids: [11], locked: 'false' } })).body.ok, false);
  assert.equal(h.calls.length, 2);
  await h.invoke(lock, 'account-B', { body: { uids: [12], locked: true } });
  assert.deepEqual(h.calls.at(-1), { id: 'account-B', method: 'setItemsLocked', args: [[12], true] });
});

test('feature dispatcher uses an explicit method allowlist and keeps legacy definitions isolated', async () => {
  const { callFeature, methods } = require('../src/modern/feature-api');
  await assert.rejects(callFeature('constructor'), /未知/);
  await assert.rejects(callFeature('getSolarCalendar', {}), /参数/);
  for (const [name, service] of Object.entries(methods)) assert.equal(typeof require(`../src/modern/services/${service}`)[name], 'function', name);
  const modern = require('../src/modern/utils/proto');
  const legacy = require('../src/utils/proto');
  await modern.loadProto();
  await legacy.loadProto();
  assert.notEqual(modern.types.BagReply, legacy.types.BagReply);
  assert.equal(modern.types.LockItemsRequest.fields.item_uids.id, 1);
  assert.ok(modern.types.GetSolarTermsV2Reply.fields.server_time);
});
