const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createOrganicFertilizerQueue } = require('../src/services/farm-organic-queue');
const { createFertilizerConfigGuard } = require('../src/services/fertilizer-config');
const { runExclusiveAutomationTask } = require('../src/services/automation-lock');
const { createActivityAutomation } = require('../src/services/activity-automation');
const { PlantPhase } = require('../src/config/config');
const { getServerTimeSec } = require('../src/utils/utils');

function load(relative, mocks) {
  const file = path.resolve(__dirname, relative); const local = createRequire(file); const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, exports: module.exports, process, Buffer,
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : local(name),
  }, { filename: file });
  return module.exports;
}
function scheduler() {
  const tasks = new Map();
  return { tasks, clear: key => tasks.delete(key), setTimeoutTask: (key, delay, fn) => tasks.set(key, { delay, fn }),
    async tick(key = 'continue') {
      const task = tasks.get(key); assert.ok(task, 'continuation is scheduled'); tasks.delete(key); await task.fn();
    } };
}
function queueHarness(options = {}) {
  const timer = scheduler(); const writes = []; const progress = []; const errors = []; const reads = [];
  let allowed = true;
  const queue = createOrganicFertilizerQueue({ scheduler: timer,
    runExclusive: fn => runExclusiveAutomationTask('organic_test', fn, { detached: true }),
    prepare: async ids => { reads.push(ids); return new Map(ids.map(id => [id, 'crop:1'])); },
    send: async (id, guard) => { assert.equal(guard(), true); writes.push(id); },
    delay: async (min, max) => { assert.equal(min, 1000); assert.equal(max, 1500); },
    onProgress: n => progress.push(n), onError: error => errors.push(error), ...options,
  });
  return { ...queue, timer, writes, progress, errors, reads, allowed: () => allowed,
    stop: () => { allowed = false; }, async finish() { while (timer.tasks.size) await timer.tick(); } };
}
const growing = (id = 1) => ({ id, unlocked: true, level: 1, plant: { id: 20001, season: 1, left_inorc_fert_times: 2,
  phases: [{ phase: PlantPhase.GERMINATION, begin_time: getServerTimeSec() - 10 },
    { phase: PlantPhase.MATURE, begin_time: getServerTimeSec() + 120 }] } });

test('organic work yields the real account lock between batches, resumes round-robin, and records each success once', async () => {
  const h = queueHarness();
  assert.equal(await runExclusiveAutomationTask('farm', () => h.enqueue([1, 2, 1], h.allowed)), 4);
  assert.deepEqual(h.writes, [1, 2, 1, 2]);
  await runExclusiveAutomationTask('ranch', () => h.writes.push('ranch'));
  await h.timer.tick();
  assert.equal(h.writes[4], 'ranch');
  assert.deepEqual(h.writes.slice(5), [1, 2, 1, 2]);
  await h.finish();
  assert.equal(h.writes.filter(id => id === 1).length, 20);
  assert.equal(h.writes.filter(id => id === 2).length, 20);
  assert.equal(h.progress.reduce((a, b) => a + b, 0), 40);
  assert.equal(h.reads.length, 10);
});
test('organic cycles retain the global cap and merging duplicate requests does not reset progress', async () => {
  const h = queueHarness();
  await h.enqueue([1], h.allowed);
  assert.equal(await h.enqueue(Array.from({ length: 13 }, (_, i) => i + 1), h.allowed), 0);
  assert.equal(h.writes.length, 4);
  await h.finish();
  assert.equal(h.writes.length, 240);
  for (const id of new Set(h.writes)) assert.ok(h.writes.filter(value => value === id).length <= 20);
});
test('pending farm work defers a continuation without reading or consuming resources', async () => {
  let busy = true;
  const h = queueHarness({ runExclusive: fn => busy ? undefined : fn() });
  await h.enqueue([1], h.allowed);
  await h.timer.tick();
  assert.equal(h.reads.length, 1);
  assert.equal(h.writes.length, 4);
  busy = false;
  await h.timer.tick();
  assert.equal(h.writes.length, 8);
  h.stop(); await h.finish();
});
test('organic continuation drops mature, removed, and replaced crops from a fresh snapshot', async () => {
  let reads = 0;
  const h = queueHarness({ prepare: async ids => {
    reads++;
    return reads === 1 ? new Map(ids.map(id => [id, 'original'])) : new Map([[1, 'new crop']]);
  } });
  await h.enqueue([1, 2], h.allowed);
  await h.finish();
  assert.equal(h.writes.length, 4);
  assert.equal(reads, 2);
});
test('pausing during the continuation land read or before a queued send prevents further fertilizer consumption', async () => {
  for (const stage of ['read', 'send']) {
    let reads = 0;
    const h = queueHarness({
      prepare: async ids => { if (++reads === 2 && stage === 'read') h.stop(); return new Map(ids.map(id => [id, 'original'])); },
      send: async (id, guard) => {
        if (reads === 2 && stage === 'send') h.stop();
        if (!guard()) throw Object.assign(new Error('stopped'), { code: 'FARM_STOPPED' });
        h.writes.push(id);
      },
    });
    await h.enqueue([1], h.allowed);
    await h.finish();
    assert.equal(h.writes.length, 4);
  }
});
test('an uncertain organic write is not retried and prior confirmed progress is retained', async () => {
  let sends = 0;
  const h = queueHarness({ send: async () => { if (++sends === 3) throw new Error('reply timeout'); } });
  await assert.rejects(h.enqueue([1], h.allowed), /reply timeout/);
  assert.deepEqual(h.progress, [2]);
  assert.equal(h.timer.tasks.size, 0);
  assert.equal(sends, 3);
});
test('independent organic queues never share cancellation or progress', async () => {
  const a = queueHarness(); const b = queueHarness();
  await a.enqueue([1], a.allowed); await b.enqueue([1], b.allowed);
  a.stop(); await a.finish(); await b.finish();
  assert.equal(a.writes.length, 4);
  assert.equal(b.writes.length, 20);
});
test('fertilizer revision invalidates changed-and-restored settings and stays isolated by account', () => {
  const store = require('../src/models/store');
  const config = { fertilizer: 'normal', fertilizer_land_types: ['normal'], fertilizer_smart_seconds: 300 };
  store.applyConfigSnapshot({ automation: config }, { accountId: 'fertilizer-A', persist: false });
  const bound = { getAutomation: () => store.getAutomation('fertilizer-A'),
    getFertilizerConfigRevision: () => store.getFertilizerConfigRevision('fertilizer-A') };
  const guard = createFertilizerConfigGuard(bound.getAutomation(), () => true, bound);
  store.setAutomation('fertilizer', 'none', 'fertilizer-B');
  assert.equal(guard(), true);
  store.setAutomation('fertilizer', 'none', 'fertilizer-A');
  store.setAutomation('fertilizer', 'normal', 'fertilizer-A');
  assert.equal(guard(), false);
  const fresh = createFertilizerConfigGuard(bound.getAutomation(), () => true, bound);
  store.setAutomation('fertilizer_land_types', ['normal'], 'fertilizer-A');
  store.setAutomation('farm_harvest_tiangong', false, 'fertilizer-A');
  assert.equal(fresh(), true, 'unrelated or unchanged settings preserve pending work');
});
test('normal and ripening fertilizer recheck mode, scope, threshold and multi-season policy after reads and before send', async () => {
  const changes = [{ fertilizer: 'none' }, { fertilizer_land_types: [] },
    { fertilizer_smart_seconds: 60 }, { fertilizer_multi_season: false }];
  for (const ripening of [false, true]) for (const change of changes) for (const stage of ['read', 'send']) {
    let config = { fertilizer: ripening ? 'normal_ripen' : 'normal', fertilizer_land_types: ['normal'],
      fertilizer_smart_seconds: 300, fertilizer_multi_season: true };
    let writes = 0;
    const mutate = () => { config = { ...config, ...change }; };
    const mocks = {
      '../models/store': { getAutomation: () => config, getFertilizerConfigRevision: () => 0 },
      './farm-api': { NORMAL_FERTILIZER_ID: 1011,
        getAllLands: async () => { if (stage === 'read') mutate(); return { lands: [growing()] }; },
        fertilize: async (_ids, _type, hooks) => {
          if (stage === 'send') mutate();
          if (!hooks.canContinue()) return 0;
          const blocked = hooks.beforeSend(); if (blocked) throw blocked;
          writes++; return 1;
        },
        fertilizeBatch: async (_ids, _type, hooks) => {
          if (stage === 'send') mutate();
          const blocked = hooks.beforeSend(); if (blocked) throw blocked;
          writes++; return { land: [{ id: 1 }] };
        },
      },
      './stats': { recordOperation() {} },
    };
    const service = load(`../src/services/${ripening ? 'farm-ripening' : 'farm-fertilizer'}.js`, mocks);
    if (ripening) assert.equal(await service.runRipeningFertilizer(config), 0);
    else assert.equal((await service.runFertilizerByConfig([1])).normal, 0);
    assert.equal(writes, 0, `${ripening ? 'ripening' : 'normal'} / ${stage} / ${Object.keys(change)[0]}`);
  }
});
test('activity reports queued until it acquires the account lock and cannot start after cancellation', async () => {
  for (const cancel of [false, true]) {
    const timer = scheduler(); let releaseLock; let startLock; let releaseWork; let runs = 0;
    const acquired = new Promise(resolve => { startLock = resolve; });
    const busy = runExclusiveAutomationTask('farm', () => new Promise(resolve => { releaseLock = resolve; startLock(); }));
    await acquired;
    const service = createActivityAutomation({ scheduler: timer, runningMessage: '自动领奖中',
      execute: (allowed, onStarted) => runExclusiveAutomationTask('activity', async () => {
        if (!onStarted()) return { status: 'paused', completed: [] };
        assert.equal(allowed(), true); runs++;
        await new Promise(resolve => { releaseWork = resolve; });
        return { status: 'idle', message: '暂无奖励', completed: [] };
      }, { detached: true }),
    });
    service.start({ ready: () => true });
    const pending = timer.tick('check');
    assert.equal(service.snapshot().status, 'queued');
    assert.equal(service.snapshot().message, '排队中');
    assert.equal(runs, 0);
    if (cancel) service.stop();
    releaseLock(); await busy;
    await new Promise(resolve => setImmediate(resolve));
    if (cancel) assert.equal(runs, 0);
    else {
      assert.equal(service.snapshot().status, 'running');
      assert.equal(service.snapshot().message, '自动领奖中');
      releaseWork();
    }
    await pending;
    assert.equal(service.snapshot().status, cancel ? 'paused' : 'idle');
    service.stop(); assert.equal(timer.tasks.size, 0);
  }
});

function organicService(fertilizer = 'organic') {
  const timer = scheduler(); const writes = []; const stats = [];
  let config = { fertilizer, fertilizer_land_types: ['normal'], fertilizer_smart_seconds: 300 };
  let revision = 0; let online = true; let socket = {};
  let lands = [growing()]; let reads = 0;
  const service = load('../src/services/farm-fertilizer.js', {
    '../models/store': { getAutomation: () => config, getFertilizerConfigRevision: () => revision },
    './scheduler': { createScheduler: () => timer },
    './farm-api': { ORGANIC_FERTILIZER_ID: 1012, getAllLands: async () => { reads++; return { lands }; } },
    './stats': { recordOperation: (type, count) => stats.push([type, count]) },
    '../utils/network': { getWs: () => socket, isConnected: () => online,
      sendMsgAsync: async (_service, _method, payload, hooks) => {
        const blocked = hooks.beforeSend(); if (blocked) throw blocked;
        writes.push(payload.land_ids[0]);
      } },
    '../utils/proto': { types: { FertilizeRequest: { create: value => value, encode: value => ({ finish: () => value }) } } },
    '../utils/utils': { ...require('../src/utils/utils'), log() {}, logWarn() {}, randomDelay: async () => {} },
  });
  return { ...service, timer, writes, stats, reads: () => reads,
    setLands: value => { lands = value; },
    configure: patch => { config = { ...config, ...patch }; revision++; },
    disconnect: () => { online = false; }, reconnect: () => { socket = {}; },
    async finish() { while (timer.tasks.size) await timer.tick(); },
  };
}
test('production organic strategies keep running in batches and count success exactly once', async () => {
  for (const mode of ['organic', 'both', 'smart', 'smart_only', 'final_organic']) {
    const h = organicService(mode);
    assert.equal(await h.fertilizeOrganicLoop([1]), 4, mode);
    await h.finish();
    assert.equal(h.writes.length, 20, mode);
    assert.equal(h.stats.reduce((n, [type, count]) => { assert.equal(type, 'fertilize'); return n + count; }, 0), 20);
  }
});
test('organic continuations stop on configuration change, disconnect and socket replacement without another land read', async () => {
  for (const stop of [h => h.configure({ fertilizer_land_types: [] }), h => h.disconnect(), h => h.reconnect()]) {
    const h = organicService();
    await h.fertilizeOrganicLoop([1]);
    stop(h);
    await h.finish();
    assert.equal(h.writes.length, 4);
    assert.equal(h.reads(), 1);
  }
});
test('organic preparation excludes mature plots, slaves and unselected land types', async () => {
  const h = organicService();
  const mature = growing(2); mature.plant.phases[1].begin_time = getServerTimeSec() - 1;
  const red = growing(3); red.level = 2;
  const slave = growing(4); slave.master_land_id = 1;
  h.setLands([growing(), mature, red, slave]);
  await h.fertilizeOrganicLoop([1, 2, 3, 4]); await h.finish();
  assert.deepEqual([...new Set(h.writes)], [1]);
  assert.equal(h.writes.length, 20);
});
test('replanted crops get new progress while changes to future maturity time preserve existing progress', async () => {
  const h = organicService(); const land = growing();
  h.setLands([land]); await h.fertilizeOrganicLoop([1]);
  land.plant.phases[1].begin_time -= 20;
  await h.fertilizeOrganicLoop([1]);
  await h.timer.tick();
  assert.equal(h.writes.length, 8);
  land.plant.phases[0].begin_time += 1; // Same seed/season, new sowing instance.
  await h.fertilizeOrganicLoop([1]);
  await h.finish();
  assert.equal(h.writes.length, 28, 'the new crop receives twenty operations without inheriting the old eight');
});
test('production activity adapters mark running only inside the exclusive task', async () => {
  for (const [file, moduleName, method] of [
    ['muge-automation', '../modern/services/muge-activity', 'runMugeAutomation'],
    ['milk-tea-automation', '../modern/services/milk-tea', 'runMilkTeaAutomation'],
  ]) {
    const timer = scheduler(); let release; let acquired; let finish; let runs = 0;
    const ready = new Promise(resolve => { acquired = resolve; });
    const busy = runExclusiveAutomationTask('farm', () => new Promise(resolve => { release = resolve; acquired(); }));
    await ready;
    const { automation } = load(`../src/services/${file}.js`, {
      './scheduler': { createScheduler: () => timer },
      [moduleName]: { [method]: async () => {
        runs++; await new Promise(resolve => { finish = resolve; });
        return { status: 'idle', message: '暂无奖励', completed: [] };
      } },
    });
    automation.start({ ready: () => true });
    const pending = timer.tick('check');
    assert.equal(automation.snapshot().status, 'queued'); assert.equal(runs, 0);
    release(); await busy; await new Promise(resolve => setImmediate(resolve));
    assert.equal(automation.snapshot().status, 'running'); assert.equal(runs, 1);
    finish(); await pending; automation.stop();
  }
});
