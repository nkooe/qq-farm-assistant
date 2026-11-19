const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
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
function growing(id, remaining = 1, level = 1, seconds = 120, master = 0) {
  const now = getServerTimeSec();
  return { id, unlocked: true, level, master_land_id: master, plant: { left_inorc_fert_times: remaining, phases: [
    { phase: PlantPhase.GERMINATION, begin_time: now - 100 }, { phase: PlantPhase.MATURE, begin_time: now + seconds },
  ] } };
}
test('new ripening modes round-trip through real per-account settings without changing existing strategies', () => {
  const store = require('../src/models/store');
  const before = store.getConfigSnapshot('ripening-B');
  for (const fertilizer of ['normal_ripen', 'organic_ripen', 'smart_normal', 'final_normal', 'smart']) {
    store.applyConfigSnapshot({ automation: { fertilizer } }, { accountId: 'ripening-A', persist: false });
    assert.equal(store.getConfigSnapshot('ripening-A').automation.fertilizer, fertilizer);
  }
  assert.deepEqual(store.getConfigSnapshot('ripening-B'), before);
});
test('ripening reuses a snapshot, filters land types and slave plots, and counts only confirmed target IDs', async () => {
  const writes = [];
  const service = load('../src/services/farm-ripening.js', {
    './farm-api': {
      getAllLands: () => assert.fail('supplied snapshot should be reused'),
      fertilizeBatch: async (ids, fertilizer) => { writes.push([fertilizer, ...ids]); return { land: [{ id: ids[0] }, { id: 99 }] }; },
    },
    './farm-fertilizer': { ...require('../src/services/farm-fertilizer'), fertilizeOrganicLoop: async ids => { writes.push(['loop', ...ids]); return ids.length; } },
    './stats': { recordOperation() {} },
    '../utils/utils': { toNum: Number, log() {} },
  });
  const lands = [growing(1), growing(2, 0), growing(3, 1, 1, 600), growing(4, 1, 4), growing(5, 1, 1, 120, 1)];
  const config = { fertilizer_land_types: ['normal'], fertilizer_smart_seconds: 300 };
  assert.equal(await service.runRipeningFertilizer({ ...config, fertilizer: 'normal_ripen' }, lands), 1);
  assert.equal(await service.runRipeningFertilizer({ ...config, fertilizer: 'organic_ripen' }, lands), 1);
  assert.equal(await service.runRipeningFertilizer({ ...config, fertilizer: 'smart' }, lands), 2);
  assert.equal(await service.runRipeningFertilizer({ ...config, fertilizer: 'organic_ripen', fertilizer_land_types: [] }, lands), 0);
  assert.deepEqual(writes, [[1011, 1], [1012, 1, 2], ['loop', 1, 2]]);
});
test('ripening-only modes spend nothing during planting or multi-season top-up', async () => {
  for (const fertilizer of ['normal_ripen', 'organic_ripen']) {
    const service = load('../src/services/farm-fertilizer.js', {
      '../models/store': { getAutomation: () => ({ fertilizer }) },
      './farm-api': { getAllLands: () => assert.fail('no sowing read'), fertilize: () => assert.fail('no sowing write') },
    });
    for (const reason of ['normal', 'multi_season']) {
      const result = await service.runFertilizerByConfig([1], { reason });
      assert.equal(result.normal + result.organic, 0);
    }
  }
});
test('ripening stops after an interrupted land read and rechecks queued writes before sending', async () => {
  let allowed = true;
  let queueWrite = false;
  const service = load('../src/services/farm-ripening.js', {
    './farm-api': {
      getAllLands: async () => { allowed = false; return { lands: [growing(1)] }; },
      fertilizeBatch: async (_ids, _fertilizer, hooks) => {
        queueWrite = true;
        allowed = false;
        const blocked = hooks.beforeSend();
        assert.equal(blocked.code, 'FARM_STOPPED');
        throw blocked;
      },
    },
  });
  const config = { fertilizer: 'organic_ripen', fertilizer_land_types: ['normal'] };
  assert.equal(await service.runRipeningFertilizer(config, undefined, true, () => allowed), 0);
  assert.equal(queueWrite, false);
  allowed = true;
  assert.equal(await service.runRipeningFertilizer(config, [growing(1)], true, () => allowed), 0);
  assert.equal(queueWrite, true);
});
test('organic fertilizing has per-land and global bounds, paced requests, and a queued stop guard', async () => {
  let sends = 0;
  let delays = 0;
  let allowed = true;
  let stopBeforeSend = false;
  const service = load('../src/services/farm-fertilizer.js', {
    '../utils/network': { sendMsgAsync: async (_service, _method, _payload, hooks) => {
      if (stopBeforeSend) allowed = false;
      const blocked = hooks.beforeSend();
      if (blocked) throw blocked;
      sends++;
    } },
    '../utils/proto': { types: { FertilizeRequest: { create: input => input, encode: () => ({ finish: () => Buffer.alloc(0) }) } } },
    '../utils/utils': { ...require('../src/utils/utils'), logWarn() {}, randomDelay: async (min, max) => {
      assert.equal(min, 1000); assert.equal(max, 1500); delays++;
    } },
  });
  assert.equal(await service.fertilizeOrganicLoop([1, 1], true, () => allowed), 20);
  assert.equal(delays, 19);
  assert.equal(await service.fertilizeOrganicLoop(Array.from({ length: 13 }, (_, i) => i + 1)), 240);
  assert.equal(sends, 260);
  stopBeforeSend = true;
  assert.equal(await service.fertilizeOrganicLoop([1], true, () => allowed), 0);
  assert.equal(sends, 260);
});
test('spent normal fertilizer allowance does not exclude final-stage organic fertilizer', async () => {
  let fertilizer = 'final_organic';
  let writes = 0;
  const service = load('../src/services/farm-fertilizer.js', {
    '../models/store': { getAutomation: () => ({ fertilizer, fertilizer_land_types: ['normal'] }) },
    './farm-api': { getAllLands: async () => ({ lands: [growing(1, 0)] }), NORMAL_FERTILIZER_ID: 1011, ORGANIC_FERTILIZER_ID: 1012,
      fertilize: async ids => { assert.equal(ids.length, 0); return 0; } },
    '../utils/network': { sendMsgAsync: async () => { writes++; throw new Error('insufficient organic stock'); } },
    '../utils/proto': { types: { FertilizeRequest: { create: input => input, encode: () => ({ finish: () => Buffer.alloc(0) }) } } },
    '../utils/utils': { ...require('../src/utils/utils'), log() {}, logWarn() {} },
  });
  await service.runFertilizerByConfig();
  assert.equal(writes, 1);
  fertilizer = 'final_normal';
  await service.runFertilizerByConfig();
  assert.equal(writes, 1);
});
test('clear illustrated new badges validates int32 IDs, deduplicates and decodes confirmed replies', async () => {
  const proto = require('../src/modern/utils/proto');
  await proto.loadProto();
  const writes = [];
  const service = load('../src/modern/services/illustrated.js', {
    '../utils/network': { sendMsgAsync: async (_service, method, body) => {
      assert.equal(method, 'ClearNewUnlockedFruitsV2');
      writes.push([...proto.types.ClearNewUnlockedFruitsV2Request.decode(body).fruit_ids]);
      return { body: proto.types.ClearNewUnlockedFruitsV2Reply.encode({ cleared_fruit_ids: [123] }).finish() };
    } },
  });
  for (const input of [null, ['123'], [0], [-1], [1.5], [2147483648], Array.from({ length: 1001 }, () => 1)]) {
    await assert.rejects(service.clearIllustratedNew(input), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal((await service.clearIllustratedNew([])).cleared.length, 0);
  assert.deepEqual(Array.from((await service.clearIllustratedNew([123, 123, 2147483647])).cleared), [123]);
  assert.deepEqual(writes, [[123, 2147483647]]);
});
test('automatic patrol checks harvest once only after confirmed ripening, reusing the initial read', async () => {
  for (const successful of [false, true]) {
    const calls = []; const land = growing(1);
    const empty = { harvestable: [], harvestableInfo: [], needWeed: [], needBug: [], needGoldenBug: [], needWater: [],
      dead: [], empty: [], unlockable: [], upgradable: [], growing: [] };
    const service = load('../src/services/farming-orchestrator.js', {
      '../models/store': { getAutomation: () => ({ fertilizer: 'organic_ripen' }), isAutomationOn: key => key === 'farm', getPrioritize2x2Crops: () => false },
      '../utils/network': { getUserState: () => ({ gid: 1 }), isConnected: () => true, networkEvents: { emit() {} } },
      '../utils/utils': { toNum: Number, log() {}, logWarn() {} },
      './stats': { recordOperation() {} },
      './farm-api': {
        getAllLands: async () => { calls.push('read'); return { lands: [land] }; },
        harvest: async ids => { calls.push(`harvest:${ids}`); return {}; },
      },
      './farm-land-analyzer': { analyzeLands: () => calls.includes('ripen') ? { ...empty, harvestable: [1] } : empty },
      './farm-ripening': { isRipeningOnlyMode: () => true, runRipeningFertilizer: async (_config, lands) => {
        assert.equal(lands[0], land); calls.push('ripen'); return Number(successful);
      } },
    });
    const result = await service.runFarmOperation('all');
    assert.equal(result.hadWork, successful);
    assert.deepEqual(calls, successful ? ['read', 'ripen', 'read', 'harvest:1'] : ['read', 'ripen']);
  }
});
test('ranch roster queries scene 2, preserves nickname and keeps farm-only NPCs and unqualified friends out', async () => {
  const socket = {}; const batches = []; const all = [];
  const make = (gid, name, qualified) => ({ gid, name, remark: '旧备注', avatar_url: '', ...(qualified ? { big_farm_status: {} } : {}) });
  const rows = [make(10001, '小果', true), make(2, '自己', true), make(3, '牧场昵称', true), make(4, '无牧场', false), make(5, '小果', true)];
  const state = { gid: 2, globalSceneId: 2 };
  const service = load('../src/modern/services/ranch/friend-roster.js', {
    '../../config/config': { CONFIG: { platform: 'qq' } },
    '../../models/store': { getKnownFriendGids: () => [10001, 2, 3, 4, 5] },
    '../../utils/network': { getWs: () => socket, getUserState: () => state },
    '../friend/gid-manager': { QQ_FRIEND_LIST_BATCH_SIZE: 35, fetchFriendsByGids: async (gids, scene) => { batches.push([scene, ...gids]); return rows; },
      fetchAllFriendsForScene: async scene => { all.push(scene); return { game_friends: rows }; }, extractReplyFriends: reply => reply.game_friends },
  });
  const friends = await service.getRanchFriendList();
  assert.deepEqual(Array.from(friends, friend => friend.gid).sort(), [3, 5]);
  assert.equal(friends.find(friend => friend.gid === 3).name, '牧场昵称');
  assert.deepEqual(batches, [[2, 10001, 3, 4, 5]]);
  await service.getRanchFriendList(); assert.equal(batches.length, 1);
  state.globalSceneId = 1;
  await assert.rejects(service.getRanchFriendList(), { code: 'RANCH_SCENE_REQUIRED' });
  assert.equal(all.length, 0);
});
test('ranch roster resumes after yielding but discards the session after reconnect', async () => {
  let socket = {}; let reads = 0; let yielded = false;
  const service = load('../src/modern/services/ranch/friend-roster.js', {
    '../../config/config': { CONFIG: { platform: 'qq' } },
    '../../models/store': { getKnownFriendGids: () => [3, 4] },
    '../../utils/network': { getWs: () => socket, getUserState: () => ({ gid: 2, globalSceneId: 2 }) },
    '../../utils/utils': { toNum: Number, randomDelay: async () => {} },
    '../friend/gid-manager': { QQ_FRIEND_LIST_BATCH_SIZE: 1, fetchFriendsByGids: async gids => {
      reads++; return [{ gid: gids[0], name: '好友', big_farm_status: {} }];
    } },
  });
  await assert.rejects(service.getRanchFriendList(completed => { if (completed && !yielded) { yielded = true; throw new Error('yield'); } }), /yield/);
  assert.equal((await service.getRanchFriendList()).length, 2); assert.equal(reads, 2);
  socket = {};
  await service.getRanchFriendList(); assert.equal(reads, 4);
});
test('cub priority settings validate housing and returned arrays cannot mutate any account', () => {
  const store = require('../src/models/store');
  const { cubMap } = require('../src/modern/config/ranch-animals');
  const { normalizeRanchSetting } = require('../src/modern/config/ranch-automation');
  const coop = [...cubMap].find(([, animal]) => animal.husbandry_type === '窝')[0];
  const shed = [...cubMap].find(([, animal]) => animal.husbandry_type === '棚')[0];
  assert.throws(() => normalizeRanchSetting('ranch_coop_cub_priority', [shed]), { code: 'INVALID_CONFIG' });
  assert.throws(() => normalizeRanchSetting('ranch_coop_cub_priority', [String(coop)]), { code: 'INVALID_CONFIG' });
  store.applyConfigSnapshot({ automation: { ranch_coop_cub_priority: [coop, coop] } }, { accountId: 'cub-A', persist: false });
  const snapshot = store.getConfigSnapshot('cub-A');
  assert.deepEqual(snapshot.automation.ranch_coop_cub_priority, [coop]);
  snapshot.automation.ranch_coop_cub_priority.push(999);
  assert.deepEqual(store.getConfigSnapshot('cub-A').automation.ranch_coop_cub_priority, [coop]);
  assert.deepEqual(store.getConfigSnapshot('cub-B').automation.ranch_coop_cub_priority, []);
});
test('market notifications reject closed rounds and wake a newly arrived or restocked market promptly', () => {
  const now = getServerTimeSec();
  const service = load('../src/modern/services/ranch/automation.js', {
    '../../models/store': { getAutomation: () => ({ ranch_market_organic_poop: true, ranch_check_minutes: 5 }) },
    './transport': { isUnlocked: () => true },
  });
  const round = { period_day: 1, round_index: 1, shop_start_time: now - 100, shop_end_time: now + 1000, present: false };
  assert.equal(service.noteMarketVisit(round), false);
  round.present = true;
  assert.equal(service.noteMarketVisit(round), true);
  assert.equal(service.getRoutineState().doneToday, false);
  assert.ok(service.getRoutineState().nextCheckAt <= Date.now() + 20000);
  assert.equal(service.noteMarketVisit(round), false);
  assert.equal(service.noteMarketVisit({ ...round, round_index: 2 }), true);
});
test('ranch daily rewards keep a future wake time with all normal patrol work disabled', () => {
  const next = Date.now() + 600000;
  const service = load('../src/modern/services/ranch/automation.js', {
    '../../models/store': { getAutomation: () => ({ ranch_task: true, ranch_check_minutes: 5 }) },
    './transport': { isUnlocked: () => true },
    './daily': { getTaskRoutineState: () => ({ doneToday: false, nextCheckAt: next }) },
  });
  assert.equal(service.getRoutineState().doneToday, true);
  assert.equal(service.getRoutineState().nextCheckAt, next);
});
test('market currencies have independent settings and only enabled currencies are spent', async () => {
  const store = require('../src/models/store');
  const config = require('../src/modern/config/ranch-automation');
  const now = getServerTimeSec();
  store.applyConfigSnapshot({ automation: { ranch_market_organic_poop: false, ranch_market_organic_pinecone: true } }, { accountId: 'market-A', persist: false });
  assert.equal(store.getConfigSnapshot('market-A').automation.ranch_market_organic_poop, false);
  assert.equal(store.getConfigSnapshot('market-A').automation.ranch_market_organic_pinecone, true);
  assert.equal(store.getConfigSnapshot('market-B').automation.ranch_market_organic_poop, true);
  for (const [poop, pinecone] of [[true, false], [false, true], [false, false]]) {
    const auto = { ranch_market_organic_poop: poop, ranch_market_organic_pinecone: pinecone, ranch_check_minutes: 5 };
    assert.equal(config.isRanchMarketEnabled(auto), poop || pinecone);
    const writes = [];
    const raw = { cells: { facilities: [] }, bag: { 7002: 3, 1008: 1 } };
    const goods = [
      { id: '11', available: true, remaining: 1, price: { id: 7002, count: '3' }, reward: { id: 80012, count: '1' } },
      { id: '12', available: true, remaining: 1, price: { id: 1008, count: '1' }, reward: { id: 80013, count: '1' } },
    ];
    const service = load('../src/modern/services/ranch/automation.js', {
      '../../models/store': { getAutomation: () => auto },
      '../../utils/utils': { getServerTimeSec: () => now, log: (_tag, _text, meta) => assert.notEqual(meta.result, 'error') },
      './transport': { isUnlocked: () => true, inScene: run => run(raw.cells) },
      './state': { loadRaw: async () => raw, snapshot: () => ({ facilities: [], serverTime: Date.now() }),
        balance: (bag, id) => ({ total: String(bag[id] || 0), locked: '0' }),
        readMarketRotation: async () => ({ period_day: '1', round_index: 1, present: true, shop_start_time: now - 1, shop_end_time: now + 3600 }),
        market: async () => ({ periodDay: '1', roundIndex: 1, present: true, opened: true, goods }) },
      './operation-state': { forCurrentAccount: () => ({ reserved: () => '0' }) },
      './actions': {
        prepareAction: async (action, input) => {
          assert.equal(action, 'exchange');
          const good = goods.find(good => good.id === input.goodsId);
          return { label: '兑换', costItems: [good.price], rewards: [good.reward], expected: {} };
        },
        operate: async (_action, input) => {
          const good = goods.find(good => good.id === input.goodsId);
          writes.push(good.price.id); raw.bag[good.price.id] = 0;
          return { status: 'confirmed' };
        },
      },
    });
    await service.run();
    assert.deepEqual(writes, poop ? [7002] : pinecone ? [1008] : []);
  }
});
test('shed activation uses the server instance and verifies the resulting facility identity and state', async () => {
  const { shedAwaitingActivation } = require('../src/modern/services/ranch/state');
  const proto = require('../src/modern/utils/proto');
  await proto.loadProto();
  assert.ok(proto.types.RanchActivateFacilityRequest && proto.types.RanchActivateFacilityReply);
  for (const mismatch of [null, { state: 3 }, { module_type: 6 }, { facility_id: 6002002 }, { instance_id: 99 }, { ranch: null }]) {
    const facility = { instance_id: 42, module_type: 7, facility_id: 6002001, state: 3 };
    const raw = { cells: { facilities: [facility] }, bag: {} };
    const writes = [];
    const service = load('../src/modern/services/ranch/actions.js', {
      './state': { loadRaw: async () => raw, snapshot: () => ({}), shedAwaitingActivation },
      './transport': { inScene: run => run(raw.cells), rpc: async (route, input, writing) => {
        writes.push(route); assert.equal(route, 'activateShed'); assert.equal(input.instance_id, '42'); assert.equal(writing, true);
        return { facility: { ...facility, state: 1, ranch: {}, ...mismatch } };
      } },
      './operation-state': { forCurrentAccount: () => ({ withLock: run => run(), spend: (_plan, run) => run() }) },
    });
    assert.equal((await service.planAction('activateShed', { facilityId: 99 }, raw)).count, 0);
    const plan = await service.planAction('activateShed', { facilityId: 42 }, raw);
    const result = service.operate('activateShed', { facilityId: 42, expected: { signature: plan.signature } });
    if (mismatch) await assert.rejects(result, { code: 'RANCH_RESULT_UNKNOWN' });
    else assert.equal((await result).status, 'confirmed');
    assert.deepEqual(writes, ['activateShed']);
    facility.state = 1;
    assert.equal(shedAwaitingActivation(raw), undefined);
  }
});
test('automatic ranch upgrades activate a newly available shed before continuing the patrol', async () => {
  const { shedAwaitingActivation } = require('../src/modern/services/ranch/state');
  const facility = { instance_id: 42, module_type: 7, facility_id: 6002001, state: 3 };
  const raw = { cells: { facilities: [facility] }, bag: {} };
  const actions = [];
  const service = load('../src/modern/services/ranch/automation.js', {
    '../../models/store': { getAutomation: () => ({ ranch_upgrade: true, ranch_check_minutes: 5 }) },
    '../../utils/utils': { getServerTimeSec, log: (_tag, _text, meta) => assert.notEqual(meta.result, 'error') },
    './transport': { isUnlocked: () => true, inScene: run => run(raw.cells) },
    './state': { shedAwaitingActivation, loadRaw: async () => raw, snapshot: () => ({ facilities: [], serverTime: Date.now() }) },
    './actions': { prepareAction: async (action, input) => {
      actions.push(action); assert.equal(input.facilityId, '42'); return { label: '解锁牧场棚', expected: {} };
    }, operate: async () => { facility.state = 1; return { status: 'confirmed' }; } },
  });
  await service.run();
  assert.deepEqual(actions, ['activateShed']);
  assert.equal(facility.state, 1);
});
