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
      deleteAccount: async id => { calls.push(['delete', id]); return { accounts: [] }; },
    },
    resolveAccountReference: id => String(id),
    canAccessAccount: () => allowed,
    findAccountByRef: accounts => accounts[0],
  });
  return {
    calls,
    async remove(query = { onlyStopped: '1' }) {
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      await routes.get('/api/accounts/:id')({ params: { id: '1' }, query }, res);
      return res;
    },
  };
}

for (const state of ['starting', 'stopping', 'online', 'failed', 'reconnecting']) {
  test(`bulk cleanup rechecks runtime and preserves ${state} accounts`, async () => {
    const h = setup({ state, running: false });
    assert.equal((await h.remove()).statusCode, 409);
    assert.deepEqual(h.calls, []);
  });
}
test('bulk cleanup removes only stopped accounts, preserving the manual delete behavior', async () => {
  const stopped = setup({ state: 'stopped', running: false, connected: false });
  assert.equal((await stopped.remove()).body.ok, true);
  assert.deepEqual(stopped.calls, [['delete', '1']]);
  const manual = setup({ state: 'starting' });
  assert.equal((await manual.remove({})).body.ok, true);
});
test('cleanup rejects contradictory running state, missing accounts and inaccessible accounts', async () => {
  assert.equal((await setup({ state: 'stopped', running: true }).remove()).statusCode, 409);
  assert.equal((await setup(null, { accountExists: false }).remove()).statusCode, 404);
  assert.equal((await setup(null, { allowed: false }).remove()).statusCode, 403);
});

for (const state of ['scheduled', 'waiting_credentials']) {
  test(`cleanup preserves ${state} accounts even when a stale state says stopped`, async () => {
    const h = setup({ state: 'stopped', running: false, connected: false, reconnect: { state } });
    assert.equal((await h.remove()).statusCode, 409);
    assert.deepEqual(h.calls, []);
  });
}
