const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');

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

function dailyHarness(outcomes) {
    const logs = [];
    const service = load('../src/modern/services/ranch/daily.js', {
        './transport': { isUnlocked: () => true },
        './actions': {},
        './daily-share': { getState: () => ({ dateKey: '2026-11-18' }) },
        './daily-benefit': {
            getCachedState: () => null,
            claim: async () => {
                const outcome = outcomes.shift();
                if (outcome instanceof Error) throw outcome;
                return outcome;
            },
        },
        '../../models/store': { getAutomation: () => ({ ranch_check_minutes: 5 }) },
        '../../utils/utils': { log: (...args) => logs.push(args) },
    });
    return { service, logs };
}

test('temporarily unavailable ranch gifts stay unclaimed and can be checked again the same day', async () => {
    const h = dailyHarness([
        { skipped: true, claimed: false, rewards: [] },
        { skipped: false, claimed: true, rewards: [{ name: '罐头', count: '1' }] },
    ]);
    const before = Date.now();
    await h.service.claimBenefit();
    const waiting = h.service.getBenefitRoutineState();
    assert.equal(waiting.doneToday, false);
    assert.ok(waiting.nextCheckAt >= before + 600000);
    assert.equal(h.service.getOverview(true).gifts[0].doneToday, false);
    assert.equal(h.logs.length, 0);
    await h.service.claimBenefit();
    assert.equal(h.service.getBenefitRoutineState().doneToday, true);
    assert.equal(h.service.getBenefitRoutineState().nextCheckAt, 0);
    assert.equal(h.service.getOverview(true).gifts[0].doneToday, true);
    assert.equal(h.logs.length, 1);
});

test('already claimed and unknown ranch gifts stop safely while transient errors retain their retry', async () => {
    for (const [outcome, done, displayed] of [
        [{ skipped: true, claimed: true, rewards: [] }, true, true],
        [Object.assign(new Error('unknown receipt'), { outcomeUnknown: true }), true, false],
        [new Error('temporary read failure'), false, false],
    ]) {
        const h = dailyHarness([outcome]);
        await h.service.claimBenefit();
        assert.equal(h.service.getBenefitRoutineState().doneToday, done);
        assert.equal(h.service.getOverview(true).gifts[0].doneToday, displayed);
        if (!done) assert.ok(h.service.getBenefitRoutineState().nextCheckAt > Date.now());
    }
});

function friendHarness(blockedCode) {
    let host;
    const writes = [];
    const leaves = [];
    const warnings = [];
    const ranches = [{ ranch_inst_id: 10, husbandry_type: 1, animals: [], hazards: [], shelves: [
        { slot_index: 1, can_steal: true, lots: [{ item_id: 8001, remain_num: 5, can_steal: true, stealers: [] }] },
    ] }];
    const service = load('../src/modern/services/ranch/friends.js', {
        './transport': {
            inScene: run => run(),
            rpc: async (route, input) => {
                if (route === 'enterFriend') { host = input.host_gid; return { basic: { gid: host }, homestead_cells: {} }; }
                if (route === 'animals') return { ranches };
                if (route === 'leaveFriend') { leaves.push(input.host_gid); return {}; }
                assert.equal(route, 'steal');
                writes.push(host);
                return { op_results: [{ facility_inst_id: 10, kind: 2, target_id: 1, costs: [], rewards: [{ id: 8001, count: 1 }] }] };
            },
        },
        '../../utils/network': { getUserState: () => ({ gid: 99999 }), getWs: () => 'same-socket' },
        '../../utils/utils': { logWarn: (...args) => warnings.push(args) },
        './state': {},
        './operation-state': { forCurrentAccount: () => ({ spend: async (plan, run) => {
            if (plan.target.endsWith(':200')) throw Object.assign(new Error('上次结果待确认'), { code: blockedCode });
            return run();
        } }) },
    });
    return { service, writes, leaves, warnings };
}

test('a pending friend operation sends no duplicate and does not abort subsequent friend patrols', async () => {
    const h = friendHarness('PENDING_CONFIRMATION');
    const first = await h.service.automateFriend(200, action => action === 'steal');
    assert.equal(first.results.length, 0);
    const second = await h.service.automateFriend(300, action => action === 'steal');
    assert.equal(second.results.length, 1);
    assert.deepEqual(h.writes, ['300']);
    assert.deepEqual(h.leaves, ['200', '300']);
    assert.equal(h.warnings.length, 1);
});

test('unexpected friend operation failures still stop and restore the visit', async () => {
    const h = friendHarness('RANCH_RESULT_UNKNOWN');
    await assert.rejects(h.service.automateFriend(200, action => action === 'steal'), { code: 'RANCH_RESULT_UNKNOWN' });
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.leaves, ['200']);
});
