const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const protobuf = require('protobufjs');
const proto = require('../src/utils/proto');
const root = new protobuf.Root().loadSync(path.join(__dirname, '../src/modern/proto/mallpb.proto'), { keepCase: true });
const currentType = name => root.lookupType(`gamepb.mallpb.${name}`);
const tick = () => new Promise(resolve => setImmediate(resolve));
const { runWithRequestClass } = require('../src/utils/request-context');

async function harness(options = {}) {
  await proto.loadProto();
  const state = { coupon: options.coupon ?? 125 }; const calls = [];
  const filename = path.resolve(__dirname, '../src/services/mall.js');
  const localRequire = createRequire(filename); const module = { exports: {} };
  const goods = { goods_id: 1002, price: { id: 1002, count: 42 }, is_available: true,
    purchase_limit: { limit_type: 1, bought_count: 0, limit_count: 100 }, ...options.goods };
  const mocks = {
    '../utils/proto': proto,
    '../utils/utils': { toNum: value => Number(value) || 0, log() {}, sleep: async () => {} },
    '../utils/network': { getUserState: () => state, sendMsgAsync: async (_service, method, body) => {
      const req = currentType(method === 'Purchase' ? 'PurchaseRequest' : 'GetMallListBySlotTypeRequest').decode(body);
      calls.push({ method, req });
      if (method === 'GetMallListBySlotType') {
        await options.beforeList?.();
        return { body: currentType('GetMallListBySlotTypeResponse').encode({ goods_list: [goods] }).finish() };
      }
      if (options.purchaseError) throw options.purchaseError;
      if (options.balanceAfterPurchase !== undefined) state.coupon = options.balanceAfterPurchase;
      return { body: currentType('PurchaseResponse').encode({ goods_id: Number(req.goods_id),
        success: options.success ?? true }).finish() };
    } },
    './warehouse': { getBag: async () => { if (options.bagError) throw options.bagError; return {}; },
      getBagItems: () => [], getContainerHoursFromBagItems: () => ({ organic: 0, normal: 0 }) },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, Buffer,
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : localRequire(name) }, { filename });
  return { api: module.exports, state, calls, goods, purchases: () => calls.filter(call => call.method === 'Purchase') };
}

test('mall reads typed price, availability and period purchase limit from the current protocol', async () => {
  const h = await harness({ goods: { purchase_limit: { limit_type: 4, bought_count: 2, limit_count: 7 } } });
  const [goods] = await h.api.getMallGoodsList(1);
  assert.equal(h.api.parseMallPriceValue(goods.price), 42);
  assert.deepEqual(JSON.parse(JSON.stringify(h.api.parseMallLimitInfo(goods.purchase_limit))), { limitCount: 7, boughtNum: 2 });
  assert.equal(goods.is_available, true);
  assert.equal(Number(goods.price.id), 1002);
});

test('fertilizer budget uses coupon and affordable quantities each round', async () => {
  const h = await harness();
  assert.equal(await h.api.autoBuyFertilizer(true, 'organic', 10), 2);
  assert.deepEqual(h.purchases().map(call => Number(call.req.count)), [2]);
  assert.equal(h.state.coupon, 125, 'never estimate-write into the shared balance');
});

test('zero coupon sends no purchase even when a stale ticket field exists', async () => {
  const h = await harness({ coupon: 0 }); h.state.ticket = 99999;
  assert.equal(await h.api.autoBuyFertilizer(true, 'organic', 1), 0);
  assert.equal(h.purchases().length, 0);
});

test('a reduced balance notification constrains the next round and remains authoritative', async () => {
  const h = await harness({ coupon: 1000, balanceAfterPurchase: 0 });
  assert.equal(await h.api.autoBuyFertilizer(true, 'organic', 20), 10);
  assert.deepEqual(h.purchases().map(call => Number(call.req.count)), [10]);
  assert.equal(h.state.coupon, 0);
});

test('fertilizer respects remaining purchase limit and unavailable products', async () => {
  const h = await harness({ coupon: 10000, goods: { purchase_limit: { limit_type: 4, bought_count: 6, limit_count: 7 } } });
  assert.equal(await h.api.autoBuyFertilizer(true, 'organic', 10), 1);
  assert.deepEqual(h.purchases().map(call => Number(call.req.count)), [1]);
  const unavailable = await harness({ goods: { is_available: false } });
  assert.equal(await unavailable.api.autoBuyFertilizer(true, 'organic', 1), 0);
  assert.equal(unavailable.purchases().length, 0);
});

test('invalid fertilizer type and quantity fail before any request', async () => {
  for (const [type, count] of [['other', 1], ['organic', -1], ['normal', 0.5], ['organic', '1'], ['normal', Infinity]]) {
    const h = await harness();
    await assert.rejects(h.api.autoBuyFertilizer(true, type, count));
    assert.equal(h.calls.length, 0);
  }
});

test('purchase rejects non-positive fractional string and unsafe arguments before protobuf encoding', async () => {
  const h = await harness();
  for (const value of [0, -1, 0.5, '1', null, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(h.api.purchaseMallGoods(1002, value));
    await assert.rejects(h.api.purchaseMallGoods(value, 1));
  }
  assert.equal(h.calls.length, 0);
});

test('business rejection and transport errors propagate without automatic repurchase', async () => {
  for (const options of [{ success: false }, { purchaseError: new Error('fixture connection lost') }]) {
    const h = await harness(options);
    await assert.rejects(h.api.autoBuyFertilizer(true, 'organic', 1));
    assert.equal(h.purchases().length, 1);
  }
});

test('manual mall purchase waits for the current fertilizer purchase chain', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = await harness({ beforeList: () => gate });
  const automatic = h.api.autoBuyFertilizer(true, 'organic', 1);
  const manual = h.api.purchaseMallGoods(1003, 1);
  await tick(); const beforeRelease = h.purchases().length; release();
  await Promise.all([automatic, manual]);
  assert.equal(beforeRelease, 0);
  assert.deepEqual(h.purchases().map(call => Number(call.req.goods_id)), [1002, 1003]);
});

test('unknown price or currency fails explicitly without spending another currency', async () => {
  for (const price of [{ id: 9999, count: 42 }, { id: 1002, count: 0 }]) {
    const h = await harness({ goods: { price } });
    await assert.rejects(h.api.autoBuyFertilizer(true, 'organic', 1));
    assert.equal(h.purchases().length, 0);
  }
});

test('cancelling a fertilizer lookup prevents its late purchase and releases the queue', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = await harness({ beforeList: () => gate }), controller = new AbortController();
  const pending = runWithRequestClass('farm', () => h.api.autoBuyFertilizer(true, 'organic', 1), { signal: controller.signal });
  const checked = assert.rejects(pending, /abort/i);
  await tick(); controller.abort(); release(); await checked;
  assert.equal(h.purchases().length, 0);
  await h.api.purchaseMallGoods(1003, 1);
  assert.equal(h.purchases().length, 1);
});

test('check-and-buy propagates warehouse failures instead of reporting a successful zero purchase', async () => {
  const h = await harness({ bagError: new Error('fixture bag unavailable') });
  await assert.rejects(h.api.checkAndBuyFertilizerBoth({ buyOrganic: true, organicCount: 1, organicThresholdHours: 10 }), /bag unavailable/);
});

test('a failed free gift is not marked completed for the day', async () => {
  const h = await harness({ success: false, goods: { goods_id: 1001, is_free: true, price: { id: 1002, count: 0 } } });
  await assert.rejects(h.api.buyFreeGifts(true), /未确认/);
  assert.equal(h.api.getFreeGiftDailyState().doneToday, false);
});

function routeHarness(goods, coupon = 50) {
  const { registerAdminMallRoutes } = require('../src/controllers/admin-mall-routes');
  const routes = new Map(), calls = [];
  registerAdminMallRoutes({ app: { get: (url, handler) => routes.set(url, handler), post: (url, handler) => routes.set(url, handler) },
    provider: { getStatus: () => ({ connection: { connected: true }, status: { coupon } }),
      getMallGoods: async () => [goods], buyMallGoods: async (...args) => calls.push(args) },
    getAccountIdFromRequest: () => 'fixture', canAccessAccount: () => true, adminLogger: { error() {} },
    sendProviderError: (res, error) => res.status(500).json({ ok: false, error: error.message }) });
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  return { routes, calls, res };
}

test('mall route shows the returned price and actual remaining limit', async () => {
  const h = routeHarness({ goods_id: 1002, price: { id: 1002, count: 65 }, is_available: true,
    purchase_limit: { limit_type: 4, bought_count: 1, limit_count: 1 } });
  await h.routes.get('/api/shop/mall')({}, h.res);
  assert.equal(h.res.body.ok, true);
  assert.equal(h.res.body.data[0].price, 65);
  assert.equal(h.res.body.data[0].isSoldOut, true);
  assert.equal(h.res.body.data[0].canBuy, false);
});

test('mall HTTP route rejects malformed quantities before contacting the worker', async () => {
  for (const count of [-1, 0.5, '1', 0, null]) {
    const h = routeHarness({});
    await h.routes.get('/api/shop/mall/buy')({ body: { goodsId: 1002, count } }, h.res);
    assert.equal(h.res.statusCode, 400); assert.equal(h.calls.length, 0);
  }
});
