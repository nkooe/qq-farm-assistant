const test = require('node:test');
const assert = require('node:assert/strict');
const { createDataProvider } = require('../src/runtime/data-provider');

function harness(initialAccounts, options = {}) {
  const accounts = initialAccounts.map(account => ({ ...account }));
  const calls = [];
  const workers = options.workers || {};
  const store = {
    addOrUpdateAccount(patch) {
      calls.push(['save', { ...patch }]);
      const account = accounts.find(item => item.id === String(patch.id));
      if (account) Object.assign(account, patch);
      return { accounts };
    },
  };
  const provider = createDataProvider({
    workers,
    globalLogs: [],
    accountLogs: [],
    store,
    getAccounts: () => ({ accounts }),
    startWorker: account => calls.push(['start', account.id]),
    stopWorker: id => calls.push(['stop', id]),
    restartWorker: async (account, restartOptions) => calls.push(['restart', account.id, restartOptions]),
    refreshYybCodeIfNeeded: options.refreshYybCodeIfNeeded,
    refreshAccountCode: options.refreshAccountCode,
  });
  return { accounts, calls, provider };
}

test('manual start and stop persist the next boot state', () => {
  const h = harness([{ id: '1', name: 'A', autoStart: false }]);
  assert.equal(h.provider.startAccount('1'), true);
  assert.equal(h.accounts[0].autoStart, true);
  assert.deepEqual(h.calls.at(-1), ['start', '1']);

  assert.equal(h.provider.stopAccount('1'), true);
  assert.equal(h.accounts[0].autoStart, false);
  assert.deepEqual(h.calls.at(-1), ['stop', '1']);
});

test('manual YYB refresh saves the new code and restarts a running account once', async () => {
  const h = harness([
    { id: '1', name: 'A', loginType: 'yyb', yybOpenid: 'wx-a', code: 'old' },
  ], {
    workers: { 1: { process: {} } },
    refreshYybCodeIfNeeded: async (account) => {
      account.code = 'new';
      return { ok: true, code: 'new', source: 'yyb' };
    },
  });
  const result = await h.provider.refreshAccountCode('1');
  assert.deepEqual(result, { ok: true, source: 'yyb' });
  assert.equal(h.accounts[0].code, 'new');
  assert.deepEqual(h.calls.at(-1), ['restart', '1', { skipYybRefresh: true }]);
});

test('manual YYB refresh failure preserves the old code and running worker', async () => {
  const h = harness([
    { id: '1', name: 'A', loginType: 'yyb', yybOpenid: 'wx-a', code: 'old' },
  ], {
    workers: { 1: { process: {} } },
    refreshYybCodeIfNeeded: async () => ({ ok: false, error: 'authorization expired' }),
  });
  const result = await h.provider.refreshAccountCode('1');
  assert.deepEqual(result, { ok: false, source: 'yyb', error: 'authorization expired' });
  assert.equal(h.accounts[0].code, 'old');
  assert.equal(h.calls.length, 0);
});

test('legacy wxid refresh still uses the existing refresh service', async () => {
  let refreshed = '';
  const h = harness([{ id: '2', name: 'Legacy', wxid: 'wxid-a', loginType: 'manual' }], {
    refreshAccountCode: async (id, reason) => {
      refreshed = `${id}:${reason}`;
      return true;
    },
  });
  assert.deepEqual(await h.provider.refreshAccountCode('2'), {
    ok: true,
    source: 'wxid',
    error: '',
  });
  assert.equal(refreshed, '2:manual');
});
