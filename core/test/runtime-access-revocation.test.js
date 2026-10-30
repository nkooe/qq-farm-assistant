const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setImmediate } = require('node:timers/promises');
const userStore = require('../src/models/user-store');
const store = require('../src/models/store');
const { setAccessPolicy } = require('../src/models/access-policy');
const { createWorkerManager } = require('../src/runtime/worker-manager');
const { createDataProvider } = require('../src/runtime/data-provider');
const { createUserAccessMonitor } = require('../src/services/user-access-monitor');
const { createScheduler } = require('../src/services/scheduler');
const logger = { info() {}, warn() {}, error() {} };
let sequence = 0;

function harness(t, options = {}) {
  setAccessPolicy({ cardVerificationEnabled: false });
  const a = userStore.registerUser(`alice_${++sequence}`, 'Fixture-Password-123').user;
  const b = userStore.registerUser(`bob_${sequence}`, 'Fixture-Password-123').user;
  const accounts = [a, b].map((u, i) => ({ id: String(i + 1), userId: u.id, platform: 'qq', name: `farm-${i}`, code: 'old', autoStart: true }));
  t.mock.method(store, 'getAccounts', () => ({ accounts }));
  const workers = {}, created = [], saved = [];
  class FakeWorker extends EventEmitter {
    constructor() { super(); this.messages = []; created.push(this); }
    postMessage(message) { this.messages.push(message); if (message.type === 'stop') this.emit('exit', 0); }
    terminate() { this.emit('exit', 0); }
  }
  const manager = createWorkerManager({
    workers, WorkerThread: FakeWorker, processRef: { pkg: false }, workerScriptPath: 'fixture', globalLogs: [],
    log() {}, addAccountLog() {}, normalizeStatusForPanel: s => s,
    buildConfigSnapshotForAccount: () => ({}), resolveAccountProxy: async () => '',
    addOrUpdateAccount: patch => { saved.push(patch); Object.assign(accounts.find(a => a.id === patch.id), patch); },
    ...options,
  });
  const refreshCancelled = [];
  const provider = createDataProvider({
    workers, getAccounts: () => ({ accounts }), globalLogs: [], accountLogs: [], store,
    ...manager, cancelCodeRefresh: id => refreshCancelled.push(id), scheduleAutoCodeRefresh() {},
    getWorkerRuntime: manager.getWorkerRuntime,
  });
  t.after(() => createScheduler('worker_manager').clearAll());
  return { a, b, accounts, workers, manager, provider, created, saved, refreshCancelled };
}

test('banned, expired and absent owners cannot start workers or refresh credentials, including after boot', async t => {
  let requests = 0;
  const h = harness(t, { refreshQqCode: async () => { requests++; return 'fresh'; } });
  h.accounts[0].qqLoginProfile = 'fixture';
  userStore.updateUser(h.a.id, { enabled: false });
  assert.equal(await h.manager.startWorker(h.accounts[0]), false);
  assert.throws(() => h.provider.startAccount('1'), { status: 403 });
  setAccessPolicy({ cardVerificationEnabled: true });
  userStore.updateUser(h.a.id, { enabled: true, expiresAt: Date.now() - 1 });
  assert.equal(await h.manager.startWorker(h.accounts[0]), false);
  assert.equal(await h.manager.startWorker({ ...h.accounts[0], userId: 99999 }), false);
  assert.equal(requests, 0); assert.equal(h.created.length, 0);
});

test('late native credentials after a ban cannot save, start or schedule reconnect', async t => {
  let finish;
  const h = harness(t, { refreshQqCode: () => new Promise(resolve => { finish = resolve; }) });
  h.accounts[0].qqLoginProfile = 'fixture';
  const start = h.manager.startWorker({ ...h.accounts[0] });
  userStore.updateUser(h.a.id, { enabled: false }); finish('fresh-after-ban');
  assert.equal(await start, false); assert.deepEqual(h.saved, []); assert.equal(h.created.length, 0);
  assert.equal(createScheduler('worker_manager').has('reconnect_attempt_1'), false);
});

test('revocation stops only the owner, keeps account configuration, and unban restores only auto-start accounts', async t => {
  const h = harness(t);
  await h.manager.startWorker(h.accounts[0]); await h.manager.startWorker(h.accounts[1]);
  h.accounts.push({ ...h.accounts[0], id: 'stopped', autoStart: false });
  const native = [], jobs = [];
  const monitor = createUserAccessMonitor({ userStore, provider: h.provider, logger,
    yybRoutes: { async suspendUserState() {}, resumeUserState() {} },
    qqLogin: { async suspendUser(id) { native.push(['stop', id]); }, resumeUser(id) { native.push(['resume', id]); } },
    cancelUserJobs: async (id, ids) => jobs.push([id, ids]), cleanupSessions() {},
  });
  userStore.updateUser(h.a.id, { enabled: false }); await monitor.reconcile();
  assert.equal(h.workers['1'], undefined); assert.ok(h.workers['2']);
  assert.equal(h.accounts[0].autoStart, true); assert.equal(h.accounts.length, 3);
  assert.deepEqual(h.refreshCancelled, ['1', 'stopped']); assert.deepEqual(jobs.filter(([id]) => id === h.a.id), [[h.a.id, ['1', 'stopped']]]);
  userStore.updateUser(h.a.id, { enabled: true }); await monitor.reconcile();
  assert.ok(h.workers['1']); assert.ok(h.workers['2']); assert.equal(h.workers.stopped, undefined);
  assert.deepEqual(native.filter(([, id]) => id === h.a.id), [['stop', h.a.id], ['resume', h.a.id]]);
  monitor.close();
});

test('natural expiry is enforced without another HTTP request and monitoring closes cleanly', async t => {
  const h = harness(t);
  await h.manager.startWorker(h.accounts[0]); await h.manager.startWorker(h.accounts[1]);
  setAccessPolicy({ cardVerificationEnabled: true });
  userStore.updateUser(h.a.id, { expiresAt: Date.now() + 1500 });
  userStore.updateUser(h.b.id, { expiresAt: Date.now() + 60000 });
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: Date.now() });
  const monitor = createUserAccessMonitor({ userStore, provider: h.provider, logger,
    yybRoutes: { async suspendUserState() {}, resumeUserState() {} },
    qqLogin: { async suspendUser() {}, resumeUser() {} }, cancelUserJobs: async () => {}, cleanupSessions() {},
  });
  t.after(() => monitor.close()); monitor.start();
  t.mock.timers.tick(2000); await setImmediate();
  assert.equal(h.workers['1'], undefined); assert.ok(h.workers['2']);
});

test('proxy revocation tears down old connections, preserves selection and never creates a direct replacement', async t => {
  let allowed = true;
  const h = harness(t, { resolveAccountProxy: async () => {
    if (!allowed) throw new Error('proxy no longer shared');
    return 'socks5://fixture-proxy:1080';
  } });
  Object.assign(h.accounts[0], { proxyMode: 'static', proxyProfileId: 7 });
  await h.manager.startWorker(h.accounts[0]); await h.manager.startWorker(h.accounts[1]);
  const original = h.workers['1'].process;
  allowed = false;
  await h.provider.reloadProxyProfile(7); await setImmediate();
  assert(original.messages.some(message => message.type === 'stop'));
  assert.equal(h.workers['1'], undefined); assert.ok(h.workers['2']);
  assert.equal(h.created.length, 2); assert.equal(h.accounts[0].proxyProfileId, 7);
  assert.match(h.manager.getWorkerRuntime('1').error, /代理不可用/);
});
