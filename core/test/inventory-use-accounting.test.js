const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const protobuf = require('protobufjs');
const { EventEmitter } = require('node:events');
const root = new protobuf.Root().loadSync(path.join(__dirname, '../src/modern/proto/itempb.proto'), { keepCase: true });
const types = Object.fromEntries(['BagRequest', 'BagReply', 'SellRequest', 'SellReply', 'UseRequest', 'UseReply',
  'BatchUseRequest', 'BatchUseReply', 'LockItemsRequest', 'LockItemsReply', 'UnlockItemsRequest', 'UnlockItemsReply']
  .map(name => [name, root.lookupType(`gamepb.itempb.${name}`)]));
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(options = {}) {
  const rows = options.rows || [{ id: 3001, count: 2, uid: 11, locked: false }];
  const state = { gold: 100, exp: 0 };
  const calls = [], events = new EventEmitter(), logs = [], statusWrites = [];
  let clock = 0;
  const mocks = {
    '../utils/proto': { types },
    '../utils/utils': { toNum: value => Number(value) || 0, toLong: Number, toTimeSec: Number,
      getSystemDateKey: () => '2026-10-30', sleep: async ms => { clock += ms; },
      log: (_tag, message, meta) => logs.push({ message, meta }), logWarn() {} },
    '../config/gameConfig': { getItemById: () => ({ type: 17, name: 'fixture' }),
      getPlantByFruitId: id => id === 3001 ? {} : null, getFruitName: () => 'fixture',
      getEffectiveSellInfo: () => ({ sellable: true }) },
    '../models/store': { isAutomationOn: () => true },
    './activity-windows': { getSellConditionContext: async () => ({}) },
    './status': { updateStatusGold: value => statusWrites.push(value) },
    '../utils/network': { getUserState: () => state, networkEvents: events, sendMsgAsync: async (_service, method, body) => {
      if (method === 'Bag') {
        const body = types.BagReply.encode({ item_bag: { items: rows } }).finish();
        await options.beforeBag?.();
        return { body };
      }
      const req = types[`${method}Request`].decode(body);
      calls.push({ method, req });
      await options.beforeMutation?.(method);
      if (method === 'LockItems' || method === 'UnlockItems') {
        for (const uid of req.item_uids) rows.find(row => row.uid === Number(uid)).locked = method === 'LockItems';
        return { body: types[`${method}Reply`].encode({ item_uids: req.item_uids }).finish() };
      }
      if (method === 'Sell') {
        if (options.balanceAfterSale !== undefined) state.gold = options.balanceAfterSale;
        return { body: types.SellReply.encode({ get_items: [{ id: 1001, count: 20 }] }).finish() };
      }
      const requested = method === 'Use' ? [req.item] : req.items;
      for (const item of requested) {
        const row = rows.find(row => row.id === Number(item.id) && row.uid === Number(item.uid));
        if (row) row.count -= Number(item.count);
      }
      return { body: types[`${method}Reply`].encode({ used_items: requested }).finish() };
    } },
  };
  const module = { exports: {} };
  const filename = path.resolve(__dirname, '../src/modern/services/warehouse.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
    require: name => { assert.ok(Object.hasOwn(mocks, name), name); return mocks[name]; },
    Date: { now: () => clock } }, { filename });
  return { api: module.exports, rows, state, calls, events, logs, statusWrites };
}

test('use waits for the preceding lock and rejects the newly locked stack', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ beforeMutation: method => method === 'LockItems' ? gate : undefined });
  const pending = Promise.allSettled([h.api.setItemsLocked([11], true), h.api.useItem(3001, 1, [], 11)]);
  await tick();
  const methodsBeforeUnlock = h.calls.map(call => call.method);
  release();
  const result = await pending;
  assert.deepEqual(methodsBeforeUnlock, ['LockItems']);
  assert.deepEqual(result.map(row => row.status), ['fulfilled', 'rejected']);
  assert.match(result[1].reason.message, /锁定/);
  assert.equal(h.rows[0].count, 2);
});

test('concurrent uses re-read stock after the prior mutation', async () => {
  const h = harness({ rows: [{ id: 3001, count: 1, uid: 11 }] });
  const result = await Promise.allSettled([h.api.useItem(3001), h.api.useItem(3001)]);
  assert.deepEqual(result.map(row => row.status), ['fulfilled', 'rejected']);
  assert.equal(h.calls.length, 1);
  assert.equal(h.rows[0].count, 0);
});

test('batch use rejects locked, invalid, mismatched and cumulatively excessive requests before mutation', async () => {
  const cases = [
    { items: [{ itemId: 3001, count: 1, uid: 11 }], locked: true },
    { items: [{ itemId: 3001, count: 3, uid: 11 }] },
    { items: [{ itemId: 3001, count: 2, uid: 11 }, { itemId: 3001, count: 1, uid: 11 }] },
    { items: [{ itemId: 9999, count: 1, uid: 11 }] },
    ...[0, -1, 0.5, Infinity, '1', null].map(count => ({ items: [{ itemId: 3001, count, uid: 11 }] })),
    { items: [] },
  ];
  for (const fixture of cases) {
    const h = harness({ rows: [{ id: 3001, count: 2, uid: 11, locked: fixture.locked === true }] });
    await assert.rejects(h.api.batchUseItems(fixture.items));
    assert.equal(h.calls.length, 0);
  }
});

test('multi-stack use splits across concrete unlocked UIDs without a nested queue deadlock', { timeout: 1000 }, async () => {
  const h = harness({ rows: [{ id: 3001, count: 2, uid: 11 }, { id: 3001, count: 2, uid: 12 },
    { id: 3001, count: 10, uid: 13, locked: true }] });
  await h.api.useItem(3001, 3);
  assert.deepEqual(h.calls.map(call => call.method), ['BatchUse']);
  assert.deepEqual(Array.from(h.calls[0].req.items, row => [Number(row.uid), Number(row.count)]), [[11, 2], [12, 1]]);
  await h.api.batchUseItems([{ itemId: 3001, count: 1, uid: 0 }]);
  assert.equal(h.rows[1].count, 0);
  assert.equal(h.rows[2].count, 10);
});

test('inventory mutations in another account are independent', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const first = harness({ beforeMutation: () => gate }), second = harness();
  const pending = first.api.useItem(3001);
  try {
    await second.api.useItem(3001);
    assert.equal(second.rows[0].count, 1);
  } finally { release(); await pending; }
});

test('a queued use never shares a UI bag snapshot taken before the preceding lock', async () => {
  let releaseLock, releaseBag, delayBag = false;
  const lockGate = new Promise(resolve => { releaseLock = resolve; });
  const bagGate = new Promise(resolve => { releaseBag = resolve; });
  const h = harness({ beforeMutation: method => method === 'LockItems' ? lockGate : undefined,
    beforeBag: () => delayBag ? bagGate : undefined });
  const locking = h.api.setItemsLocked([11], true);
  await tick(); delayBag = true;
  const uiRead = h.api.getBag();
  const using = h.api.useItem(3001, 1);
  const resultPromise = Promise.allSettled([locking, using]);
  releaseLock(); await tick(); releaseBag();
  await uiRead; const result = await resultPromise;
  assert.deepEqual(result.map(row => row.status), ['fulfilled', 'rejected']);
  assert.deepEqual(h.calls.map(row => row.method), ['LockItems']);
});

test('late sale notification is the only writer of the shared balance', async () => {
  const h = harness(); const gains = []; h.events.on('sell', value => gains.push(value));
  await h.api.sellAllFruits();
  assert.equal(h.state.gold, 100, 'sale reward must not be estimated into the balance');
  h.state.gold += 20;
  assert.equal(h.state.gold, 120);
  assert.deepEqual(h.statusWrites, []);
  assert.deepEqual(gains, [20]);
});

test('sale gain uses its response rather than unrelated balance changes', async () => {
  for (const balanceAfterSale of [0, 100, 150]) {
    const h = harness({ balanceAfterSale }); const gains = []; h.events.on('sell', value => gains.push(value));
    await h.api.sellAllFruits();
    assert.equal(h.state.gold, balanceAfterSale);
    assert.deepEqual(gains, [20]);
  }
});
