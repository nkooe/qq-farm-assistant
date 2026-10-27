const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const protobuf = require('protobufjs');
const root = new protobuf.Root().loadSync(path.join(__dirname, '../src/modern/proto/itempb.proto'), { keepCase: true });
const types = Object.fromEntries(['BagRequest', 'BagReply', 'SellRequest', 'SellReply', 'LockItemsRequest', 'LockItemsReply', 'UnlockItemsRequest', 'UnlockItemsReply'].map(name => [name, root.lookupType(`gamepb.itempb.${name}`)]));
function mock(name, exports) {
  const id = require.resolve(`../src/modern/${name}`);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
function harness() {
  const rows = [{ id: 3001, count: 5, uid: 11, locked: true }, { id: 3001, count: 7, uid: 12, locked: false }];
  const writes = [];
  mock('utils/proto', { types });
  mock('utils/utils', { toNum: value => Number(value) || 0, toLong: value => value, toTimeSec: Number, getSystemDateKey: () => '2026-10-19' });
  mock('config/gameConfig', {
    getItemById: () => ({ type: 17, name: '果实' }),
    getEffectiveSellInfo: () => ({ sellable: true }),
  });
  mock('services/activity-windows', { getSellConditionContext: async () => ({ nowSec: 1 }) });
  mock('utils/network', { networkEvents: new EventEmitter(), sendMsgAsync: async (_service, method, body) => {
    if (method === 'Bag') return { body: types.BagReply.encode({ item_bag: { items: rows } }).finish() };
    writes.push(method);
    const req = types[`${method}Request`].decode(body);
    if (method === 'LockItems' || method === 'UnlockItems') {
      for (const uid of req.item_uids) rows.find(r => r.uid === Number(uid)).locked = method === 'LockItems';
      return { body: types[`${method}Reply`].encode({ item_uids: req.item_uids }).finish() };
    }
    assert.equal(Number(req.items[0].uid), 12);
    return { body: types.SellReply.encode({}).finish() };
  } });
  const id = require.resolve('../src/modern/services/warehouse');
  delete require.cache[id];
  return { service: require(id), writes, rows };
}
test('same item ID stacks remain distinct; locked, ambiguous and over-count sales never reach the gateway', async () => {
  const h = harness();
  await assert.rejects(h.service.sellItems([{ id: 3001, count: 5, uid: 11 }]), /锁定/);
  await assert.rejects(h.service.sellItems([{ id: 3001, count: 1 }]), /UID/);
  await assert.rejects(h.service.sellItems([{ id: 3001, count: 8, uid: 12 }]), /库存/);
  await assert.rejects(h.service.sellItems([{ id: 3001, count: 7, uid: 12 }, { id: 3001, count: 7, uid: 12 }]), /重复/);
  assert.equal(h.writes.length, 0);
  await h.service.sellItems([{ id: 3001, count: 7, uid: 12 }]);
  assert.deepEqual(h.writes, ['Sell']);
});
test('a queued sale rechecks the lock applied by the preceding inventory mutation', async () => {
  const h = harness();
  const results = await Promise.allSettled([
    h.service.setItemsLocked([12], true),
    h.service.sellItems([{ id: 3001, count: 7, uid: 12 }]),
  ]);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected']);
  assert.deepEqual(h.writes, ['LockItems']);
  await h.service.setItemsLocked([12], false);
  await h.service.sellItems([{ id: 3001, count: 7, uid: 12 }]);
  assert.deepEqual(h.writes, ['LockItems', 'UnlockItems', 'Sell']);
});
test('activity-dependent sale conditions fail closed for unknown and stale windows', () => {
  const { isSellConditionSatisfied: allowed } = require('../src/modern/config/sell-conditions');
  const context = { nowSec: 100, activityWindowsLoaded: true, activityWindows: new Map() };
  for (const rule of ['活动结束后:1', '活动结束前:1', '活动区间外:1']) assert.equal(allowed(rule, context), false);
  context.activityWindows.set('1', { beginTime: 1, endTime: 99 });
  assert.equal(allowed('活动结束后:1', context), true);
  assert.equal(allowed('活动结束后:1', { ...context, activityWindowsLoaded: false }), false);
  assert.equal(allowed('道具过期后:', { ...context, expireTime: 101 }), false);
});
