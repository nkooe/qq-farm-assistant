const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const lock = require('../src/services/automation-lock');

function harness(onWait) {
  let clock = 0, waits = 0;
  const events = [], blacklist = [];
  const auto = { friend: true, friend_steal: true };
  const filename = path.resolve(__dirname, '../src/services/friend-orchestrator.js');
  const local = createRequire(filename);
  const module = { exports: {} };
  const limits = new Proxy({ getCanGetHelpExp: () => true, canOperate: () => true }, { get: (target, key) => target[key] || (() => {}) });
  const mocks = {
    'node:perf_hooks': { performance: { now: () => clock } },
    'node:timers/promises': { setTimeout: async ms => {
      waits++; clock += ms;
      await lock.runExclusiveAutomationTask('farm_during_wait', async () => { events.push('farm'); });
      onWait?.({ auto, blacklist, api: module.exports });
    } },
    '../models/store': { isAutomationOn: key => !!auto[key], getStealDelaySeconds: () => 2,
      getConfigSnapshot: () => ({ automation: {} }), readFriendDogInfoCache: () => ({}),
      getFriendBlacklistDetails: () => blacklist },
    '../utils/network': { getUserState: () => ({ gid: 1, accountId: 'A' }), isConnected: () => true, networkEvents: new EventEmitter() },
    '../utils/utils': { toNum: Number, log() {}, logWarn() {}, randomDelay: async () => {}, isTransientNetworkError: () => false },
    './friend-operation-limits': limits,
    './friend-api': { inFriendQuietHours: () => false, clearAllInvalidKnownFriendGidCooldown() {},
      getAllFriends: async () => ({ friends: [2, 3].map(gid => ({ gid, plant: { steal_plant_num: 1 } })) }), extractReplyFriends: value => value.friends },
    './friend-visit': { visitFriendForSteal: async target => { events.push(`visit:${target.gid}`); } },
    './friend-pet-sync': { isPetSyncVisiting: () => false },
    './scheduler': { createScheduler: () => ({ clearAll() {} }) },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, process, AbortController,
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : local(name) }, { filename });
  return { ...module.exports, events, auto, get waits() { return waits; }, get clock() { return clock; } };
}

test('steal delay releases the transaction lock so farm work runs between visits', async () => {
  const h = harness();
  await h.checkFriends({ onlySteal: true });
  assert.equal(h.events[0], 'visit:2');
  assert.equal(h.events.at(-1), 'visit:3');
  assert.ok(h.events.slice(1, -1).every(event => event === 'farm'));
  assert.equal(h.clock, 2000);
  assert.equal(h.isCheckingFriendsRunning(), false);
});

for (const change of ['disable', 'blacklist', 'stop']) test(`steal delay rechecks ${change} before the next visit`, async () => {
  const h = harness(({ auto, blacklist, api }) => {
    if (change === 'disable') auto.friend_steal = false;
    if (change === 'blacklist') blacklist.push({ gid: 3, skipSteal: true });
    if (change === 'stop') api.stopFriendCheckLoop();
  });
  await h.checkFriends({ onlySteal: true });
  assert.deepEqual(h.events.filter(e => e.startsWith('visit')), ['visit:2']);
  assert.equal(h.isCheckingFriendsRunning(), false);
});
