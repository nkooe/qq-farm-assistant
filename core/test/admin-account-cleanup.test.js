const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAdminAccountRoutes } = require('../src/controllers/admin-account-routes');

function setup(runtime, { allowed = true, accountExists = true } = {}) {
  const routes = new Map();
  const calls = [];
  const account = { id: '1', name: 'Test', runtimeState: 'stopped', running: false };
  registerAdminAccountRoutes({
    app: { get() {}, post() {}, delete(path, handler) { routes.set(path, handler); } },
    provider: {
      getAccounts: () => ({ accounts: accountExists ? [account] : [] }),
      getAccountRuntime: () => runtime,
      stopAccount: id => calls.push(['stop', id]),
    },
    resolveAccountReference: id => String(id),
    canAccessAccount: () => allowed,
    findAccountByRef: accounts => accounts[0],
    deleteAccount: id => { calls.push(['delete', id]); return { accounts: [] }; },
  });
  return {
    calls,
    remove(query = { onlyStopped: '1' }) {
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      routes.get('/api/accounts/:id')({ params: { id: '1' }, query }, res);
      return res;
    },
  };
}

for (const state of ['starting', 'stopping', 'online', 'failed', 'reconnecting']) {
  test(`bulk cleanup rechecks runtime and preserves ${state} accounts`, () => {
    const h = setup({ state, running: false });
    assert.equal(h.remove().statusCode, 409);
    assert.deepEqual(h.calls, []);
  });
}
test('bulk cleanup removes only stopped accounts, preserving the manual delete behavior', () => {
  const stopped = setup({ state: 'stopped', running: false, connected: false });
  assert.equal(stopped.remove().body.ok, true);
  assert.deepEqual(stopped.calls, [['stop', '1'], ['delete', '1']]);
  const manual = setup({ state: 'starting' });
  assert.equal(manual.remove({}).body.ok, true);
});
test('cleanup rejects contradictory running state, missing accounts and inaccessible accounts', () => {
  assert.equal(setup({ state: 'stopped', running: true }).remove().statusCode, 409);
  assert.equal(setup(null, { accountExists: false }).remove().statusCode, 404);
  assert.equal(setup(null, { allowed: false }).remove().statusCode, 403);
});

for (const state of ['scheduled', 'waiting_credentials']) {
  test(`cleanup preserves ${state} accounts even when a stale state says stopped`, () => {
    const h = setup({ state: 'stopped', running: false, connected: false, reconnect: { state } });
    assert.equal(h.remove().statusCode, 409);
    assert.deepEqual(h.calls, []);
  });
}
