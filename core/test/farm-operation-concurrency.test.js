const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createSelectedFarmOperations } = require('../src/services/farm-selected-operations');

function harness(t) {
  const filename = path.resolve(__dirname, '../src/services/farming-orchestrator.js');
  const localRequire = createRequire(filename);
  const analysis = { harvestable: [], needWeed: [], needBug: [], needGoldenBug: [], needWater: [],
    dead: [], empty: [1], unlockable: [], upgradable: [], growing: [] };
  let release; const reads = []; const mutations = [];
  const context = { module: { exports: {} }, require(name) {
    if (name === './farm-api') return { getAllLands: async () => {
      reads.push('read');
      if (reads.length === 1) await new Promise(resolve => { release = resolve; });
      return { lands: [{ id: 1 }] };
    } };
    if (name === '../models/store') return { isAutomationOn: key => key === 'farm',
      getAutomation: () => ({ fertilizer: 'none' }), getPrioritize2x2Crops: () => false };
    if (name === '../utils/network') return { getUserState: () => ({ gid: 1 }), isConnected: () => true,
      networkEvents: new (require('node:events').EventEmitter)() };
    if (name === './farm-land-analyzer') return { analyzeLands: () => analysis };
    if (name === './planting-service') return { autoPlantEmptyLands: async () => {
      mutations.push('plant'); return { plantedCount: 1 };
    } };
    if (name === './stats') return { recordOperation() {} };
    if (name === '../utils/utils') return { ...localRequire(name), log() {}, logWarn() {} };
    return localRequire(name);
  } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const api = context.module.exports;
  t.after(() => api.stopFarmCheckLoop());
  return { ...api, reads, mutations, release: () => release() };
}

test('automatic farm work excludes manual whole-farm mutations until its snapshot is consumed', async t => {
  const h = harness(t);
  const first = h.checkFarm();
  await assert.rejects(h.runFarmOperation('plant'), /正在进行/);
  assert.equal(h.reads.length, 1);
  h.release();
  assert.equal(await first, true);
  await h.runFarmOperation('plant');
  assert.equal(h.mutations.length, 2);
});

test('selected operations share the account farm guard and release after read failures', async () => {
  const { createFarmOperationGuard } = require('../src/services/farm-operation-guard');
  const guard = createFarmOperationGuard();
  let release;
  const busy = guard.run(() => new Promise(resolve => { release = resolve; }));
  const h = createSelectedFarmOperations({ runExclusive: guard.run,
    getAllLands: async () => { throw new Error('fixture read failure'); } });
  await assert.rejects(h.operate('remove', [1]), /正在进行/);
  release(); await busy;
  await assert.rejects(h.operate('remove', [1]), /fixture read failure/);
  assert.equal(guard.isPending(), false);
});

test('manual farm work excludes automatic checks and independent account guards proceed', async t => {
  const h = harness(t);
  const manual = h.runFarmOperation('plant');
  assert.equal(await h.checkFarm(), false);
  assert.equal(h.reads.length, 1);
  const { createFarmOperationGuard } = require('../src/services/farm-operation-guard');
  assert.equal(await createFarmOperationGuard().run(async () => 'other account'), 'other account');
  h.release(); await manual;
  assert.equal(await h.checkFarm(), true);
});
