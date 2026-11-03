const { compileFunction } = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const protobuf = require('protobufjs');

const file = path.resolve(__dirname, '../src/modern/services/collections.js');
const realRequire = createRequire(file);
const root = new protobuf.Root().loadSync(path.resolve(__dirname, '../src/modern/proto/collectionpb.proto'), { keepCase: true });
const types = Object.fromEntries(['GetCollections', 'UpgradeCollection', 'ClaimCollectionReward', 'SwitchSceneDisplay']
  .flatMap(name => ['Request', 'Reply'].map(suffix => [name + suffix, root.lookupType(`gamepb.collectionpb.${name}${suffix}`)])));
function harness() {
  const data = { details: [{ category: 1, collections: [{ collection_id: 700001, own_count: 12, star_level: 0 }], current_score: 0, claimed_reward_score: 0 }], display_slots: [] };
  const bag = [{ id: 1001, count: 20000000 }];
  const reads = []; const writes = [];
  let corrupt = false; let offline = false;
  const mocks = {
    '../utils/proto': { types },
    './warehouse': { getBag: async () => ({ items: bag }), getBagItems: reply => reply.items, isItemLocked: item => !!item.locked },
    '../utils/network': { sendMsgAsync: async (_service, method, body) => {
      if (offline) throw new Error('network unavailable');
      const req = types[`${method  }Request`].decode(body);
      if (method === 'GetCollections') {
        reads.push(method);
        assert.deepEqual(req.categories, [1]);
        return { body: types.GetCollectionsReply.encode(data).finish() };
      }
      writes.push(method);
      const detail = data.details[0]; const item = detail.collections[0];
      let reply;
      if (method === 'UpgradeCollection') {
        const previous = item.star_level;
        item.own_count -= previous === 0 ? 1 : 2;
        item.star_level++;
        detail.current_score = previous === 0 ? 600 : 1080;
        if (previous > 0) bag[0].count -= 3000000;
        reply = { category: 1, collection_id: item.collection_id, star_level: item.star_level, own_count: item.own_count, current_score: detail.current_score };
        if (corrupt) reply.own_count++;
      } else if (method === 'SwitchSceneDisplay') {
        data.display_slots = [req.display_slot];
        reply = { display_slot: req.display_slot };
      } else {
        detail.claimed_reward_score = detail.current_score;
        reply = { current_score: detail.current_score, claimed_reward_score: detail.claimed_reward_score, claimed_scores: [100], total_rewards: [{ id: 1001, count: 7 }] };
      }
      return { body: types[`${method  }Reply`].encode(reply).finish() };
    } },
  };
  const module = { exports: {} };
  compileFunction(fs.readFileSync(file, 'utf8'), ['require', 'module', 'exports'])(name => mocks[name] || realRequire(name), module, module.exports);
  return { api: module.exports, data, bag, writes, reads, corrupt: () => { corrupt = true; }, offline: () => { offline = true; } };
}
const currentItem = snapshot => snapshot.series.flatMap(series => series.items).find(item => item.id === 700001);
const input = snapshot => ({ collectionId: 700001, expectedStarLevel: currentItem(snapshot).starLevel, expectedCosts: currentItem(snapshot).nextStarCosts });

test('collection ownership is separate from activation, with claimed milestone buffs only', async () => {
  const h = harness(); const snapshot = await h.api.getCollectionsSnapshot();
  assert.equal(snapshot.totalCount, 30);
  assert.equal(currentItem(snapshot).ownCount, '12');
  assert.equal(currentItem(snapshot).activated, false);
  assert.equal(snapshot.activatedCount, 0);
  assert.equal(snapshot.currentBuffs.length, 0);
  assert.throws(() => h.api.normalizeCollections({ details: [] }), /未返回/);
});

test('parallel collection reads coalesce, but separate worker services never share state', async () => {
  const a = harness(); const b = harness();
  b.data.details[0].collections[0].own_count = 99;
  const [one, two, other] = await Promise.all([a.api.getCollectionsSnapshot(), a.api.getCollectionsSnapshot(), b.api.getCollectionsSnapshot()]);
  assert.equal(currentItem(one).ownCount, '12');
  assert.equal(currentItem(two).ownCount, '12');
  assert.equal(currentItem(other).ownCount, '99');
  assert.equal(a.reads.length, 1);
});

test('activation checks actual reply and consumes a copy; a queued stale upgrade is rejected', async () => {
  const h = harness(); const before = await h.api.getCollectionsSnapshot();
  const results = await Promise.allSettled([h.api.upgradeCollection(input(before)), h.api.upgradeCollection(input(before))]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  assert.equal(currentItem(results[0].value.snapshot).starLevel, 1);
  assert.equal(currentItem(results[0].value.snapshot).ownCount, '11');
  assert.deepEqual(h.writes, ['UpgradeCollection']);
});

test('upgrades reject changed costs, insufficient unlocked gold and a stale star level', async () => {
  const h = harness();
  h.data.details[0].collections[0].star_level = 1;
  h.data.details[0].current_score = 600;
  const before = await h.api.getCollectionsSnapshot();
  await assert.rejects(h.api.upgradeCollection({ ...input(before), expectedCosts: [] }), /材料已变化/);
  h.bag[0].locked = true;
  await assert.rejects(h.api.upgradeCollection(input(before)), /不足/);
  assert.equal(h.writes.length, 0);
});

test('uncertain collection write is reported once and never automatically repeated', async () => {
  const h = harness(); const before = await h.api.getCollectionsSnapshot();
  h.corrupt();
  await assert.rejects(h.api.upgradeCollection(input(before)), /结果无法确认/);
  assert.equal(h.writes.length, 1);
});

test('display verifies activation and the expected current slot, and supports clearing', async () => {
  const h = harness();
  await assert.rejects(h.api.setCollectionDisplay({ collectionId: 700001, displayed: true, expectedDisplayItemId: '0' }), /先激活/);
  h.data.details[0].collections[0].star_level = 1;
  await assert.rejects(h.api.setCollectionDisplay({ collectionId: 700001, displayed: true, expectedDisplayItemId: '700002' }), /已变化/);
  const shown = await h.api.setCollectionDisplay({ collectionId: 700001, displayed: true, expectedDisplayItemId: '0' });
  assert.equal(shown.snapshot.display.itemId, '700001');
  const cleared = await h.api.setCollectionDisplay({ collectionId: 700001, displayed: false, expectedDisplayItemId: '700001' });
  assert.equal(cleared.snapshot.display, null);
});

test('collection read errors propagate and unsupported writes never reach the network', async () => {
  const h = harness();
  h.offline();
  await assert.rejects(h.api.getCollectionsSnapshot(), /network unavailable/);
  assert.throws(() => h.api.operateCollections('wish'), /未知/);
  assert.throws(() => h.api.operateCollections('upgrade', null), /参数/);
  assert.equal(h.writes.length, 0);
});

test('score rewards are claimed once and only claimed thresholds apply buffs', async () => {
  const h = harness();
  h.data.details[0].current_score = 400;
  const result = await h.api.claimCollectionRewards();
  assert.equal(result.snapshot.claimedScore, 400);
  assert.equal(result.rewards[0].count, '7');
  assert.equal((await h.api.claimCollectionRewards()).skipped, true);
  assert.deepEqual(h.writes, ['ClaimCollectionReward']);
});
