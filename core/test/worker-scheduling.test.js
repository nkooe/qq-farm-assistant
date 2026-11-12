const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const lock = require('../src/services/automation-lock');
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  const calls = { farm: 0, friend: 0, email: [] }, timers = new Map();
  const auto = { farm: true, friend: true, friend_steal: true };
  let finishFriend;
  const waiting = new Promise(resolve => { finishFriend = resolve; });
  const noop = () => {};
  const mock = new Proxy({}, { get: () => noop });
  const filename = path.resolve(__dirname, '../src/core/worker.js');
  const module = { exports: {} };
  const scheduler = { clear: name => timers.delete(name), clearAll: () => timers.clear(),
    setTimeoutTask: (name, delay, run) => timers.set(name, { delay, run }),
    setIntervalTask: (name, delay, run) => timers.set(name, { delay, run }) };
  const imports = {
    'node:process': { env: { FARM_ACCOUNT_ID: 'A' }, on: noop },
    'node:worker_threads': {},
    '../config/config': { CONFIG: { farmCheckIntervalMin: 1000, farmCheckIntervalMax: 1000 } },
    '../models/store': { getAutomation: () => auto },
    '../services/automation-lock': lock,
    '../services/scheduler': { createScheduler: () => scheduler },
    '../services/milk-tea-automation': { automation: {} },
    '../services/farm': { checkFarm: async () => { calls.farm++; } },
    '../services/friend': { checkFriends: async () => { calls.friend++; await waiting; }, computeEffectiveTurbo: () => false },
    '../services/friend-pet-sync': { isPetSyncVisiting: () => false },
    '../utils/utils': { ...mock, setLogHook: noop, log: noop, getSystemDateKey: () => '2026-11-12' },
    '../utils/network': {},
    '../utils/request-context': { runWithRequestClass: (_name, fn) => fn() },
    '../utils/request-queue': { isGatewayHealthyForBusiness: () => true },
    '../services/email': { checkAndClaimEmails: async (...args) => { calls.email.push(args); } },
  };
  imports['../utils/network'].getGatewayLoad = () => ({});
  const source = fs.readFileSync(filename, 'utf8') + `
    module.exports = { runUnifiedTick, scheduleUnifiedNextTick, startDailyRoutineTimer,
      stopUnifiedScheduler, startUnifiedScheduler,
      prepare() { loginReady = true; unifiedSchedulerRunning = true; schedulerGeneration = 1; nextFarmRunAt = nextHelpRunAt = nextStealRunAt = 0; },
      farmDue() { nextFarmRunAt = 0; },
      state() { return { farmTaskRunning, stealTaskRunning, nextStealRunAt, schedulerGeneration }; },
      onlyFarmFuture() { nextFarmRunAt = Date.now() + 10000; }
    };`;
  vm.runInNewContext(source, { module, process: imports['node:process'], require: name => imports[name] || mock }, { filename });
  return { ...module.exports, calls, auto, timers, finishFriend };
}

test('worker continues farm ticks while a steal round waits, and reconnect cannot duplicate the old round', async () => {
  const h = harness(); h.prepare();
  await h.runUnifiedTick(); await tick();
  assert.equal(h.calls.farm, 1);
  assert.equal(h.calls.friend, 1);
  assert.equal(h.state().stealTaskRunning, true);
  h.farmDue(); await h.runUnifiedTick(); await tick();
  assert.equal(h.calls.farm, 2);
  assert.equal(h.calls.friend, 1);
  h.stopUnifiedScheduler(); h.startUnifiedScheduler();
  const next = h.state().nextStealRunAt;
  await h.runUnifiedTick();
  assert.equal(h.calls.friend, 1);
  h.finishFriend(); await tick();
  assert.equal(h.state().stealTaskRunning, false);
  assert.equal(h.state().nextStealRunAt, next, 'an old completion cannot overwrite a restarted schedule');
  h.stopUnifiedScheduler();
});

test('disabled friend tasks do not wake the unified timer every 100ms', () => {
  const h = harness(); h.prepare(); h.auto.friend = false; h.onlyFarmFuture();
  h.scheduleUnifiedNextTick();
  assert.ok(h.timers.get('unified_next_tick').delay > 9000);
  h.stopUnifiedScheduler();
});

test('daily email checks keep their schedule at startup and continue within the same day', async () => {
  const h = harness(); h.prepare();
  h.startDailyRoutineTimer(); await tick();
  assert.equal(h.calls.email.length, 1);
  assert.deepEqual(h.calls.email[0], [], 'startup does not force an early email check');
  h.timers.get('daily_routine_interval').run(); await tick();
  assert.equal(h.calls.email.length, 2);
  h.stopUnifiedScheduler();
});
