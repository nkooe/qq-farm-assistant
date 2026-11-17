const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const lock = require('../src/services/automation-lock');

function load(relative, mocks) {
  const filename = path.resolve(__dirname, relative), local = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, process, Buffer, AbortController, setTimeout, clearTimeout,
    require: key => Object.hasOwn(mocks, key) ? mocks[key] : local(key),
  }, { filename });
  return module.exports;
}

test('ranch configuration validates exact types and leaves other account strategies intact', () => {
  const store = require('../src/models/store');
  const config = require('../src/modern/config/ranch-automation');
  for (const [key, bad] of [['ranch_harvest', 'false'], ['ranch_check_minutes', '5'], ['ranch_check_minutes', 0],
    ['ranch_grass_threshold_percent', 101], ['ranch_coop_animal', null], ['ranch_strategy', 'invalid']]) {
    assert.throws(() => config.normalizeRanchSetting(key, bad), { code: 'INVALID_CONFIG' });
  }
  store.applyConfigSnapshot({ plantingStrategy: 'preferred', automation: { farm: false } }, { accountId: 'ranch-A' });
  const before = store.getConfigSnapshot('ranch-B');
  store.applyConfigSnapshot({ automation: { ranch_check_minutes: 7, ranch_harvest: false } }, { accountId: 'ranch-A' });
  assert.equal(store.getConfigSnapshot('ranch-A').plantingStrategy, 'preferred');
  assert.equal(store.getConfigSnapshot('ranch-A').automation.farm, false);
  assert.equal(store.getConfigSnapshot('ranch-A').automation.ranch_check_minutes, 7);
  assert.deepEqual(store.getConfigSnapshot('ranch-B'), before);
});

test('settings provider persists ranch-only patches and broadcasts after validation', async () => {
  const store = require('../src/models/store');
  const account = store.addOrUpdateAccount({ userId: 1001, platform: 'qq' }).accounts.at(-1);
  const events = [];
  const provider = require('../src/runtime/data-provider').createDataProvider({ store, workers: {}, getAccounts: store.getAccounts,
    nextConfigRevision: () => 1, broadcastConfigToWorkers: id => events.push(id) });
  const before = store.getConfigSnapshot(account.id);
  const result = await provider.saveSettings(account.id, { automation: { ranch_check_minutes: 9 } });
  assert.equal(result.automation.ranch_check_minutes, 9);
  assert.equal(store.getAutomation(account.id).ranch_check_minutes, 9);
  assert.equal(store.getConfigSnapshot(account.id).plantingStrategy, before.plantingStrategy);
  assert.equal(store.getAutomation(account.id).farm, before.automation.farm);
  await assert.rejects(provider.saveSettings(account.id, { automation: { ranch_check_minutes: '9' } }), { code: 'INVALID_CONFIG' });
  assert.deepEqual(events, [account.id]);
});

test('large QQ friend lookup aborts the remaining batches when the gateway yields', async () => {
  const proto = require('../src/utils/proto'); await proto.loadProto();
  let requests = 0;
  const gids = Array.from({ length: 140 }, (_, index) => index + 1);
  const api = load('../src/services/friend-api.js', {
    '../config/config': { CONFIG: { platform: 'qq' } },
    '../models/store': { getKnownFriendGids: () => gids, getFriendBlacklist: () => [] },
    '../utils/utils': { toNum: Number, toLong: Number, log() {}, logWarn() {}, randomDelay: async () => {} },
    '../utils/network': { getGatewayLoad: () => ({ oldestPendingAgeMs: 0 }), sendMsgAsync: async () => {
      if (++requests === 2) throw Object.assign(new Error('request timeout (stage=pending)'), { stage: 'pending' });
      return { body: proto.types.GetAllFriendsReply.encode({ game_friends: [{ gid: 1 }] }).finish() };
    } },
  });
  await assert.rejects(api.getAllFriends(), /stage=pending/);
  assert.equal(requests, 2, 'no partial success or remaining request storm');
});

test('ranch patrol yields to a farm deadline before switching scenes', async () => {
  let entered = 0;
  const api = load('../src/modern/services/ranch/automation.js', {
    '../../models/store': { getAutomation: () => ({ ranch_harvest: true, ranch_check_minutes: 5 }) },
    './transport': { isUnlocked: () => true, inScene: async () => { entered++; } },
  });
  await api.run({ farmDeadline: () => Date.now() - 1 });
  assert.equal(entered, 0);
  assert.ok(api.getRoutineState().nextCheckAt > Date.now());
  api.resetSchedule();
  await api.run({ canContinue: () => false });
  assert.equal(entered, 0);
});

test('ranch scene restores after a failed operation and invalidates an unconfirmed restore', async () => {
  for (const mode of ['success', 'write-error', 'restore-error', 'disconnected']) {
    const calls = [], socket = {};
    let ws = socket;
    const network = {
      getUserState: () => ({ globalSceneId: 1, unlockedSceneIds: [1, 2] }), getWs: () => ws,
      loginGameScene: async id => { calls.push(id); if (id === 1 && mode === 'restore-error') throw new Error('restore'); return { big_farm_scene_ext_data: [] }; },
      invalidateGameScene: () => calls.push('invalidate'),
    };
    const transport = load('../src/modern/services/ranch/transport.js', {
      '../../utils/network': network, '../automation-lock': lock,
      '../../utils/proto': { types: { RanchSceneData: { decode: () => ({ homestead_cells: [] }) } } },
      '../../utils/utils': { logWarn() {} },
    });
    const run = transport.inScene(async () => {
      if (mode === 'write-error') throw new Error('write');
      if (mode === 'disconnected') ws = null;
      return { status: 'ok' };
    });
    if (mode === 'write-error') await assert.rejects(run, /write/);
    else {
      const result = await run;
      if (mode === 'restore-error') assert.equal(result.sceneRestored, false);
    }
    assert.deepEqual(calls, mode === 'restore-error' ? [2, 1, 'invalidate'] : mode === 'disconnected' ? [2] : [2, 1]);
  }
});

test('farm jobs wait until a ranch scene transaction restores the original scene', async () => {
  let finish;
  const events = [];
  const ranch = lock.runExclusiveAutomationTask('ranch', async () => {
    events.push('scene2'); await new Promise(resolve => { finish = resolve; }); events.push('scene1');
  });
  await new Promise(resolve => setImmediate(resolve));
  const farm = lock.runExclusiveAutomationTask('farm', () => events.push('farm'));
  assert.deepEqual(events, ['scene2']);
  finish(); await Promise.all([ranch, farm]);
  assert.deepEqual(events, ['scene2', 'scene1', 'farm']);
});

test('unknown ranch writes reserve resources across restarts, isolate accounts and are removed on deletion', async () => {
  const previous = process.env.FARM_ACCOUNT_ID;
  test.after(() => { if (previous === undefined) delete process.env.FARM_ACCOUNT_ID; else process.env.FARM_ACCOUNT_ID = previous; });
  const file = '../src/modern/services/ranch/operation-state';
  process.env.FARM_ACCOUNT_ID = 'ledger-A';
  const context = require('../src/modern/services/ranch/context');
  const plan = { target: 'buy:1', label: '购买', costs: [{ resourceKey: 'item:1007', amount: '8' }],
    balances: [{ resourceKey: 'item:1007', state: 'known', total: '10', locked: '0' }] };
  let ledger = require(file).forCurrentAccount();
  await assert.rejects(ledger.spend(plan, async () => {
    context.getAmbientSendContext().onSent('shop', 'Buy'); throw new Error('reply lost');
  }), err => err.outcomeUnknown === true);
  delete require.cache[require.resolve(file)];
  ledger = require(file).forCurrentAccount();
  assert.equal(ledger.reserved('item:1007'), '8');
  await assert.rejects(ledger.spend(plan, () => assert.fail('must not replay')), { code: 'PENDING_CONFIRMATION' });
  await assert.rejects(ledger.spend({ ...plan, target: 'buy:2' }, () => assert.fail('must not overspend')), { code: 'RESERVE_PROTECTED' });
  process.env.FARM_ACCOUNT_ID = 'ledger-B';
  assert.equal(require(file).forCurrentAccount().reserved('item:1007'), '0');
  const digest = createHash('sha256').update('ledger-A').digest('hex');
  const filename = path.join(process.env.FARM_DATA_DIR, 'ranch-operations', `${digest}.json`);
  assert.equal(fs.existsSync(filename), true);
  require('../src/models/store').deleteAccount('ledger-A');
  assert.equal(fs.existsSync(filename), false);
});

test('ranch requests rejected before send or by the matching gateway error release reservations', async () => {
  const previous = process.env.FARM_ACCOUNT_ID;
  try {
    process.env.FARM_ACCOUNT_ID = 'ledger-rejected';
    const ledger = require('../src/modern/services/ranch/operation-state').forCurrentAccount();
    const context = require('../src/modern/services/ranch/context');
    const plan = { target: 'buy', label: '购买', costs: [], balances: [] };
    for (const sent of [false, true]) {
      await assert.rejects(ledger.spend(plan, async () => {
        if (sent) context.getAmbientSendContext().onSent('shop', 'Buy');
        throw Object.assign(new Error('denied'), { name: 'GatewayError', serviceName: 'shop', methodName: 'Buy' });
      }), /denied/);
      assert.equal(ledger.pending().length, 0);
    }
  } finally { if (previous === undefined) delete process.env.FARM_ACCOUNT_ID; else process.env.FARM_ACCOUNT_ID = previous; }
});

test('farm growth progress is confirmed and reread before claiming, ranch tasks never leak into farm claims', async () => {
  const proto = require('../src/utils/proto'); await proto.loadProto();
  const events = [], timers = new Map(), networkEvents = new EventEmitter();
  let reported = false;
  const growth = { id: 1, task_type: 1, cond_type: 15, is_unlocked: true, total_progress: 1 };
  const ranch = { id: 2, task_type: 4, is_unlocked: true, total_progress: 1, progress: 1 };
  const api = load('../src/services/task.js', {
    '../models/store': { isAutomationOn: () => true },
    '../utils/utils': { toNum: Number, toLong: Number, log() {}, logWarn() {}, sleep: async () => {} },
    '../utils/network': { networkEvents, isConnected: () => true, sendMsgAsync: async (_service, method, bytes) => {
      events.push(method);
      if (method === 'TaskInfo') return { body: proto.types.TaskInfoReply.encode({ task_info: { growth_tasks: [{ ...growth, progress: reported ? 1 : 0 }], tasks: [ranch] } }).finish() };
      if (method === 'ClientReportProgress') {
        const request = proto.types.ClientReportProgressRequest.decode(bytes);
        assert.equal(Number(request.task_id), 1); assert.equal(Number(request.progress), 1);
        reported = true;
        return { body: proto.types.ClientReportProgressReply.encode({ task_info: { growth_tasks: [{ ...growth, progress: 1 }] } }).finish() };
      }
      if (method === 'ClaimTaskReward') assert.equal(Number(proto.types.ClaimTaskRewardRequest.decode(bytes).id), 1);
      return { body: Buffer.alloc(0) };
    } },
    './scheduler': { createScheduler: () => ({ clearAll() { timers.clear(); }, setTimeoutTask: (key, _ms, fn) => timers.set(key, fn) }) },
    './stats': { recordOperation() {} }, './warehouse': { getBag: async () => ({}), getBagItems: () => [] },
  });
  api.initTaskSystem();
  networkEvents.emit('taskInfoNotify', { tasks: [ranch] }, { globalSceneId: 2 });
  assert.equal(timers.has('task_claim_debounce'), false);
  await api.checkAndClaimTasks();
  assert.deepEqual(events.slice(0, 4), ['TaskInfo', 'ClientReportProgress', 'TaskInfo', 'ClaimTaskReward']);
  assert.equal(events.filter(value => value === 'ClaimTaskReward').length, 1);
  api.cleanupTaskSystem();
});
