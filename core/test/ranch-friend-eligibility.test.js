const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const Long = require('long');

function load(relative, mocks) {
    const filename = path.resolve(__dirname, relative);
    const local = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, process, Buffer,
        require: key => Object.hasOwn(mocks, key) ? mocks[key] : local(key),
    }, { filename });
    return module.exports;
}

const friendRows = () => [
    { gid: 10001, name: '小果', avatarUrl: '' },
    { gid: 1240527334, name: '正常好友', avatarUrl: '' },
    { gid: 1240157857, name: '小果', avatarUrl: '' },
];

test('ranch friend snapshots exclude the farm guide without mutating the farm list or hiding same-name players', async () => {
    const source = friendRows();
    const before = structuredClone(source);
    const service = load('../src/modern/services/ranch/state.js', {
        './transport': {
            isUnlocked: () => true,
            inScene: run => run({ facilities: [] }),
            rpc: async route => {
                assert.equal(route, 'bag');
                return { global_scene_id: 2, physical_items: [], virtual_items: [] };
            },
        },
        './friend-roster': { getRanchFriendList: async () => source },
        './operation-state': { forCurrentAccount: () => ({ pending: () => [] }) },
    });
    const state = await service.getState('friends');
    assert.deepEqual(Array.from(state.friends, friend => friend.gid), ['1240527334', '1240157857']);
    assert.equal(state.friends[1].name, '小果');
    assert.deepEqual(source, before, 'the farm still retains its guide friend');
});

function patrolHarness(source, _cached) {
    const visits = [];
    const logs = [];
    let fetched = 0;
    let timeReads = 0;
    const service = load('../src/modern/services/ranch/automation.js', {
        '../../models/store': { getAutomation: () => ({ ranch_friend_steal: true, ranch_check_minutes: 5 }), getFriendBlacklist: () => [] },
        './transport': { isUnlocked: () => true, inScene: run => run({ facilities: [] }) },
        './state': {
            loadRaw: async () => ({ cells: { facilities: [] }, bag: {} }),
            snapshot: () => ({ facilities: [], serverTime: Date.now() }),
        },
        './friend-roster': { getRanchFriendList: async () => { fetched++; return source.filter(friend => String(friend.gid) !== '10001'); } },
        './friends': {
            getInteractionQuotaResetAt: () => 0,
            getInteractionTimes: async () => { timeReads++; return {}; },
            automateFriend: async gid => { visits.push(String(gid)); return { times: {}, results: [] }; },
        },
        './daily': {},
        '../../utils/utils': { getServerTimeSec: () => Date.now() / 1000, log: (...args) => logs.push(args) },
    });
    return { service, visits, logs, fetched: () => fetched, timeReads: () => timeReads };
}

test('ranch automatic patrol skips the farm guide in both cached and freshly fetched lists', async () => {
    for (const cached of [true, false]) {
        const source = friendRows();
        const h = patrolHarness(source, cached);
        await h.service.run();
        assert.deepEqual(h.visits, ['1240527334', '1240157857']);
        assert.equal(h.fetched(), 1, 'the ranch uses its own scene roster');
        assert.equal(h.logs.length, 0);
        assert.equal(source.length, 3);
        await h.service.run();
        assert.equal(h.visits.includes('10001'), false);
    }
});

test('an account with only the farm guide performs no ranch friend visits or interaction reads', async () => {
    const h = patrolHarness([friendRows()[0]], true);
    await h.service.run();
    assert.deepEqual(h.visits, []);
    assert.equal(h.timeReads(), 0);
    assert.equal(h.logs.length, 0);
});

test('all manual and automatic ranch visit paths reject the farm guide before scene changes or RPC', async () => {
    const fail = () => assert.fail('the farm guide must never enter the ranch transport');
    const service = load('../src/modern/services/ranch/friends.js', {
        './transport': { inScene: fail, rpc: fail },
        '../../utils/network': { getUserState: fail },
        './state': {},
    });
    for (const gid of [10001, '10001', 10001n, Long.fromNumber(10001)]) {
        for (const run of [
            () => service.getFriend(gid),
            () => service.prepareSteal({ hostGid: gid }),
            () => service.steal({ hostGid: gid }),
            () => service.prepareInteraction('cleanFriend', { hostGid: gid }),
            () => service.interact('stroke', { hostGid: gid }),
            () => service.automateFriend(gid, () => true),
        ]) {
            await assert.rejects(run(), { code: 'INVALID_ARGUMENT', message: '该好友仅有农场' });
        }
    }
});

test('a real player named 小果 remains visitable in the ranch', async () => {
    const calls = [];
    const socket = {};
    const gid = '1240157857';
    const service = load('../src/modern/services/ranch/friends.js', {
        './transport': {
            inScene: run => run(),
            rpc: async route => {
                calls.push(route);
                if (route === 'enterFriend') return { basic: { gid, name: '小果', big_farm_level: 1 }, homestead_cells: {} };
                if (route === 'animals') return { ranches: [] };
                if (route === 'opTimes') return { ops: [11009, 11003, 11008].map(op_id => ({ op_id, remaining_times: 0 })) };
                assert.equal(route, 'leaveFriend');
                return {};
            },
        },
        '../../utils/network': { getUserState: () => ({ gid: 99999 }), getWs: () => socket },
        './state': {},
    });
    const result = await service.getFriend(gid);
    assert.equal(result.gid, gid);
    assert.equal(result.name, '小果');
    assert.deepEqual(calls, ['enterFriend', 'animals', 'opTimes', 'leaveFriend']);
});
