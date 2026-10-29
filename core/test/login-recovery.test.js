const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoginRecovery, LoginRecoveryError, requestDeadline } = require('../src/services/login-recovery');

test('same account requests share one operation while other accounts remain independent', async () => {
  const recovery = createLoginRecovery();
  const account = { id: '1', code: 'old' };
  let finish; let calls = 0;
  const operation = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = recovery.run(account, 'qq', operation);
  const second = recovery.run({ ...account }, 'qq', operation);
  assert.equal(first, second);
  assert.equal(await recovery.run({ id: '2' }, 'yyb', async () => 'other'), 'other');
  finish('private-code');
  assert.equal(await first, 'private-code');
  assert.equal(calls, 1);
  const state = recovery.getState('1');
  assert.equal(state.state, 'success');
  assert(!JSON.stringify(state).includes('private-code'));
});

test('cancelled calls settle even when an upstream ignores abort and cannot overwrite the new task', async () => {
  const recovery = createLoginRecovery();
  let late;
  const old = recovery.run({ id: '1' }, 'qq', () => new Promise(resolve => { late = resolve; }));
  const rejected = assert.rejects(old, error => error.kind === 'cancelled');
  recovery.cancel('1');
  await rejected;
  assert.equal(await recovery.run({ id: '1', code: 'updated' }, 'qq', async () => 'fresh'), 'fresh');
  const state = recovery.getState('1');
  late('stale');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(recovery.getState('1'), state);
});

test('failed result envelopes do not claim a successful credential refresh', async () => {
  const recovery = createLoginRecovery();
  await recovery.run({ id: '1' }, 'yyb', async () => ({ ok: false, kind: 'rescan' }));
  assert.equal(recovery.getState('1').state, 'failed');
  assert.equal(recovery.getState('1').kind, 'rescan');
  assert.equal(recovery.getState('1').lastSuccessAt, null);
});

test('queue state and cancellation follow the owning operation', async () => {
  const recovery = createLoginRecovery();
  const controller = new AbortController();
  const pending = recovery.run({ id: '1' }, 'qq', async ({ mark }) => { mark('queued'); return new Promise(() => {}); }, { signal: controller.signal });
  assert.equal(recovery.getState('1').state, 'queued');
  const rejected = assert.rejects(pending, error => error.kind === 'cancelled');
  controller.abort(); await rejected;
  assert.equal(recovery.getState('1').state, 'cancelled');
});

test('request deadline enforces timeout and forwards cancellation', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const deadline = requestDeadline(undefined, 25000);
  t.mock.timers.tick(24999); assert.equal(deadline.signal.aborted, false);
  t.mock.timers.tick(1); assert.equal(deadline.signal.reason.kind, 'timeout'); deadline.close();
  const controller = new AbortController();
  const cancelled = requestDeadline(controller.signal, 45000);
  controller.abort(); assert.equal(cancelled.signal.aborted, true); cancelled.close();
  assert.equal(new LoginRecoveryError('error token=private-value', 'temporary').message.includes('private-value'), false);
});
