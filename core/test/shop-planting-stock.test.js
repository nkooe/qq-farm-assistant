const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-shop-stock-'));
process.env.FARM_DATA_DIR = dataDir;
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
const SEED = 20001;
const OTHER = 20002;
const LARGE_SEED = 20046; // Plant 表中的 2×2 爱心果种子。

function goods(seedId = SEED, overrides = {}) {
  return { id: seedId + 100000, item_id: seedId, unlocked: true, price: 10,
    item_count: 1, conds: [{ type: 1, param: seedId === SEED ? 2 : 1 }], ...overrides };
}

async function setup(t, options = {}) {
  const proto = require('../src/utils/proto');
  await proto.loadProto();
  const network = require('../src/utils/network');
  const utils = require('../src/utils/utils');
  const warehouse = require('../src/services/warehouse');
  const api = require('../src/services/farm-api');
  const store = require('../src/models/store');
  const analytics = require('../src/services/analytics');
  const state = { level: 200, gold: options.gold ?? 1000, accountId: 'test-stock' };
  const purchases = [];
  const planted = [];
  const events = [];
  const warnings = [];
  t.mock.method(network, 'getUserState', () => state);
  t.mock.method(network, 'sendMsgAsync', async (service, method, body) => {
    assert.equal(method, 'Plant', '不得访问真实服务');
    const request = proto.types.PlantRequest.decode(body);
    const seedId = Number(request.items[0].seed_id);
    const landId = Number(request.items[0].land_ids[0]);
    events.push('plant');
    const failure = typeof options.plantError === 'function'
      ? options.plantError({ seedId, landId }) : options.plantError;
    if (failure) throw failure;
    planted.push({ seedId, landId });
    return { body: proto.types.PlantReply.encode({ land: [{ id: landId, plant: { seed_id: seedId } }] }).finish() };
  });
  t.mock.method(utils, 'sleep', async () => {});
  t.mock.method(utils, 'log', () => {});
  t.mock.method(utils, 'logWarn', (tag, message, meta) => warnings.push({ tag, message, meta }));
  t.mock.method(warehouse, 'getBagSeeds', async () => {
    events.push('bag');
    if (options.bagError) throw options.bagError;
    return options.bag ?? [];
  });
  t.mock.method(api, 'getSeedShopId', async () => 2);
  t.mock.method(api, 'getShopInfo', async () => {
    if (options.shopError) throw options.shopError;
    return { goods_list: options.goods ?? [goods()] };
  });
  t.mock.method(api, 'buyGoods', async (id, count, price) => {
    events.push('buy');
    purchases.push({ id, count, price });
    if (options.buyError) throw options.buyError;
    if (options.balanceAfterBuy !== undefined) state.gold = typeof options.balanceAfterBuy === 'function'
      ? options.balanceAfterBuy(state.gold, count * price) : options.balanceAfterBuy;
    const item = (options.goods ?? [goods()]).find(g => g.id === id);
    return options.buyResult ?? { get_items: [{ id: item.item_id, count: count * (item.item_count || 1) }],
      cost_items: [{ id: 1001, count: count * price }] };
  });
  t.mock.method(store, 'getPlantingStrategy', () => 'level');
  t.mock.method(store, 'getPreferredSeed', () => options.preferred ?? SEED);
  t.mock.method(analytics, 'getPlantRankings', () => options.rankings ?? []);
  const target = require.resolve('../src/services/planting-service');
  delete require.cache[target];
  t.after(() => { delete require.cache[target]; });
  const planting = require(target);
  return { ...planting, state, purchases, planted, events, warnings };
}

test('库存足够、零金币：不购买，同种库存直接种植', async (t) => {
  const env = await setup(t, { gold: 0, bag: [{ seedId: SEED, count: 5 }] });
  const r = await env.plantFromShop([1, 2, 3], env.state, 'level');
  assert.equal(r.plantedCount, 3);
  assert.equal(env.purchases.length, 0);
  assert.deepEqual(r.plantedLands, [1, 2, 3]);
});

test('零库存且金币不足时返回明确原因，并在农场种植日志中显示所需金币', async t => {
  const env = await setup(t, { gold: 5 });
  const result = await env.plantFromShop([1, 2], env.state, 'level');
  assert.equal(result.blockedReason, 'insufficient_gold');
  assert.equal(env.purchases.length, 0);
  assert.ok(env.warnings.some(w => w.meta?.module === 'farm' && w.meta?.event === '种植种子'
    && w.meta?.result === 'insufficient_gold' && /金币不足/.test(w.message) && w.meta?.gold === 5 && w.meta?.minimumPrice === 10));
});

test('空商店与全部候选被锁定分别给出明确的农场种植原因', async t => {
  for (const [goodsList, reason] of [[[], 'empty_shop'], [[goods(SEED, { unlocked: false })], 'no_candidates']]) {
    await t.test(reason, async sub => {
      const env = await setup(sub, { goods: goodsList });
      const result = await env.plantFromShop([1], env.state, 'level');
      assert.equal(result.blockedReason, reason);
      assert.ok(env.warnings.some(w => w.meta?.module === 'farm' && w.meta?.event === '种植种子' && w.meta?.result === reason));
      assert.equal(env.purchases.length, 0);
    });
  }
});

test('相同阻塞原因一分钟内不刷屏，余额变化后立即更新原因', async t => {
  const env = await setup(t, { gold: 0 });
  await env.plantFromShop([1], env.state, 'level');
  await env.plantFromShop([1], env.state, 'level');
  assert.equal(env.warnings.filter(w => w.meta?.result === 'insufficient_gold').length, 1);
  env.state.gold = 1;
  await env.plantFromShop([1], env.state, 'level');
  assert.equal(env.warnings.filter(w => w.meta?.result === 'insufficient_gold').length, 2);
});

test('部分库存先种植，只为缺口购买；其他种子库存不冒充', async (t) => {
  const env = await setup(t, { bag: [{ seedId: SEED, count: 2 }, { seedId: OTHER, count: 99 }] });
  const r = await env.plantFromShop([1, 2, 3, 4, 5], env.state, 'level');
  assert.equal(r.plantedCount, 5);
  assert.equal(env.purchases[0].count, 3);
  assert.ok(env.events.indexOf('plant') < env.events.indexOf('buy'));
  assert.ok(env.planted.every(p => p.seedId === SEED));
  assert.equal(env.state.gold, 1000, '购买回包不估算并覆盖服务端共享余额');
});

test('金币只限制缺口，不阻止已有库存种植', async (t) => {
  const env = await setup(t, { gold: 10, bag: [{ seedId: SEED, count: 2 }] });
  const r = await env.plantFromShop([1, 2, 3, 4], env.state, 'level');
  assert.equal(r.plantedCount, 3);
  assert.equal(env.purchases[0].count, 1);
  assert.equal(env.state.gold, 10, '缺少推送时只约束本轮预算');
});

test('购买期间已收到服务端金币总额时不二次扣减，避免余额假归零阻断后续补种', async t => {
  const env = await setup(t, { gold: 1000, balanceAfterBuy: 970 });
  const result = await env.plantFromShop([1, 2, 3], env.state, 'level');
  assert.equal(result.plantedCount, 3);
  assert.equal(env.state.gold, 970);
});

test('购买推送后的余额仍可补种下一个候选，不因重复扣款误报金币不足', async t => {
  const env = await setup(t, { gold: 30, balanceAfterBuy: (balance, cost) => balance - cost, goods: [
    goods(SEED, { limit_count: 1 }), goods(OTHER),
  ] });
  const result = await env.plantFromShop([1, 2, 3], env.state, 'level');
  assert.equal(result.plantedCount, 3);
  assert.deepEqual(env.purchases.map(p => p.count), [1, 2]);
  assert.equal(env.state.gold, 0);
  assert.equal(result.blockedReason, undefined);
});

test('购买期间金币推送归零或增加时保留服务端余额', async t => {
  for (const balanceAfterBuy of [0, 1100]) {
    await t.test(String(balanceAfterBuy), async sub => {
      const env = await setup(sub, { gold: 1000, balanceAfterBuy });
      const result = await env.plantFromShop([1, 2, 3], env.state, 'level');
      assert.equal(result.plantedCount, 3);
      assert.equal(env.state.gold, balanceAfterBuy);
    });
  }
});

test('迟到的金币 delta 只记账一次，且无通知时仍按本轮预算限制连续购买', async t => {
  const env = await setup(t, { gold: 30, goods: [
    goods(SEED, { limit_count: 1 }), goods(OTHER),
  ] });
  const result = await env.plantFromShop([1, 2, 3, 4], env.state, 'level');
  assert.equal(result.plantedCount, 3);
  assert.deepEqual(env.purchases.map(p => p.count), [1, 2]);
  assert.equal(result.blockedReason, 'insufficient_gold');
  assert.equal(env.state.gold, 30);
  env.state.gold += -10; // 第一笔购买的迟到 delta。
  env.state.gold += -20; // 第二笔购买的迟到 delta。
  assert.equal(env.state.gold, 0);
});

test('读取背包失败或返回非列表：不误购', async (t) => {
  for (const options of [{ bagError: new Error('timeout') }, { bag: {} }]) {
    await t.test(JSON.stringify(options), async (sub) => {
      const env = await setup(sub, options);
      const r = await env.plantFromShop([1, 2], env.state, 'level');
      assert.equal(r.plantedCount, 0);
      assert.equal(env.purchases.length, 0);
    });
  }
});

test('购买失败保留库存已经种植的结果', async (t) => {
  const env = await setup(t, { bag: [{ seedId: SEED, count: 1 }], buyError: new Error('timeout') });
  const r = await env.plantFromShop([1, 2, 3], env.state, 'level');
  assert.equal(r.plantedCount, 1);
  assert.deepEqual(r.plantedLands, [1]);
  assert.equal(r.uncertain, true);
});

test('限额按剩余购买份数，每份多个种子，剩余空地换候选补种', async (t) => {
  const env = await setup(t, { bag: [{ seedId: SEED, count: 1 }], goods: [
    goods(SEED, { item_count: 2, limit_count: 5, bought_num: 4 }), goods(OTHER),
  ] });
  const r = await env.plantFromShop([1, 2, 3, 4, 5], env.state, 'level');
  assert.equal(r.plantedCount, 5);
  assert.deepEqual(env.purchases.map(p => p.count), [1, 2]);
  assert.deepEqual(env.planted.map(p => p.seedId), [SEED, SEED, SEED, OTHER, OTHER]);
  assert.equal(env.state.gold, 1000);
});

test('购买份数向上取整，发货超额仅种空地数量', async (t) => {
  const env = await setup(t, { goods: [goods(SEED, { item_count: 3 })] });
  const r = await env.plantFromShop([1, 2, 3, 4], env.state, 'level');
  assert.equal(env.purchases[0].count, 2);
  assert.equal(r.plantedCount, 4);
});

test('已购满限额仍使用同种库存，其余空地回退下一候选', async (t) => {
  const env = await setup(t, { bag: [{ seedId: SEED, count: 1 }], goods: [
    goods(SEED, { limit_count: 2, bought_num: 2 }), goods(OTHER),
  ] });
  const r = await env.plantFromShop([1, 2], env.state, 'preferred');
  assert.equal(r.plantedCount, 2);
  assert.deepEqual(env.planted.map(p => p.seedId), [SEED, OTHER]);
  assert.equal(env.purchases.length, 1);
  assert.equal(env.purchases[0].id, goods(OTHER).id);
});

test('最高候选买不起时尝试价格可负担的下一候选', async (t) => {
  const env = await setup(t, { gold: 5, goods: [goods(), goods(OTHER, { price: 1 })] });
  const r = await env.plantFromShop([1, 2], env.state, 'level');
  assert.equal(r.plantedCount, 2);
  assert.ok(env.planted.every(p => p.seedId === OTHER));
  assert.equal(env.state.gold, 5);
});

test('排行榜候选顺序与 preferred 一致性，findBestSeed 保持单对象接口', async (t) => {
  const env = await setup(t, { goods: [goods(), goods(OTHER)], rankings: [{ seedId: OTHER, level: 1 }, { seedId: SEED, level: 2 }] });
  assert.equal((await env.findBestSeed('max_exp')).seedId, OTHER);
  assert.equal((await env.findBestSeed('preferred')).seedId, SEED);
});

test('实际发货 ID 和数量限制种植，奖励物品不当作种子或金币扣除', async (t) => {
  const env = await setup(t, { buyResult: { get_items: [{ id: 1002, count: 3 }, { id: OTHER, count: 1 }],
    cost_items: [{ id: 1001, count: 20 }, { id: 1002, count: 50 }] } });
  const r = await env.plantFromShop([1, 2, 3], env.state, 'level');
  assert.equal(r.plantedCount, 1);
  assert.equal(env.planted[0].seedId, OTHER);
  assert.equal(env.state.gold, 1000);
});

test('Plant 表缺失时，实际发货仍可通过 ItemInfo 种子类型识别', async t => {
  const config = require('../src/config/gameConfig');
  const getPlant = config.getPlantBySeedId;
  t.mock.method(config, 'getPlantBySeedId', id => id === SEED ? null : getPlant(id));
  const env = await setup(t);
  const r = await env.plantFromShop([1, 2], env.state, 'level');
  assert.equal(r.plantedCount, 2);
  assert.equal(env.purchases.length, 1);
});

test('无实际发货或发货为 2x2：不盲种，不重复购买', async (t) => {
  for (const getItems of [[], [{ id: 1002, count: 1 }], [{ id: LARGE_SEED, count: 1 }]]) {
    await t.test(JSON.stringify(getItems), async (sub) => {
      const env = await setup(sub, { goods: [goods(), goods(OTHER)], buyResult: { get_items: getItems, cost_items: [] } });
      const r = await env.plantFromShop([1, 2], env.state, 'level');
      assert.equal(r.plantedCount, 0);
      assert.equal(env.purchases.length, 1);
    });
  }
});

test('业务拒绝、超时、断线和未知错误都停止消费', async (t) => {
  for (const error of [Object.assign(new Error('限购不足'), { code: 1001 }), new Error('timeout'), new Error('连接未打开'), new Error('decode error')]) {
    await t.test(error.message, async (sub) => {
      const env = await setup(sub, { goods: [goods(), goods(OTHER)], buyError: error });
      const r = await env.plantFromShop([1, 2], env.state, 'level');
      assert.equal(env.purchases.length, 1);
      if (!error.code) assert.equal(r.uncertain, true);
    });
  }
});

test('库存种植失败不购买，超时只尝试一次且不换候选', async (t) => {
  for (const error of [Object.assign(new Error('格子已锁定'), { code: 1003005 }), new Error('timeout')]) {
    await t.test(error.message, async (sub) => {
      const env = await setup(sub, { bag: [{ seedId: SEED, count: 5 }], goods: [goods(), goods(OTHER)], plantError: error });
      const r = await env.plantFromShop([1, 2, 3, 4, 5], env.state, 'level');
      assert.equal(r.plantedCount, 0);
      assert.equal(env.purchases.length, 0);
      if (!error.code) {
        assert.equal(r.uncertain, true);
        assert.equal(env.events.filter(e => e === 'plant').length, 1);
      }
    });
  }
});

test('商店读取失败时停止，不改用本地候选或购买', async (t) => {
  const env = await setup(t, { shopError: new Error('timeout'), bag: [{ seedId: SEED, count: 1 }, { seedId: OTHER, count: 1 }] });
  const r = await env.plantFromShop([1, 2, 3], env.state, 'preferred');
  assert.equal(r.plantedCount, 0);
  assert.equal(env.purchases.length, 0);
  assert.equal(env.events.includes('plant'), false);
});

test('库存部分成功后失败保留成果，禁止继续购买和切换候选', async (t) => {
  const env = await setup(t, { bag: [{ seedId: SEED, count: 2 }], goods: [goods(), goods(OTHER)],
    plantError: ({ landId }) => landId > 1 ? Object.assign(new Error('格子已锁定'), { code: 1003005 }) : null });
  const r = await env.plantFromShop([1, 2, 3], env.state, 'level');
  assert.equal(r.plantedCount, 1);
  assert.deepEqual(r.plantedLands, [1]);
  assert.equal(env.purchases.length, 0);
});

test('购买后种植超时停止本轮，禁止购买下一候选', async (t) => {
  const env = await setup(t, { goods: [goods(), goods(OTHER)], plantError: new Error('Plant timeout') });
  const r = await env.plantFromShop([1, 2, 3], env.state, 'level');
  assert.equal(r.uncertain, true);
  assert.equal(env.purchases.length, 1);
  assert.equal(env.events.filter(e => e === 'plant').length, 1);
});

test('普通策略不购买锁定、超等级或 2x2 候选', async (t) => {
  const env = await setup(t, { goods: [goods(LARGE_SEED), goods(SEED, { unlocked: false }),
    goods(20003, { conds: [{ type: 1, param: 201 }] }), goods(OTHER)] });
  const r = await env.plantFromShop([1, 2], env.state, 'level');
  assert.equal(r.plantedCount, 2);
  assert.equal(env.purchases.length, 1);
  assert.equal(env.purchases[0].id, goods(OTHER).id);
});

test('种植超时不会转向其他背包种子或非优先品质地块购种', async (t) => {
  const env = await setup(t, { bag: [{ seedId: SEED, count: 2, plantSize: 1 }, { seedId: OTHER, count: 3, plantSize: 1 }],
    plantError: new Error('Plant timeout') });
  const store = require('../src/models/store');
  // planting-service 对 store 的函数是解构引用，需要重新加载以应用本条策略。
  t.mock.method(store, 'getPlantingStrategy', () => 'bag_priority');
  t.mock.method(store, 'getBagSeedPriority', () => [SEED]);
  t.mock.method(store, 'getBagPriorityLandTypes', () => ['normal']);
  t.mock.method(store, 'getPrioritize2x2Crops', () => false);
  const target = require.resolve('../src/services/planting-service');
  delete require.cache[target];
  const planting = require(target);
  const r = await planting.autoPlantEmptyLands([], [1, 2], [
    { id: 1, level: 1, unlocked: true }, { id: 2, level: 2, unlocked: true },
  ]);
  assert.equal(r.uncertain, true);
  assert.equal(env.purchases.length, 0);
  assert.equal(env.events.filter(e => e === 'plant').length, 1);
});
