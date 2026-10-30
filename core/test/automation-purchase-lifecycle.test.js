const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const tick = () => new Promise(resolve => setImmediate(resolve));

function load(filename, mocks, globals = {}) {
  const file = path.resolve(__dirname, filename), localRequire = createRequire(file);
  const context = { module: { exports: {} }, setInterval, clearInterval, AbortController, ...globals,
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : localRequire(name) };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return context.module.exports;
}

test('saving fertilizer switches and interval refreshes its timer without restarting the account', t => {
  const changes = [];
  const api = load('../src/services/farming-orchestrator.js', {
    './farm-scheduler': { startFertilizerBuyCheckTimer() {}, stopFertilizerBuyCheckTimer() {},
      refreshFertilizerBuyCheckTimer: () => changes.push('refresh') },
    './mystery-scheduler': { startMysteryAutoBuyTimer() {}, stopMysteryAutoBuyTimer() {} },
    '../utils/network': { networkEvents: new EventEmitter() },
  });
  t.after(() => api.stopFarmCheckLoop());
  api.startFarmCheckLoop({ externalScheduler: true });
  api.refreshFarmCheckLoop(3000);
  assert.deepEqual(changes, ['refresh']);
});

test('stopping mystery automation during its lookup prevents a late purchase', async t => {
  let finish, signal; const buys = [];
  const api = load('../src/services/mystery-scheduler.js', {
    '../models/store': { isMysteryAutoBuyOn: () => true, getMysteryAutoBuyCurrencies: () => [1001] },
    './mystery-shop': { getActiveMysteryShop: () => {
      signal = require('../src/utils/request-context').getAmbientRequestSignal();
      return new Promise(resolve => { finish = resolve; });
    },
      buyMysteryShopGoods: async id => buys.push(id) },
    '../utils/utils': { toNum: Number, log() {}, logWarn() {} },
  });
  t.after(() => api.stopMysteryAutoBuyTimer());
  api.startMysteryAutoBuyTimer();
  api.stopMysteryAutoBuyTimer();
  assert.equal(signal.aborted, true);
  finish({ active: true, npcId: 7, currencyId: 1001 });
  await tick();
  assert.deepEqual(buys, []);
});

test('mystery purchase rechecks currency configuration after lookup and blocks overlapping cycles', async t => {
  let finish, enabled = true, currencies = [1001], reads = 0; const buys = [];
  const api = load('../src/services/mystery-scheduler.js', {
    '../models/store': { isMysteryAutoBuyOn: () => enabled, getMysteryAutoBuyCurrencies: () => currencies },
    './mystery-shop': { getActiveMysteryShop: () => { reads++; return new Promise(resolve => { finish = resolve; }); },
      buyMysteryShopGoods: async id => buys.push(id) },
    '../utils/utils': { toNum: Number, log() {}, logWarn() {} },
  });
  t.after(() => api.stopMysteryAutoBuyTimer());
  api.startMysteryAutoBuyTimer();
  const duplicate = api.checkMysteryAutoBuyOnce();
  assert.equal(reads, 1);
  currencies = [1002];
  finish({ active: true, npcId: 7, currencyId: 1001 });
  await duplicate; await tick();
  assert.deepEqual(buys, []);
});

test('fertilizer timer follows current switches and interval and never overlaps its previous check', async t => {
  const { createScheduler } = require('../src/services/scheduler');
  const scheduler = createScheduler('farm_fertilizer_buy');
  let enabled = false, interval = 1, calls = 0, finish, signal;
  const api = load('../src/services/farm-scheduler.js', {
    '../models/store': { isAutomationOn: key => enabled && key === 'fertilizer_buy_normal',
      getFertilizerBuyCheckIntervalMinutes: () => interval,
      getFertilizerBuyOrganicCount: () => 1, getFertilizerBuyOrganicThresholdHours: () => 1,
      getFertilizerBuyNormalCount: () => 1, getFertilizerBuyNormalThresholdHours: () => 1 },
    './mall': { checkAndBuyFertilizerBoth: () => {
      calls++; signal = require('../src/utils/request-context').getAmbientRequestSignal();
      return new Promise(resolve => { finish = resolve; });
    } },
    '../utils/utils': { log() {}, logWarn() {} },
  });
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => api.stopFertilizerBuyCheckTimer());
  api.startFertilizerBuyCheckTimer();
  assert.equal(scheduler.getSnapshot().taskCount, 0);
  enabled = true; api.refreshFertilizerBuyCheckTimer();
  assert.equal(scheduler.getSnapshot().tasks[0].delayMs, 60000);
  t.mock.timers.tick(60000); await tick();
  assert.equal(calls, 1);
  interval = 2; api.refreshFertilizerBuyCheckTimer();
  assert.equal(signal.aborted, true, '过期配置必须撤销尚未完成的购买链');
  assert.equal(scheduler.getSnapshot().tasks[0].delayMs, 120000);
  t.mock.timers.tick(120000); await tick();
  assert.equal(calls, 1);
  finish(); await tick();
  enabled = false; api.refreshFertilizerBuyCheckTimer();
  assert.equal(scheduler.getSnapshot().taskCount, 0);
});
