const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDataProvider } = require('../src/runtime/data-provider');
const store = require('../src/models/store');
const { getAccountAccessRejection } = require('../src/services/account-access');
const { registerAdminAccountRoutes } = require('../src/controllers/admin-account-routes');

test('HTTP deletion waits for the authoritative deletion transaction and propagates failure', async () => {
  let route; let finish; let fail = false;
  const account = { id: '1', userId: 1001, platform: 'qq', autoStart: true };
  const accounts = [account];
  registerAdminAccountRoutes({
    app: { get() {}, post() {}, delete(url, handler) { if (url === '/api/accounts/:id') route = handler; } },
    refreshJobStore: { load: () => [], save() {} },
    provider: { getAccounts: () => ({ accounts }), stopAccount() {}, deleteAccount: async () => {
      if (fail) throw new Error('fixture profile cleanup denied');
      await new Promise(resolve => { finish = resolve; });
      return { accounts: [] };
    } },
    deleteAccount: () => ({ accounts: [] }),
    resolveAccountReference: id => id, canAccessAccount: () => true,
    findAccountByRef: (items, id) => items.find(item => item.id === id),
  });
  const request = { params: { id: '1' }, currentUser: { id: 1001, role: 'user' }, query: {} };
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  const res = response(); const pending = route(request, res);
  assert.equal(res.body, undefined, 'success must wait for the worker exit and credential cleanup');
  finish(); await pending; assert.equal(res.body.ok, true);
  fail = true; const failed = response(); await route(request, failed);
  assert.equal(failed.statusCode, 500); assert.equal(failed.body.ok, false);
});

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function harness(t, options = {}) {
  const account = { id: '1', userId: 1001, name: 'fixture', platform: 'qq', autoStart: true, qqLoginProfile: 'fixture-profile' };
  const accounts = [account, { id: '2', userId: 1002, autoStart: true }];
  const events = [];
  const globalLogs = [{ accountId: '1' }, { accountId: '2' }];
  const accountLogs = [{ accountId: '1' }, { accountId: '2' }];
  const provider = createDataProvider({
    workers: {}, globalLogs, accountLogs, getAccounts: () => ({ accounts }),
    getAccountAccessRejection: account => account.deleting ? { error: '账号正在删除' } : null,
    store: {
      beginAccountDeletion(id) { const target = accounts.find(item => item.id === id); Object.assign(target, { deleting: true, autoStart: false }); events.push('mark'); return { ...target }; },
      deleteAccount(id) { events.push('delete'); accounts.splice(accounts.findIndex(item => item.id === id), 1); return { accounts }; },
    },
    cancelCodeRefresh: async () => { events.push('cancel'); },
    stopWorkerAndWait: options.stopWorkerAndWait || (async () => { events.push('exit'); }),
    purgeQqAccount: options.purgeQqAccount || (async () => { events.push('profile'); }),
  });
  return { provider, accounts, account, events, globalLogs, accountLogs };
}

test('account deletion waits for exit flush before removing files and preserves other users', async t => {
  const exit = deferred();
  const h = harness(t, { stopWorkerAndWait: () => exit.promise });
  const deleting = h.provider.deleteAccount('1');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.account.deleting, true);
  assert.equal(h.account.autoStart, false);
  assert.equal(h.events.includes('delete'), false);
  assert.throws(() => h.provider.startAccount('1'), /删除|停用/);
  exit.resolve();
  await deleting;
  assert.deepEqual(h.events, ['mark', 'cancel', 'profile', 'delete']);
  assert.deepEqual(h.accounts.map(item => item.id), ['2']);
  assert.deepEqual(h.globalLogs, [{ accountId: '2' }]);
  assert.deepEqual(h.accountLogs, [{ accountId: '2' }]);
});

test('profile cleanup failure leaves a stopped retryable account and never reports deletion success', async t => {
  let attempts = 0;
  const h = harness(t, { purgeQqAccount: async () => { if (++attempts === 1) throw new Error('fixture cleanup denied'); } });
  await assert.rejects(h.provider.deleteAccount('1'), /cleanup denied/);
  assert.equal(h.account.deleting, true);
  assert.equal(h.accounts.length, 2);
  assert.equal(h.events.includes('delete'), false);
  await h.provider.deleteAccount('1');
  assert.equal(attempts, 2);
  assert.deepEqual(h.accounts.map(item => item.id), ['2']);
});

test('concurrent account deletion requests share a single exit and cleanup', async t => {
  const exit = deferred(); let stops = 0;
  const h = harness(t, { stopWorkerAndWait: () => { stops++; return exit.promise; } });
  const first = h.provider.deleteAccount('1'); const second = h.provider.deleteAccount('1');
  exit.resolve(); await Promise.all([first, second]);
  assert.equal(stops, 1);
  assert.equal(h.events.filter(event => event === 'delete').length, 1);
});

test('persistent deletion mark blocks credential writes and survives storage reload', () => {
  const account = store.addOrUpdateAccount({ userId: 1001, platform: 'qq', autoStart: true }).accounts.at(-1);
  const other = store.addOrUpdateAccount({ userId: 1002, platform: 'qq' }).accounts.at(-1);
  const current = store.beginAccountDeletion(account.id);
  assert.equal(current.deleting, true);
  assert.equal(store.loadAccounts().accounts.find(item => item.id === account.id).deleting, true);
  assert.match(getAccountAccessRejection(current).error, /删除/);
  assert.throws(() => store.addOrUpdateAccount({ id: account.id, code: 'late' }), /删除/);
  const stats = path.join(process.env.FARM_DATA_DIR, 'stats', `${account.id}.json`);
  fs.mkdirSync(path.dirname(stats), { recursive: true });
  fs.writeFileSync(stats, '{}');
  store.deleteAccount(account.id);
  assert.equal(fs.existsSync(stats), false);
  assert(store.getAccounts().accounts.some(item => item.id === other.id));
});

test('a late worker stats flush is gone after the completed deletion', async () => {
  const account = store.addOrUpdateAccount({ userId: 1001, platform: 'qq' }).accounts.at(-1);
  const stats = path.join(process.env.FARM_DATA_DIR, 'stats', `${account.id}.json`);
  const provider = createDataProvider({
    store, workers: {}, globalLogs: [], accountLogs: [], getAccounts: store.getAccounts,
    cancelCodeRefresh: async () => {}, purgeQqAccount: async () => {},
    stopWorkerAndWait: async () => {
      await new Promise(resolve => setImmediate(resolve));
      fs.mkdirSync(path.dirname(stats), { recursive: true }); fs.writeFileSync(stats, '{"operations":{}}');
    },
  });
  await provider.deleteAccount(account.id);
  assert.equal(fs.existsSync(stats), false);
  assert.equal(store.getAccounts().accounts.some(item => item.id === account.id), false);
});
