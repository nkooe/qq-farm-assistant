const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setImmediate } = require('node:timers/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-worker-start-'));
process.env.FARM_DATA_DIR = dataDir;
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const { createWorkerManager } = require('../src/runtime/worker-manager');
const { createDataProvider } = require('../src/runtime/data-provider');
const { createScheduler } = require('../src/services/scheduler');
const { createLoginRecovery } = require('../src/services/login-recovery');
const store = require('../src/models/store');

function harness(t, reconnect = {}, overrides = {}) {
  const workers = {};
  const requests = new Map();
  const accounts = [];
  const scheduler = createScheduler('worker_manager');
  scheduler.clearAll();
  t.after(() => scheduler.clearAll());
  const config = { autoReconnect: false, reconnectDelayMin: 5, reconnectMaxAttempts: 3, ...reconnect };
  t.mock.method(store, 'getAccounts', () => ({ accounts }));
  t.mock.method(store, 'getUserWxConfig', () => config);
  const envBefore = { url: process.env.YYB_API_URL, key: process.env.YYB_API_KEY };
  process.env.YYB_API_URL = 'http://yyb.test';
  process.env.YYB_API_KEY = 'test-token';
  t.after(() => {
    if (envBefore.url === undefined) delete process.env.YYB_API_URL;
    else process.env.YYB_API_URL = envBefore.url;
    if (envBefore.key === undefined) delete process.env.YYB_API_KEY;
    else process.env.YYB_API_KEY = envBefore.key;
  });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { ref } = JSON.parse(init.body);
    return new Promise(resolve => {
      requests.set(ref, () => resolve({ json: async () => ({ code: 0, data: { result: { code: `code-${ref}` } } }) }));
    });
  });
  const created = [];
  class FakeWorker extends EventEmitter {
    constructor(_path, options) {
      super();
      this.id = options.workerData.accountId;
      this.messages = [];
      created.push(this);
    }
    postMessage(message) {
      this.messages.push(message);
      if (message.type === 'stop') this.emit('exit', 0);
    }
    terminate() { this.emit('exit', 0); }
  }
  const manager = createWorkerManager({
    getAccountAccessRejection: () => null,
    WorkerThread: FakeWorker,
    resolveAccountProxy: async () => '',
    processRef: { pkg: false },
    workers,
    workerScriptPath: 'fake-worker',
    globalLogs: [],
    log() {}, addAccountLog() {}, normalizeStatusForPanel: value => value,
    addOrUpdateAccount(patch) { const account = accounts.find(a => a.id === patch.id); if (account) Object.assign(account, patch); },
    triggerOfflineReminder: async () => ({ ok: false, status: 'disabled' }),
    buildConfigSnapshotForAccount: id => ({ accountId: id, clientVersion: '1.15.0_qq', wxClientVersion: '1.16.0_wx' }),
    ...overrides,
  });
  return { manager, workers, created, requests, accounts, scheduler, config };
}

test('selected proxy reaches the worker and an unavailable proxy creates no direct worker', async (t) => {
  const h = harness(t, {}, { resolveAccountProxy: async account => {
    if (account.proxyProfileId !== 7) throw new Error('代理配置不可用');
    return 'http://fixture-proxy:8080';
  } });
  const good = { autoStart: true, userId: 1000, id: 'proxy-good', name: 'P', platform: 'qq', proxyMode: 'static', proxyProfileId: 7 };
  h.accounts.push(good);
  const bad = { ...good, id: 'proxy-failed', proxyProfileId: 8 }; h.accounts.push(bad);
  assert.equal(await h.manager.startWorker(good), true);
  assert.equal(h.created[0].messages[0].config.proxyURL, 'http://fixture-proxy:8080');
  assert.equal(await h.manager.startWorker(bad), false);
  assert.equal(h.created.length, 1);
  assert.equal(h.manager.getWorkerRuntime('proxy-failed').state, 'failed');
});

for (const change of ['missing', 'stopped', 'credentials']) {
  test(`worker startup rejects ${change} persisted state before refreshing credentials`, async t => {
    let refreshes = 0;
    const h = harness(t, {}, { refreshQqCode: async () => { refreshes++; return 'fixture-code'; } });
    const account = { id: '1', userId: 1001, platform: 'qq', autoStart: true, qqLoginProfile: 'fixture', code: 'old' };
    if (change !== 'missing') h.accounts.push({ ...account, ...(change === 'stopped' ? { autoStart: false } : { code: 'new' }) });
    assert.equal(await h.manager.startWorker(account, { automatic: true }), false);
    assert.equal(refreshes, 0);
    assert.equal(h.created.length, 0);
    assert.equal(h.scheduler.has('reconnect_attempt_1'), false);
  });
}

for (const change of ['stopped', 'deleting']) {
  test(`late startup refresh rechecks ${change} intent even without an explicit cancellation`, async t => {
    let finish;
    const h = harness(t, {}, { refreshQqCode: () => new Promise(resolve => { finish = resolve; }) });
    const account = { id: '1', userId: 1001, platform: 'qq', autoStart: true, qqLoginProfile: 'fixture' };
    h.accounts.push({ ...account });
    const pending = h.manager.startWorker(account, { automatic: true });
    if (change === 'stopped') h.accounts[0].autoStart = false;
    else h.accounts[0].deleting = true;
    finish('fixture-late-code');
    assert.equal(await pending, false);
    assert.equal(h.created.length, 0);
    assert.equal(h.scheduler.has('reconnect_attempt_1'), false);
  });
}

test('native QQ reconnection refreshes its own credentials with WX reconnect disabled and never calls YYB', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const messages = []; const saved = []; let refreshes = 0; let yybCalls = 0;
  const h = harness(t, { autoReconnect: false }, {
    refreshQqCode: async () => { refreshes++; return `fixture_QQ_FRESH_CODE_1234567${  refreshes}`; },
    addOrUpdateAccount: patch => saved.push(patch),
    log: (_tag, message) => messages.push(message),
    addAccountLog: (_action, message) => messages.push(message),
  });
  t.mock.method(globalThis, 'fetch', async () => { yybCalls++; throw new Error('Must not call WX or YYB'); });
  const account = { autoStart: true, userId: 1000, id: 'qq-1', name: 'QQ', userId: 1001, platform: 'qq', loginType: 'manual', qqLoginProfile: 'fixture-profile', uin: '12345678', code: 'old' };
  h.accounts.push(account);
  assert.equal(await h.manager.startWorker(account), true);
  assert.equal(h.created[0].messages[0].config.code, 'fixture_QQ_FRESH_CODE_12345671');
  h.created[0].emit('message', { type: 'ws_error', code: 400, message: 1004 });
  assert.equal(h.manager.getWorkerRuntime('qq-1').state, 'reconnecting');
  t.mock.timers.tick(30000); await setImmediate();
  assert.equal(refreshes, 2); assert.equal(yybCalls, 0); assert.equal(saved.length, 2);
  assert.equal(h.created[1].messages[0].config.code, 'fixture_QQ_FRESH_CODE_12345672');
  assert(messages.some(message => message.includes('QQ 原生登录态重连')));
  assert(!messages.some(message => message.includes('应用宝')));
});

test('legacy QQ does not reuse a stale Code through the enabled WX reconnect queue', async t => {
  const messages = [];
  const h = harness(t, { autoReconnect: true }, { log: (_tag, message) => messages.push(message), addAccountLog: (_action, message) => messages.push(message) });
  const account = { autoStart: true, userId: 1000, id: 'qq-1', platform: 'qq', loginType: 'manual', code: 'old' };
  h.accounts.push(account);
  await h.manager.startWorker(account);
  h.created[0].emit('message', { type: 'ws_reconnect_failed', reason: 'heartbeat_timeout' });
  assert.equal(h.scheduler.has('reconnect_attempt_qq-1'), false);
  assert(messages.some(message => message.includes('QQ 扫码更新一次')));
  assert(!messages.some(message => message.includes('应用宝')));
});

test('stopping a QQ credential refresh cancels it without persisting or starting a worker', async t => {
  let finish; let signal; const saved = [];
  const h = harness(t, {}, { refreshQqCode: async (_account, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); }, addOrUpdateAccount: patch => saved.push(patch) });
  const account = { autoStart: true, userId: 1000, id: 'qq-1', platform: 'qq', qqLoginProfile: 'fixture-profile' }; h.accounts.push(account);
  const pending = h.manager.startWorker(account);
  h.manager.stopWorker('qq-1'); finish('fixture_QQ_CODE_12345678');
  assert.equal(await pending, false); assert.equal(signal.aborted, true);
  assert.equal(saved.length, 0); assert.equal(h.created.length, 0);
  assert.equal(h.scheduler.has('reconnect_attempt_qq-1'), false);
});

for (const change of ['profile', 'proxy', 'deleted']) {
  test(`QQ credential refresh cannot start an account changed during the request: ${change}`, async t => {
    let finish; const saved = [];
    const h = harness(t, {}, { refreshQqCode: () => new Promise(resolve => { finish = resolve; }), addOrUpdateAccount: patch => saved.push(patch) });
    const account = { autoStart: true, userId: 1000, id: 'qq-1', userId: 1001, platform: 'qq', qqLoginProfile: 'old-profile', proxyMode: 'direct', uin: '12345678' };
    h.accounts.push({ ...account });
    const pending = h.manager.startWorker(account);
    if (change === 'profile') h.accounts[0].qqLoginProfile = 'new-profile';
    if (change === 'proxy') h.accounts[0].proxyMode = 'static';
    if (change === 'deleted') h.accounts.length = 0;
    finish('fixture_STALE_CODE_12345678');
    assert.equal(await pending, false);
    assert.deepEqual(saved, []);
    assert.equal(h.created.length, 0);
    assert.equal(h.scheduler.has('reconnect_attempt_qq-1'), false);
  });
}

test('new scan credentials replace a pending startup instead of sharing its stale result', async t => {
  let finish; let calls = 0;
  const h = harness(t, {}, { refreshQqCode: async () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const account = { autoStart: true, userId: 1000, id: 'qq-1', platform: 'qq', qqLoginProfile: 'old-profile', code: 'old' };
  h.accounts.push({ ...account });
  const old = h.manager.startWorker(account);
  Object.assign(h.accounts[0], { qqLoginProfile: 'new-profile', code: 'new-scan' });
  assert.equal(await h.manager.startWorker({ ...h.accounts[0] }, { skipQqRefresh: true }), true);
  finish('stale');
  assert.equal(await old, false);
  assert.equal(calls, 1);
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].messages[0].config.code, 'new-scan');
});

for (const order of ['manual-first', 'startup-first']) {
  test(`manual YYB refresh and automatic startup commit one shared result: ${order}`, async t => {
    const h = harness(t); let requests = 0; let finish;
    const account = { autoStart: true, userId: 1000, id: 'shared-yyb', platform: 'wx', loginType: 'yyb', yybOpenid: 'shared', code: 'old' };
    h.accounts.push(account);
    t.mock.method(globalThis, 'fetch', async () => { requests++; return new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => ({ code: 0, data: { result: { code: 'shared-fresh' } } }) }); }); });
    const provider = createDataProvider({
      getAccountAccessRejection: () => null,
      workers: h.workers, globalLogs: [], accountLogs: [], getAccounts: () => ({ accounts: h.accounts }),
      store: { addOrUpdateAccount: patch => Object.assign(account, patch) },
      getWorkerRuntime: h.manager.getWorkerRuntime, refreshYybCodeIfNeeded: h.manager.refreshYybCodeIfNeeded,
      restartWorker: h.manager.restartWorker,
    });
    const tasks = [];
    if (order === 'manual-first') {
      tasks.push(provider.refreshAccountCode(account.id)); await setImmediate();
      tasks.push(h.manager.startWorker({ ...account }, { automatic: true }));
    } else {
      tasks.push(h.manager.startWorker({ ...account }, { automatic: true }));
      tasks.push(provider.refreshAccountCode(account.id)); await setImmediate();
    }
    finish(); const results = await Promise.all(tasks);
    assert.equal(results[order === 'manual-first' ? 0 : 1].ok, true);
    assert.equal(requests, 1); assert.equal(h.created.length, 1);
    assert.equal(account.code, 'shared-fresh');
    assert.equal(h.workers[account.id].process.messages[0].config.code, 'shared-fresh');
  });
}

test('repeating an accepted YYB start preserves the in-flight credential request', async t => {
  const loginRecovery = createLoginRecovery();
  const h = harness(t, {}, { loginRecovery });
  const account = { id: 'repeat-start', userId: 1000, autoStart: true, platform: 'wx', loginType: 'yyb', yybOpenid: 'repeat', code: 'old' };
  h.accounts.push(account);
  const provider = createDataProvider({
    getAccountAccessRejection: () => null,
    workers: h.workers, globalLogs: [], accountLogs: [],
    getAccounts: () => ({ accounts: h.accounts.map(item => ({ ...item })) }),
    store: { addOrUpdateAccount: patch => Object.assign(account, patch) },
    getWorkerRuntime: h.manager.getWorkerRuntime,
    startWorker: h.manager.startWorker, restartWorker: h.manager.restartWorker,
    cancelCodeRefresh: id => loginRecovery.cancel(id),
    scheduleAutoCodeRefresh() {}, addAccountLog() {},
  });
  assert.equal(provider.startAccount(account.id), true);
  assert.equal(h.manager.getWorkerRuntime(account.id).state, 'starting');
  assert.equal(provider.startAccount(account.id), true);
  assert.equal(loginRecovery.getState(account.id).state, 'requesting');
  h.requests.get('repeat')();
  await setImmediate();
  assert.equal(h.created.length, 1);
  h.created[0].emit('message', { type: 'status_sync', data: { connection: { connected: true } } });
  assert.equal(h.manager.getWorkerRuntime(account.id).state, 'online');
});

for (const change of ['stop', 'deleted', 'proxy', 'code']) {
  test(`worker restart cannot resurrect a changed account after ${change}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness(t);
    const account = { autoStart: true, userId: 1000, id: 'restart-1', platform: 'qq', code: 'old' };
    h.accounts.push({ ...account });
    assert.equal(await h.manager.startWorker(account), true);
    const process = h.created[0];
    process.postMessage = message => process.messages.push(message);
    const restarting = h.manager.restartWorker({ ...account });
    if (change === 'stop') h.manager.stopWorker(account.id);
    if (change === 'deleted') h.accounts.length = 0;
    if (change === 'proxy') h.accounts[0].proxyMode = 'static';
    if (change === 'code') h.accounts[0].code = 'new';
    process.emit('exit', 0); await restarting;
    t.mock.timers.tick(2000); await setImmediate();
    assert.equal(h.created.length, 1);
    assert.equal(h.workers[account.id], undefined);
  });
}

test('restart waits for confirmed exit before starting its replacement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t);
  const account = { autoStart: true, userId: 1000, id: 'restart-timeout', platform: 'qq', code: 'old' };
  h.accounts.push(account);
  await h.manager.startWorker(account);
  h.created[0].postMessage = message => h.created[0].messages.push(message);
  const restarting = h.manager.restartWorker({ ...account });
  assert.equal(h.created.length, 1);
  h.created[0].emit('exit', 0); await restarting;
  t.mock.timers.tick(2000); await setImmediate();
  assert.equal(h.created.length, 2);
  assert.equal(h.workers[account.id].process, h.created[1]);
});

test('user cleanup waits for a thread exit even without child-process exitCode fields', async t => {
  const h = harness(t);
  const account = { autoStart: true, userId: 1000, id: 'delete-thread', platform: 'qq', code: 'fixture' };
  h.accounts.push(account);
  await h.manager.startWorker(account);
  const worker = h.created[0];
  assert.equal(worker.exitCode, undefined);
  worker.postMessage = message => worker.messages.push(message);
  let stopped = false;
  const operation = h.manager.stopWorkerAndWait(account.id).then(() => { stopped = true; });
  await setImmediate();
  assert.equal(stopped, false);
  assert.equal(worker.messages.at(-1).type, 'stop');
  worker.emit('exit', 0);
  await operation;
  assert.equal(stopped, true);
  assert.equal(h.workers[account.id], undefined);
});

test('a force-kill timeout retains the worker so a deletion retry still waits for its real exit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t); const account = { id: '1', userId: 1001, platform: 'qq', autoStart: true }; h.accounts.push(account);
  await h.manager.startWorker(account); const worker = h.created[0];
  worker.postMessage = message => worker.messages.push(message); worker.terminate = () => {};
  const first = h.manager.stopWorkerAndWait(account.id);
  await assert.rejects(h.manager.callWorkerApi(account.id, 'doFarmOp', 'harvest'), /正在停止/);
  const failure = assert.rejects(first, /停止超时/);
  t.mock.timers.tick(7000); await failure;
  assert.equal(h.workers[account.id].process, worker);
  let completed = false; const retry = h.manager.stopWorkerAndWait(account.id).then(() => { completed = true; });
  await setImmediate(); assert.equal(completed, false);
  assert.doesNotThrow(() => worker.emit('message', { type: 'status_sync', data: { status: { name: 'late-name', uin: '12345678' } } }));
  assert.equal(account.nick, undefined);
  worker.emit('exit', 0); await retry; assert.equal(completed, true);
});

test('broken stop IPC still waits for forced termination and confirmed exit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t); const account = { id: '1', userId: 1001, platform: 'qq', autoStart: true }; h.accounts.push(account);
  await h.manager.startWorker(account); const worker = h.created[0];
  worker.postMessage = () => { throw new Error('fixture IPC closed'); };
  let completed = false;
  const stopped = h.manager.stopWorkerAndWait(account.id).then(() => { completed = true; });
  const settled = Promise.allSettled([stopped]);
  assert.equal(h.scheduler.has('force_kill_1'), true);
  assert.equal(completed, false);
  t.mock.timers.tick(1000);
  assert.deepEqual((await settled).map(result => result.status), ['fulfilled']);
  assert.equal(completed, true);
  assert.equal(h.workers[account.id], undefined);
});

test('repeated QQ credential failure stops at its independent retry limit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let calls = 0;
  const h = harness(t, { autoReconnect: false }, { refreshQqCode: async () => { calls++; throw new Error('QQ 登录态已失效，请重新扫码更新'); } });
  const account = { autoStart: true, userId: 1000, id: 'qq-1', platform: 'qq', qqLoginProfile: 'fixture-profile' }; h.accounts.push(account);
  await h.manager.startWorker(account);
  for (const delay of [30000, 60000, 120000]) { t.mock.timers.tick(delay); await setImmediate(); }
  assert.equal(calls, 4); assert.equal(h.created.length, 0);
  assert.equal(h.manager.getWorkerRuntime('qq-1').reconnect.state, 'exhausted');
  assert.equal(h.scheduler.has('credential_recovery'), false);
});

for (const kind of ['rescan', 'configuration']) {
  test(`QQ ${kind} stops without consuming automatic attempts`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] }); let calls = 0;
    const h = harness(t, {}, { refreshQqCode: async () => { calls++; throw Object.assign(new Error('requires user action'), { kind }); } });
    const account = { autoStart: true, userId: 1000, id: 'qq-1', platform: 'qq', qqLoginProfile: 'fixture-profile' }; h.accounts.push(account);
    await h.manager.startWorker(account);
    assert.equal(h.manager.getWorkerRuntime(account.id).reconnect.state, kind === 'rescan' ? 'needs_rescan' : 'blocked');
    assert.equal(h.scheduler.has('reconnect_attempt_qq-1'), false);
    t.mock.timers.tick(600000); await setImmediate(); assert.equal(calls, 1);
  });
}

test('busy QQ service waits without spending retry attempts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let calls = 0;
  const h = harness(t, {}, { refreshQqCode: async () => { calls++; throw Object.assign(new Error('busy'), { status: 429 }); } });
  const account = { autoStart: true, userId: 1000, id: 'qq-1', platform: 'qq', qqLoginProfile: 'fixture-profile' }; h.accounts.push(account);
  await h.manager.startWorker(account);
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(15000); await setImmediate(); }
  const plan = h.manager.getWorkerRuntime(account.id).reconnect;
  assert.equal(calls, 6); assert.equal(plan.attempt, 0); assert.equal(plan.kind, 'busy');
  h.manager.stopWorker(account.id); assert.equal(h.scheduler.has('reconnect_attempt_qq-1'), false);
});

test('YYB explicit rescan response stops retries and never calls the credential watcher', async t => {
  const h = harness(t, { autoReconnect: true });
  const account = { autoStart: true, userId: 1000, id: '1', loginType: 'yyb', yybOpenid: 'wx-a' }; h.accounts.push(account);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 409, json: async () => ({ code: 409, msg: 're-scan required' }) }));
  await h.manager.startWorker(account);
  assert.equal(h.manager.getWorkerRuntime('1').reconnect.state, 'needs_rescan');
  assert.equal(h.scheduler.has('credential_recovery'), false);
});

test('stopping a YYB request aborts the actual upstream signal', async t => {
  const h = harness(t); let signal;
  const account = { autoStart: true, userId: 1000, id: '1', loginType: 'yyb', yybOpenid: 'wx-a' }; h.accounts.push(account);
  t.mock.method(globalThis, 'fetch', async (_url, options) => { signal = options.signal; return new Promise(() => {}); });
  const pending = h.manager.startWorker(account);
  h.manager.stopWorker('1');
  assert.equal(signal.aborted, true); assert.equal(await pending, false);
  assert.equal(h.created.length, 0);
});

for (const change of ['deleted', 'identity', 'proxy', 'code']) {
  test(`YYB startup ignores a late credential after ${change}`, async t => {
    const h = harness(t);
    const account = { autoStart: true, userId: 1000, id: '1', loginType: 'yyb', yybOpenid: 'wx-a', code: 'old' }; h.accounts.push({ ...account });
    const pending = h.manager.startWorker(account);
    if (change === 'deleted') h.accounts.length = 0;
    if (change === 'identity') h.accounts[0].yybOpenid = 'wx-b';
    if (change === 'proxy') h.accounts[0].proxyProfileId = 7;
    if (change === 'code') h.accounts[0].code = 'manual-new-code';
    h.requests.get('wx-a')();
    assert.equal(await pending, false); assert.equal(h.created.length, 0);
    if (change !== 'deleted') assert.notEqual(h.accounts[0].code, 'code-wx-a');
  });
}

test('concurrent starts of one YYB account create only one worker', async (t) => {
  const h = harness(t);
  const account = { autoStart: true, userId: 1000, id: '1', name: 'A', platform: 'wx', loginType: 'yyb', yybOpenid: 'wx-a' };
  h.accounts.push(account);
  const first = h.manager.startWorker(account);
  const second = h.manager.startWorker({ ...account });
  assert.equal(h.manager.getWorkerRuntime('1').state, 'starting');
  assert.equal(h.manager.getWorkerRuntime('1').connected, false);
  assert.equal(h.requests.size, 1);
  h.requests.get('wx-a')();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].messages[0].config.code, 'code-wx-a');
  assert.equal(h.created[0].messages[0].config.platform, 'wx');
  assert.equal(h.created[0].messages[0].config.clientVersion, '1.15.0_qq');
  assert.equal(h.created[0].messages[0].config.wxClientVersion, '1.16.0_wx');
  assert.equal(h.manager.getWorkerRuntime('1').state, 'starting');
  h.workers['1'].status = { connection: { connected: true } };
  assert.equal(h.manager.getWorkerRuntime('1').state, 'online');
});

test('runtime friend state is persisted by the parent before syncing it back to the worker', async t => {
  const h = harness(t);
  const writes = [];
  t.mock.method(store, 'applyConfigSnapshot', (patch, options) => writes.push({ patch, options }));
  h.accounts.push({ autoStart: true, userId: 1000, id: '1', name: 'fixture', loginType: 'manual', code: 'fixture' });
  await h.manager.startWorker({ autoStart: true, userId: 1000, id: '1', name: 'fixture', loginType: 'manual', code: 'fixture' });
  const worker = h.created[0];
  worker.emit('message', { type: 'automation_patch', patch: { friendHelpExpExhausted: true } });
  assert.deepEqual(writes, [{ patch: { friendHelpExpExhausted: true }, options: { accountId: '1' } }]);
  assert.equal(worker.messages.at(-1).type, 'config_sync');
});

test('known friend updates reach the parent and failed storage writes do not crash it', async t => {
  const h = harness(t);
  const writes = [];
  t.mock.method(store, 'setKnownFriendGids', (id, gids) => writes.push({ id, gids }));
  h.accounts.push({ autoStart: true, userId: 1000, id: '1', name: 'fixture', loginType: 'manual', code: 'fixture' });
  await h.manager.startWorker({ autoStart: true, userId: 1000, id: '1', name: 'fixture', loginType: 'manual', code: 'fixture' });
  const worker = h.created[0];
  worker.emit('message', { type: 'known_friend_gids_sync', gids: [101, 102] });
  assert.deepEqual(writes, [{ id: '1', gids: [101, 102] }]);
  t.mock.method(store, 'applyConfigSnapshot', () => { throw Object.assign(new Error('fixture storage failure'), { code: 'STORAGE_WRITE_FAILED' }); });
  const before = worker.messages.length;
  assert.doesNotThrow(() => worker.emit('message', { type: 'automation_patch', patch: { friendBadRetryDate: '2026-10-24' } }));
  assert.equal(worker.messages.length, before);
});

test('YYB refresh failure is visible and never starts a worker with a stale code', async (t) => {
  const h = harness(t);
  t.mock.method(globalThis, 'fetch', async () => ({ json: async () => ({ code: 502, msg: 'proxy unavailable' }) }));
  h.accounts.push({ autoStart: true, userId: 1000, id: '1', name: 'A', loginType: 'yyb', yybOpenid: 'wx-a', code: 'stale' });
  const started = await h.manager.startWorker({ autoStart: true, userId: 1000, id: '1', name: 'A', loginType: 'yyb', yybOpenid: 'wx-a', code: 'stale' });
  assert.equal(started, false);
  assert.equal(h.created.length, 0);
  assert.equal(h.manager.getWorkerRuntime('1').state, 'failed');
  assert.match(h.manager.getWorkerRuntime('1').error, /proxy unavailable/);
  h.manager.stopWorker('1');
  assert.equal(h.manager.getWorkerRuntime('1').state, 'stopped');
});

test('two YYB identities start independently and stopping A preserves B', async (t) => {
  const h = harness(t);
  h.accounts.push({ autoStart: true, userId: 1000, id: '1', name: 'A', loginType: 'yyb', yybOpenid: 'wx-a' });
  const first = h.manager.startWorker({ autoStart: true, userId: 1000, id: '1', name: 'A', loginType: 'yyb', yybOpenid: 'wx-a' });
  h.accounts.push({ autoStart: true, userId: 1000, id: '2', name: 'B', loginType: 'yyb', yybOpenid: 'wx-b' });
  const second = h.manager.startWorker({ autoStart: true, userId: 1000, id: '2', name: 'B', loginType: 'yyb', yybOpenid: 'wx-b' });
  h.requests.get('wx-b')();
  await second;
  assert.deepEqual(Object.keys(h.workers), ['2']);
  h.requests.get('wx-a')();
  await first;
  assert.equal(h.created.length, 2);
  h.manager.stopWorker('1');
  assert.deepEqual(Object.keys(h.workers), ['2']);
  assert.equal(h.workers['2'].process.messages[0].config.code, 'code-wx-b');
});

test('runtime diagnostics hide upstream proxy credentials and tokens', async (t) => {
  const h = harness(t);
  const message = 'proxy handshake failed at socks5://user:secret-pass@proxy.test:1080?key=secret-key Bearer secret-token refresh_token=secret-refresh';
  t.mock.method(globalThis, 'fetch', async () => ({ json: async () => ({ code: 502, msg: message }) }));
  h.accounts.push({ autoStart: true, userId: 1000, id: '1', name: 'A', loginType: 'yyb', yybOpenid: 'wx-a' });
  await h.manager.startWorker({ autoStart: true, userId: 1000, id: '1', name: 'A', loginType: 'yyb', yybOpenid: 'wx-a' });
  const runtime = h.manager.getWorkerRuntime('1');
  assert.equal(runtime.state, 'failed');
  assert.match(runtime.error, /proxy handshake failed/);
  assert.doesNotMatch(runtime.error, /secret-|user:|proxy\.test/);
});

test('stopping an account during code refresh cancels its pending startup', async (t) => {
  const h = harness(t);
  h.accounts.push({ autoStart: true, userId: 1000, id: '1', name: 'A', loginType: 'yyb', yybOpenid: 'wx-a' });
  const pending = h.manager.startWorker({ autoStart: true, userId: 1000, id: '1', name: 'A', loginType: 'yyb', yybOpenid: 'wx-a' });
  h.manager.stopWorker('1');
  h.requests.get('wx-a')();
  assert.equal(await pending, false);
  assert.equal(h.created.length, 0);
  assert.deepEqual(Object.keys(h.workers), []);
});

test('YYB startup refresh failures retry until a fresh code is obtained', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, { autoReconnect: true });
  const account = { autoStart: true, userId: 1000, id: '1', name: 'A', loginType: 'yyb', yybOpenid: 'wx-a', code: 'stale' };
  h.accounts.push(account);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ({ json: async () => ++calls < 3
    ? { code: 502, msg: 'refresh temporarily unavailable' }
    : { code: 0, data: { result: { code: 'fresh-code' } } } }));

  const results = await Promise.all([h.manager.startWorker(account), h.manager.startWorker(account)]);
  assert.deepEqual(results, [false, false]);
  assert.equal(calls, 1);
  assert.equal(h.manager.getWorkerRuntime('1').state, 'reconnecting');
  assert.match(h.manager.getWorkerRuntime('1').error, /temporarily unavailable/);
  assert.equal(h.manager.getWorkerRuntime('1').reconnect.attempt, 1);
  assert.equal(h.scheduler.getSnapshot().tasks.filter(task => task.name === 'reconnect_attempt_1').length, 1);

  t.mock.timers.tick(5 * 60 * 1000);
  await setImmediate();
  assert.equal(calls, 2);
  assert.equal(h.created.length, 0);
  assert.equal(h.scheduler.has('reconnect_attempt_1'), true);

  t.mock.timers.tick(10 * 60 * 1000);
  await setImmediate();
  assert.equal(calls, 3);
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].messages[0].config.code, 'fresh-code');
  assert.equal(h.scheduler.has('reconnect_attempt_1'), false);
});

test('persistent YYB refresh failures stop at the configured retry limit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, { autoReconnect: true, reconnectMaxAttempts: 2 });
  const account = { autoStart: true, userId: 1000, id: '1', name: 'A', loginType: 'yyb', yybOpenid: 'wx-a' };
  h.accounts.push(account);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { json: async () => ({ code: 502, msg: 'refresh failed' }) };
  });
  await h.manager.startWorker(account);
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(5 * 60 * 1000);
    await setImmediate();
  }
  assert.equal(calls, 3); // initial request + two automatic retries
  assert.equal(h.scheduler.has('reconnect_attempt_1'), false);
  assert.equal(h.manager.getWorkerRuntime('1').state, 'failed');
  assert.equal(h.manager.getWorkerRuntime('1').reconnect.state, 'waiting_credentials');
  assert.equal(h.created.length, 0);
});

test('a disconnected worker retains its reason and scheduled retry instead of appearing stopped', async t => {
  const h = harness(t, { autoReconnect: true });
  const account = { autoStart: true, userId: 1000, id: '1', name: 'A', loginType: 'manual', code: 'fixture' };
  h.accounts.push(account);
  await h.manager.startWorker(account);
  h.created[0].emit('message', { type: 'ws_reconnect_failed', reason: 'heartbeat_timeout' });
  const runtime = h.manager.getWorkerRuntime('1');
  assert.equal(runtime.state, 'reconnecting');
  assert.match(runtime.error, /heartbeat_timeout/);
  assert.equal(runtime.reconnect.attempt, 1);
  assert.equal(runtime.reconnect.maxAttempts, 3);
  assert.ok(runtime.reconnect.nextRetryAt > Date.now());
  h.manager.stopWorker('1');
  assert.equal(h.manager.getWorkerRuntime('1').state, 'stopped');
  assert.equal(h.manager.getWorkerRuntime('1').reconnect, null);
});

test('fresh background credentials reopen a capped retry cycle once and a manual stop cancels the watcher', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = harness(t, { autoReconnect: true, reconnectMaxAttempts: 1 });
  const account = { autoStart: true, userId: 1000, id: '1', name: 'A', loginType: 'yyb', yybOpenid: 'wx-a' };
  h.accounts.push(account);
  let recovered = false;
  let codeCalls = 0;
  let healthCalls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (!init.body) {
      healthCalls++;
      return { ok: true, json: async () => ({ code: 0, data: { expires_at: Math.floor(Date.now() / 1000) + 7200,
        refresh: { last_error: recovered ? '' : 'retry', last_success_at: recovered ? Math.floor(Date.now() / 1000) + 1 : 0 } } }) };
    }
    codeCalls++;
    return { json: async () => recovered ? { code: 0, data: { result: { code: 'fresh' } } } : { code: 502, msg: 'refresh failed' } };
  });
  await h.manager.startWorker(account);
  t.mock.timers.tick(300000); await setImmediate();
  assert.equal(codeCalls, 2);
  assert.equal(h.manager.getWorkerRuntime('1').reconnect.state, 'waiting_credentials');
  t.mock.timers.tick(60000); await setImmediate();
  assert.equal(codeCalls, 2, 'health polling cannot consume more game retries');
  recovered = true;
  t.mock.timers.tick(60000); await setImmediate();
  assert.equal(h.created.length, 1);
  assert.equal(codeCalls, 3);
  assert.equal(h.scheduler.has('credential_recovery'), false);
  assert.equal(healthCalls, 2);
  h.manager.stopWorker('1');
  t.mock.timers.tick(60000); await setImmediate();
  assert.equal(h.created.length, 1);
});

test('stopping during a credential health read blocks a late successful recovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = harness(t, { autoReconnect: true, reconnectMaxAttempts: 1 });
  const account = { autoStart: true, userId: 1000, id: '1', name: 'A', loginType: 'yyb', yybOpenid: 'wx-a' };
  h.accounts.push(account);
  let finish;
  t.mock.method(globalThis, 'fetch', async (_url, init) => init.body
    ? { json: async () => ({ code: 502, msg: 'refresh failed' }) }
    : new Promise(resolve => { finish = resolve; }));
  await h.manager.startWorker(account);
  t.mock.timers.tick(300000); await setImmediate();
  t.mock.timers.tick(60000); await setImmediate();
  assert.equal(typeof finish, 'function');
  h.manager.stopWorker('1');
  finish({ ok: true, json: async () => ({ code: 0, data: { expires_at: Date.now() / 1000 + 7200,
    refresh: { last_error: '', last_success_at: Math.floor(Date.now() / 1000) + 1 } } }) });
  await setImmediate();
  assert.equal(h.created.length, 0);
  assert.equal(h.manager.getWorkerRuntime('1').state, 'stopped');
  assert.equal(h.scheduler.has('credential_recovery'), false);
});

for (const change of ['disabled', 'deleted', 'autostart_off', 'old_success']) {
  test(`credential recovery respects ${change} without starting a worker`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const h = harness(t, { autoReconnect: true, reconnectMaxAttempts: 1 });
    const account = { autoStart: true, userId: 1000, id: '1', name: 'A', loginType: 'yyb', yybOpenid: 'wx-a' };
    h.accounts.push(account);
    t.mock.method(globalThis, 'fetch', async (_url, init) => init.body
      ? { json: async () => ({ code: 502, msg: 'refresh failed' }) }
      : { ok: true, json: async () => ({ code: 0, data: { expires_at: Date.now() / 1000 + 7200,
          refresh: { last_error: '', last_success_at: Math.floor(Date.now() / 1000) + (change === 'old_success' ? -7200 : 1) } } }) });
    await h.manager.startWorker(account);
    t.mock.timers.tick(300000); await setImmediate();
    if (change === 'disabled') h.config.autoReconnect = false;
    if (change === 'deleted') h.accounts.length = 0;
    if (change === 'autostart_off') account.autoStart = false;
    t.mock.timers.tick(60000); await setImmediate();
    assert.equal(h.created.length, 0);
    assert.equal(h.scheduler.has('reconnect_attempt_1'), false);
    assert.equal(h.scheduler.has('credential_recovery'), change === 'old_success');
  });
}

for (const response of [null, { code: 0 }, { code: 0, data: [] }, { code: 502 }, { code: '0' }, {}]) {
  test(`credential recovery ignores an invalid health envelope ${JSON.stringify(response)}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const h = harness(t, { autoReconnect: true, reconnectMaxAttempts: 1 });
    const account = { autoStart: true, userId: 1000, id: '1', name: 'A', loginType: 'yyb', yybOpenid: 'wx-a' };
    h.accounts.push(account);
    t.mock.method(globalThis, 'fetch', async (_url, init) => init.body
      ? { json: async () => ({ code: 502, msg: 'refresh failed' }) }
      : { ok: true, json: async () => response && !Object.hasOwn(response, 'data') && response.code !== 0
          ? { ...response, data: { expires_at: Date.now() / 1000 + 7200,
              refresh: { last_error: '', last_success_at: Math.floor(Date.now() / 1000) + 1 } } } : response });
    await h.manager.startWorker(account);
    t.mock.timers.tick(300000); await setImmediate();
    t.mock.timers.tick(60000); await setImmediate();
    assert.equal(h.created.length, 0);
    assert.equal(h.manager.getWorkerRuntime('1').reconnect.state, 'waiting_credentials');
    assert.equal(h.scheduler.has('credential_recovery'), true);
  });
}

test('offline reminder history waits for delivery and never claims a skipped reminder was sent', async t => {
  let finish;
  const entries = [];
  const h = harness(t, {}, { triggerOfflineReminder: () => new Promise(resolve => { finish = resolve; }),
    addAccountLog: (...entry) => entries.push(entry) });
  h.accounts.push({ autoStart: true, userId: 1000, id: '1', name: 'A', loginType: 'manual', code: 'fixture' });
  await h.manager.startWorker({ autoStart: true, userId: 1000, id: '1', name: 'A', loginType: 'manual', code: 'fixture' });
  h.workers['1'].disconnectedSince = Date.now() - 61000;
  h.created[0].emit('message', { type: 'status_sync', data: { connection: { connected: false } } });
  assert.equal(entries.some(entry => entry[0] === 'offline_reminder'), false);
  finish({ ok: false, status: 'unconfigured' });
  await setImmediate();
  const reminder = entries.find(entry => entry[0] === 'offline_reminder');
  assert.match(reminder[1], /未配置/);
  assert.doesNotMatch(reminder[1], /已发送/);
});

test('stopping a failed account without a worker cancels its scheduled retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, { autoReconnect: true });
  const account = { autoStart: true, userId: 1000, id: '1', name: 'A', loginType: 'yyb', yybOpenid: 'wx-a' };
  h.accounts.push(account);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { json: async () => ({ code: 502, msg: 'refresh failed' }) };
  });
  await h.manager.startWorker(account);
  assert.equal(h.scheduler.has('reconnect_attempt_1'), true);
  h.manager.stopWorker('1');
  assert.equal(h.scheduler.has('reconnect_attempt_1'), false);
  t.mock.timers.tick(5 * 60 * 1000);
  await setImmediate();
  assert.equal(calls, 1);
  assert.equal(h.manager.getWorkerRuntime('1').state, 'stopped');
});

test('offline auto deletion waits for the shared transaction and handles cleanup rejection', async t => {
  let rejectDeletion; let called = 0; const messages = [];
  const h = harness(t, {}, { getOfflineAutoDeleteMs: () => 1,
    deleteAccount: () => { called++; return new Promise((_resolve, reject) => { rejectDeletion = reject; }); },
    log: (_tag, message) => messages.push(message),
  });
  const account = { id: '1', userId: 1001, platform: 'qq', autoStart: true }; h.accounts.push(account);
  await h.manager.startWorker(account);
  const worker = h.created[0]; h.workers['1'].disconnectedSince = Date.now() - 100;
  worker.emit('message', { type: 'status_sync', data: { connection: { connected: false } } });
  await setImmediate(); assert.equal(called, 1);
  assert.equal(worker.messages.some(message => message.type === 'stop'), false, 'the transaction owns cancellation and confirmed exit');
  rejectDeletion(new Error('fixture cleanup failure')); await setImmediate();
  assert(messages.some(message => /删除离线账号失败/.test(message)));
  assert(!messages.some(message => /已自动删除/.test(message)));
});

test('stop during an automatic refresh prevents further startup and retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, { autoReconnect: true });
  const account = { autoStart: true, userId: 1000, id: '1', name: 'A', loginType: 'yyb', yybOpenid: 'wx-a' };
  h.accounts.push(account);
  t.mock.method(globalThis, 'fetch', async () => ({ json: async () => ({ code: 502, msg: 'refresh failed' }) }));
  await h.manager.startWorker(account);
  let finish;
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { finish = resolve; }));
  t.mock.timers.tick(5 * 60 * 1000);
  await setImmediate();
  assert.equal(typeof finish, 'function');
  h.manager.stopWorker('1');
  finish({ json: async () => ({ code: 502, msg: 'refresh failed' }) });
  await setImmediate();
  assert.equal(h.scheduler.has('reconnect_attempt_1'), false);
  assert.equal(h.manager.getWorkerRuntime('1').state, 'stopped');
  assert.equal(h.created.length, 0);
});

test('disabled reconnect, deleted accounts and changed settings prevent automatic starts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t);
  const account = { autoStart: true, userId: 1000, id: '1', name: 'A', loginType: 'yyb', yybOpenid: 'wx-a' };
  h.accounts.push(account);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { json: async () => ({ code: 502, msg: 'refresh failed' }) };
  });
  await h.manager.startWorker(account);
  assert.equal(h.scheduler.has('reconnect_attempt_1'), false);
  h.config.autoReconnect = true;
  await h.manager.startWorker(account);
  assert.equal(h.scheduler.has('reconnect_attempt_1'), true);
  h.config.autoReconnect = false;
  t.mock.timers.tick(5 * 60 * 1000);
  await setImmediate();
  assert.equal(calls, 2);
  h.config.autoReconnect = true;
  await h.manager.startWorker(account);
  h.accounts.length = 0;
  t.mock.timers.tick(5 * 60 * 1000);
  await setImmediate();
  assert.equal(calls, 3);
  assert.equal(h.scheduler.has('reconnect_attempt_1'), false);
});
