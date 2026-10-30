const test = require('node:test');
const assert = require('node:assert/strict');
const { createAutoCodeRefreshService } = require('../src/runtime/auto-code-refresh');
const { createScheduler } = require('../src/services/scheduler');

function harness(t, overrides = {}) {
  const accounts = [{ id: '1', platform: 'wx', wxid: 'fixture-wx', code: 'old', autoStart: true }];
  const calls = []; const runtime = { connected: false }; let reply; let signal;
  const scheduler = createScheduler('auto_code_refresh'); scheduler.clearAll();
  const service = createAutoCodeRefreshService({
    getAccountAccessRejection: () => null,
    store: { getUserWxConfig: () => ({}), getAutoCodeRefresh: () => ({ enabled: true, intervalMinutes: 1 }) },
    getAccounts: () => ({ accounts }),
    addOrUpdateAccount: patch => { calls.push(['save', patch]); Object.assign(accounts[0], patch); },
    resolveWorkerControls: () => ({ getWorkerRuntime: () => runtime, restartWorker: async account => calls.push(['restart', account]) }),
    fetch: async (_url, options) => { calls.push(['request']); signal = options.signal; return new Promise(resolve => { reply = code => resolve({ ok: true, json: async () => ({ Success: true, Data: { code } }) }); }); },
    log() {}, addAccountLog() {},
    ...overrides,
  });
  t.after(() => service.close());
  return { accounts, calls, service, runtime, scheduler, reply: code => reply(code), get signal() { return signal; } };
}

test('legacy WX manual and timer requests coalesce into one fetch and one restart', async t => {
  const h = harness(t);
  const first = h.service.refreshAccountCode('1', 'manual');
  const second = h.service.refreshAccountCode('1', 'timer');
  h.reply('fresh-code');
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(h.calls.filter(call => call[0] === 'request').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'restart').length, 1);
  assert.deepEqual(h.calls.find(call => call[0] === 'save')[1], { id: '1', code: 'fresh-code' });
});

test('legacy WX request timeout aborts upstream and leaves credentials unchanged', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const h = harness(t, { fetch: async (_url, options) => {
    signal = options.signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('request aborted'), { name: 'AbortError' }))));
  } });
  const pending = h.service.refreshAccountCode('1', 'manual');
  t.mock.timers.tick(25000);
  assert.equal(await pending, false);
  assert.equal(signal.aborted, true);
  assert.equal(h.accounts[0].code, 'old');
  assert.equal(h.calls.some(call => call[0] === 'restart'), false);
});

test('online timer never mints a Code or disconnects a healthy game', async t => {
  const h = harness(t); h.runtime.connected = true;
  assert.equal(await h.service.refreshAccountCode('1', 'timer'), false);
  assert.deepEqual(h.calls, []);
});

test('revoked owners neither request a WX code nor commit an already requested code', async t => {
  let revoked = false;
  const h = harness(t, { getAccountAccessRejection: () => revoked ? { reason: 'banned' } : null });
  const pending = h.service.refreshAccountCode('1', 'manual');
  revoked = true; h.reply('late-after-ban');
  assert.equal(await pending, false);
  assert.equal(h.calls.some(call => call[0] === 'save' || call[0] === 'restart'), false);
  const count = h.calls.length;
  h.service.scheduleAccount('1');
  assert.equal(h.scheduler.has('refresh_1'), false);
  assert.equal(await h.service.refreshAccountCode('1', 'manual'), false);
  assert.equal(h.calls.length, count);
});

for (const change of ['stop', 'deleted', 'identity', 'code', 'proxy', 'became_online']) {
  test(`late WX results cannot modify or restart an account after ${change}`, async t => {
    const h = harness(t);
    const pending = h.service.refreshAccountCode('1', 'timer');
    if (change === 'stop') { h.accounts[0].autoStart = false; h.service.stopAccount('1'); assert(h.signal.aborted); }
    if (change === 'deleted') h.accounts.length = 0;
    if (change === 'identity') h.accounts[0].wxid = 'replacement';
    if (change === 'code') h.accounts[0].code = 'manual-new-code';
    if (change === 'proxy') h.accounts[0].proxyProfileId = 7;
    if (change === 'became_online') h.runtime.connected = true;
    h.reply('late-code'); assert.equal(await pending, false);
    assert.equal(h.calls.some(call => call[0] === 'save' || call[0] === 'restart'), false);
  });
}

test('stopped, native QQ and YYB accounts never enter the legacy WX timer', async t => {
  const h = harness(t);
  for (const patch of [{ autoStart: false }, { autoStart: true, platform: 'qq' }, { platform: 'wx', loginType: 'yyb' }]) {
    Object.assign(h.accounts[0], patch); h.service.scheduleAccount('1');
    assert.equal(h.scheduler.has('refresh_1'), false);
    assert.equal(await h.service.refreshAccountCode('1', 'timer'), false);
  }
  assert.deepEqual(h.calls, []);
});
