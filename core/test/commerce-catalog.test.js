const { compileFunction } = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function harness() {
  const file = path.resolve(__dirname, '../src/modern/services/commerce.js');
  const realRequire = createRequire(file); const module = { exports: {} };
  const goods = { id: 41, item_id: 20040, item_count: 3, price: 25, unlocked: true, limit_count: 5, bought_num: 0 };
  const product = { goods_id: 71, name: '测试礼包', price: { id: 1002, count: 2 }, is_available: true,
    reward_items: [{ id: 20040, count: 2 }], purchase_limit: { limit_type: 2, limit_count: 4, bought_count: 1 } };
  const bag = [{ id: 1005, count: 1000 }, { id: 1002, count: 100 }]; const writes = []; const reads = [];
  let corrupt = false; let failed = false;
  const mocks = {
    '../config/gameConfig': { getItemById: id => ({ name: `物品${id}` }), getItemImageById: () => '' },
    '../utils/utils': { getServerTimeSec: () => 1000, toNum: value => Number(value) || 0 },
    './warehouse': { getBag: async () => { if (failed) throw new Error('offline'); return { items: bag }; },
      getBagItems: reply => reply.items, isItemLocked: item => !!item.locked },
    './farm': {
      getShopInfo: async id => { reads.push(id); return { goods_list: [structuredClone(goods)] }; },
      buyGoods: async (id, count, price) => {
        writes.push({ id, count, price }); goods.bought_num += count;
        return { get_items: [{ id: goods.item_id, count: goods.item_count * count + (corrupt ? 1 : 0) }],
          cost_items: price === 0 ? [] : [{ id: 1005, count: price * count }] };
      },
    },
    '../../services/mall': {
      getMallListBySlotType: async () => ({ goods_list: [structuredClone(product)] }),
      purchaseMallGoods: async (id, count) => { writes.push({ id, count }); product.purchase_limit.bought_count += count;
        return { goods_id: id, reward_items: product.reward_items, purchase_limit: product.purchase_limit }; },
    },
  };
  compileFunction(fs.readFileSync(file, 'utf8'), ['require', 'module', 'exports'])(name => mocks[name] || realRequire(name), module, module.exports);
  return { api: module.exports, goods, product, bag, writes, reads, corrupt: () => { corrupt = true; }, failed: () => { failed = true; } };
}
const offer = goods => ({ price: { id: goods.price.id, count: goods.price.count }, rewards: goods.rewards });

test('props promotions honor official free windows and daily limits without inventing prices', async () => {
  const h = harness();
  Object.assign(h.goods, { discount_start_time: 900, discount_end_time: 1100, discount_price: 0 });
  const goods = (await h.api.getPropsShop()).goods[0];
  assert.equal(goods.isFree, true);
  assert.equal(goods.originalPrice, 25);
  assert.equal(goods.limit.remaining, 5);
  await h.api.purchaseProps(41, 2, offer(goods));
  assert.deepEqual(h.writes, [{ id: 41, count: 2, price: 0 }]);
  assert.ok(h.reads.every(id => id === 4));
});

test('expired or changed props offers and excess quantities never submit a purchase', async () => {
  const h = harness(); const goods = (await h.api.getPropsShop()).goods[0];
  h.goods.price++;
  await assert.rejects(h.api.purchaseProps(41, 1, offer(goods)), /已变化/);
  h.goods.price--;
  await assert.rejects(h.api.purchaseProps(41, 6, offer(goods)), /限购/);
  h.goods.end_time = 999;
  await assert.rejects(h.api.purchaseProps(41, 1, offer(goods)), /下架/);
  assert.equal(h.writes.length, 0);
});

test('locked and unknown currency balances cannot finance a purchase', async () => {
  const h = harness(); const goods = (await h.api.getPropsShop()).goods[0];
  h.bag[0].locked = true;
  await assert.rejects(h.api.purchaseProps(41, 1, offer(goods)), /不足/);
  h.failed();
  await assert.rejects(h.api.purchaseProps(41, 1, offer(goods)));
  assert.equal(h.writes.length, 0);
});

test('an unconfirmed props response is not retried', async () => {
  const h = harness(); const goods = (await h.api.getPropsShop()).goods[0];
  h.corrupt();
  await assert.rejects(h.api.purchaseProps(41, 1, offer(goods)), /回包/);
  assert.equal(h.writes.length, 1);
});

test('catalog preserves official weekly cap and rejects stale gift contents', async () => {
  const h = harness(); const goods = (await h.api.getMallCatalog(1)).goods[0];
  assert.equal(goods.limit.type, 2);
  assert.equal(goods.limit.max, 4);
  assert.equal(goods.limit.remaining, 3);
  const expected = { ...offer(goods).price, rewards: goods.rewards };
  h.product.reward_items[0].count++;
  await assert.rejects(h.api.purchaseMallProduct(71, 1, 1, expected), /内容已变化/);
  assert.equal(h.writes.length, 0);
});

test('serialized purchases re-read remaining stock and reject the second over-limit request', async () => {
  const h = harness(); const goods = (await h.api.getPropsShop()).goods[0];
  const results = await Promise.allSettled([h.api.purchaseProps(41, 3, offer(goods)), h.api.purchaseProps(41, 3, offer(goods))]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  assert.equal(h.writes.length, 1);
});

test('invalid mall pages are rejected rather than silently opening another page', async () => {
  const h = harness();
  for (const slot of [0, 2, 6, 1.5, 'wrong', null])
    await assert.rejects(h.api.getMallCatalog(slot), /分页/);
  assert.equal(h.writes.length, 0);
});
