const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAdminFarmResourceRoutes } = require('../src/controllers/admin-farm-resource-routes');
const { registerAdminBagRoutes } = require('../src/controllers/admin-bag-routes');

function harness(register) {
  const routes = new Map(), calls = [];
  const provider = new Proxy({}, { get: (_object, name) => async (...args) => { calls.push({ name, args }); return {}; } });
  register({ app: { get: (url, handler) => routes.set(url, handler), post: (url, handler) => routes.set(url, handler) }, provider,
    getAccountIdFromRequest: () => 'fixture', canAccessAccount: () => true, emitRealtimeLog() {},
    sendProviderError: (res, error) => res.status(500).json({ ok: false, error: error.message }) });
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  return { routes, calls, res };
}

test('bag use rejects malformed identifiers, counts and UIDs before reading or consuming inventory', async () => {
  for (const overrides of [{ count: -1 }, { count: 0 }, { count: 0.5 }, { count: '1' },
    { itemId: '3001' }, { uid: -1 }, { uid: '11' }, { uid: null }]) {
    const h = harness(registerAdminBagRoutes);
    await h.routes.get('/api/bag/use')({ body: { itemId: 3001, count: 1, uid: 11, ...overrides } }, h.res);
    assert.equal(h.res.statusCode, 400); assert.equal(h.calls.length, 0);
  }
});

test('fertilizer manual route rejects invalid types and counts before the worker', async () => {
  for (const body of [{ type: 'other', count: 1 }, { type: 'organic', count: '1' },
    { type: 'normal', count: -1 }, { type: 'organic', count: 0 }, { type: 'organic', count: 0.5 }]) {
    const h = harness(registerAdminFarmResourceRoutes);
    await h.routes.get('/api/fertilizer/buy')({ body }, h.res);
    assert.equal(h.res.statusCode, 400); assert.equal(h.calls.length, 0);
  }
});

test('threshold purchase requires real booleans and positive integer quantities', async () => {
  for (const overrides of [{ buyOrganic: 'false' }, { organicCount: -1 }, { organicCount: 1.5 },
    { organicCount: '1' }, { organicThresholdHours: 0 }, { organicThresholdHours: '5' }]) {
    const h = harness(registerAdminFarmResourceRoutes);
    await h.routes.get('/api/fertilizer/check-and-buy')({ body: { buyOrganic: true, buyNormal: false,
      organicCount: 1, organicThresholdHours: 5, normalCount: 0, normalThresholdHours: 0, ...overrides } }, h.res);
    assert.equal(h.res.statusCode, 400); assert.equal(h.calls.length, 0);
  }
});

test('valid threshold configuration forwards one typed account-scoped operation', async () => {
  const h = harness(registerAdminFarmResourceRoutes);
  await h.routes.get('/api/fertilizer/check-and-buy')({ body: { buyOrganic: true, organicCount: 2, organicThresholdHours: 5 } }, h.res);
  assert.equal(h.res.body.ok, true);
  assert.deepEqual(h.calls, [{ name: 'checkAndBuyFertilizer', args: ['fixture', { buyOrganic: true, buyNormal: false,
    organicCount: 2, organicThresholdHours: 5, normalCount: 0, normalThresholdHours: 0 }] }]);
});
