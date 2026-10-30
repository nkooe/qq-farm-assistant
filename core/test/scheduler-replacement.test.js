const test = require('node:test');
const assert = require('node:assert/strict');
const { createScheduler } = require('../src/services/scheduler');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a queued immediate interval cannot run the replacement callback or duplicate it', async t => {
  const scheduler = createScheduler('fixture-replace-immediate');
  t.after(() => scheduler.clearAll());
  const calls = [];
  scheduler.setIntervalTask('same', 60000, () => calls.push('old'), { runImmediately: true });
  scheduler.setIntervalTask('same', 60000, () => calls.push('new'), { runImmediately: true });
  await tick();
  assert.deepEqual(calls, ['new']);
});

test('an old interval completion cannot unlock a replacement that is still running', async t => {
  const scheduler = createScheduler('fixture-replace-running');
  t.after(() => scheduler.clearAll());
  let finishOld, finishNew;
  scheduler.setIntervalTask('same', 60000, () => new Promise(resolve => { finishOld = resolve; }), { runImmediately: true });
  await tick();
  scheduler.setIntervalTask('same', 60000, () => new Promise(resolve => { finishNew = resolve; }), { runImmediately: true });
  await tick();
  assert.equal(scheduler.getSnapshot().tasks[0].running, true);
  finishOld(); await tick();
  assert.equal(scheduler.getSnapshot().tasks[0].running, true);
  finishNew(); await tick();
  assert.equal(scheduler.getSnapshot().tasks[0].running, false);
});
