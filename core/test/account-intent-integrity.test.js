const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/models/store');
const { registerAdminAccountRoutes } = require('../src/controllers/admin-account-routes');

function accountRoute(options = {}) {
  let route; const starts = []; const stops = []; const restarts = [];
  registerAdminAccountRoutes({
    app: { get() {}, delete() {}, post(path, handler) { if (path === '/api/accounts') route = handler; } },
    refreshJobStore: { load: () => [], save() {} },
    provider: { getAccounts: store.getAccounts, startAccount: id => starts.push(id), stopAccount: id => stops.push(id), restartAccount: id => restarts.push(id), isAccountRunning: () => options.running === true },
    addOrUpdateAccount: store.addOrUpdateAccount,
    resolveAccountReference: id => String(id),
  });
  return { starts, stops, restarts, save(body) {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    route({ currentUser: { id: 1000, role: 'admin' }, body }, response);
    return response;
  } };
}

test('creating an explicitly stopped account never requests an automatic start', () => {
  const h = accountRoute();
  const res = h.save({ name: 'stopped-fixture', autoStart: false });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.accounts.at(-1).autoStart, false);
  assert.deepEqual(h.starts, []);
  const running = h.save({ name: 'running-fixture', autoStart: true });
  assert.deepEqual(h.starts, [running.body.data.accounts.at(-1).id]);
});

test('saving an explicit stopped intent stops rather than restarts a running account', () => {
  const h = accountRoute({ running: true });
  const account = store.addOrUpdateAccount({ userId: 1000, autoStart: true }).accounts.at(-1);
  assert.equal(h.save({ id: account.id, autoStart: false }).statusCode, 200);
  assert.deepEqual(h.stops, [account.id]);
  assert.deepEqual(h.restarts, []);
});

test('saving an explicit running intent starts a stopped account', () => {
  const h = accountRoute();
  const account = store.addOrUpdateAccount({ userId: 1000, autoStart: false }).accounts.at(-1);
  assert.equal(h.save({ id: account.id, autoStart: true }).statusCode, 200);
  assert.deepEqual(h.starts, [account.id]);
});

test('an invalid proxy edit never converts an account into a direct connection', () => {
  const account = store.addOrUpdateAccount({ userId: 1001, proxyMode: 'static', proxyProfileId: 7 }).accounts.at(-1);
  for (const patch of [{ proxyMode: 'invalid' }, { proxyMode: 'static', proxyProfileId: null }, { proxyProfileId: -1 }]) {
    assert.throws(() => store.addOrUpdateAccount({ id: account.id, ...patch }), /代理/);
    const current = store.getAccounts().accounts.find(item => item.id === account.id);
    assert.equal(current.proxyMode, 'static'); assert.equal(current.proxyProfileId, 7);
  }
  assert.throws(() => store.addOrUpdateAccount({ userId: 1001, proxyMode: 'invalid' }), /代理/);
});

test('account save rejects invalid proxy inputs as a client error', () => {
  const h = accountRoute();
  const before = store.getAccounts().accounts.length;
  const res = h.save({ name: 'invalid-proxy', proxyMode: 'invalid', autoStart: false });
  assert.equal(res.statusCode, 400);
  assert.equal(store.getAccounts().accounts.length, before);
  assert.deepEqual(h.starts, []);
});

test('autoStart requires a boolean and invalid writes never corrupt the accounts document', () => {
  const account = store.addOrUpdateAccount({ userId: 1001, autoStart: false }).accounts.at(-1);
  for (const autoStart of ['false', 0, null, {}, []]) {
    assert.throws(() => store.addOrUpdateAccount({ userId: 1001, autoStart }), /autoStart/);
    assert.throws(() => store.addOrUpdateAccount({ id: account.id, autoStart }), /autoStart/);
    assert.equal(store.getAccounts().accounts.find(item => item.id === account.id).autoStart, false);
  }
});

test('public account edits reject internal fields without changing the record', () => {
  const h = accountRoute();
  const account = store.addOrUpdateAccount({ userId: 1000, autoStart: false }).accounts.at(-1);
  for (const field of ['deleting', 'createdAt', 'updatedAt', 'qqLoginProfile', 'role', 'unknownSetting']) {
    const res = h.save({ id: account.id, [field]: field === 'deleting' ? true : 'fixture' });
    assert.equal(res.statusCode, 400, field);
    assert.deepEqual(store.getAccounts().accounts.find(item => item.id === account.id), account);
  }
});
