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
    getAccountAccessRejection: options.getAccountAccessRejection || (() => null),
    workers,
    globalLogs: [],
    accountLogs: [],
    store,
    getAccounts: () => ({ accounts: accounts.map(account => ({ ...account })) }),
    startWorker: account => calls.push(['start', account.id]),
    stopWorker: id => calls.push(['stop', id]),
    restartWorker: async (account, restartOptions) => calls.push(['restart', account.id, restartOptions]),
    refreshYybCodeIfNeeded: options.refreshYybCodeIfNeeded,
    refreshAccountCode: options.refreshAccountCode,
    ...(options.startWorker ? { startWorker: options.startWorker } : {}),
    scheduleAutoCodeRefresh: () => {},
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

test('two manual YYB refreshes perform one request and one restart', async () => {
  let finish; let count = 0;
  const h = harness([{ id: '1', loginType: 'yyb', yybOpenid: 'wx-a', code: 'old' }], {
    workers: { 1: {} }, refreshYybCodeIfNeeded: async () => { count++; return new Promise(resolve => { finish = resolve; }); },
  });
  const first = h.provider.refreshAccountCode('1'); const second = h.provider.refreshAccountCode('1');
  await new Promise(resolve => setImmediate(resolve));
  finish({ ok: true, code: 'new' }); await Promise.all([first, second]);
  assert.equal(count, 1); assert.equal(h.calls.filter(call => call[0] === 'restart').length, 1);
});

test('manual YYB refresh cannot undo a user stop or restore a deleted account', async () => {
  let finish; let signal;
  const h = harness([{ id: '1', loginType: 'yyb', yybOpenid: 'wx-a', code: 'old' }], {
    workers: { 1: {} }, refreshYybCodeIfNeeded: async (_account, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); },
  });
  const pending = h.provider.refreshAccountCode('1'); await new Promise(resolve => setImmediate(resolve));
  h.provider.stopAccount('1'); assert(signal.aborted);
  finish({ ok: true, code: 'late' });
  assert.equal((await pending).ok, false); assert.equal(h.accounts[0].code, 'old');
  assert.equal(h.calls.some(call => call[0] === 'restart'), false);
});

test('user resume rereads stop, deletion and credential changes after awaiting another account', async () => {
  let finish; const calls = [];
  const h = harness([1, 2, 3, 4].map(id => ({ id: String(id), userId: 1001, autoStart: true, code: `old-${id}` })), {
    startWorker: account => { calls.push({ ...account }); if (account.id === '1') return new Promise(resolve => { finish = resolve; }); },
  });
  const resume = h.provider.resumeUser(1001); await new Promise(resolve => setImmediate(resolve));
  h.accounts[1].autoStart = false; h.accounts.splice(2, 1); h.accounts[2].code = 'fresh-4';
  finish(); await resume;
  assert.deepEqual(calls.map(account => account.id), ['1', '4']);
  assert.equal(calls[1].code, 'fresh-4');
});
