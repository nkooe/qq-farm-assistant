const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const protobuf = require('protobufjs');
const { buildLandUpgradeDetail } = require('../src/services/land-upgrade-detail');
const root = new protobuf.Root().loadSync(path.join(__dirname, '../src/proto/plantpb.proto'), { keepCase: true });
const LandInfo = root.lookupType('gamepb.plantpb.LandInfo');
const wire = value => LandInfo.decode(LandInfo.encode(LandInfo.fromObject(value)).finish());
test('runtime land protocol decodes server upgrade costs and keeps int64 values exact', () => {
    const land = wire({ id: 1, unlocked: true, level: 3, max_level: 5, could_upgrade: true, buff: { plant_yield_bonus: 24000, planting_time_reduction: 1234 }, upgrade_condition: { preceeding_lands_count_need: 1, level_need: 40, items_need: [{ id: 1001, count: '9007199254740993' }] } });
    const detail = buildLandUpgradeDetail(land, new Map([[1, land]]));
    assert.equal(detail.needLevel, 40);
    assert.equal(detail.serverAllowed, true);
    assert.equal(detail.current.yieldBonus, 240);
    assert.equal(detail.current.growthReduction, 12.34);
    assert.equal(detail.next.yieldBonus, 300);
    assert.equal(detail.costs[0].count, '9007199254740993');
    assert.equal(detail.unknown, false);
});
test('unlock shows server gold, prerequisite and level; unknown conditions do not become free upgrades', () => {
    const land = wire({ id: 2, unlock_condition: { preceding_land_id: 1, need_level: 10, need_gold: 5000 } });
    const detail = buildLandUpgradeDetail(land, new Map([[1, { unlocked: true }]]));
    assert.deepEqual(detail.prerequisite, { landId: 1, met: true });
    assert.equal(detail.needLevel, 10);
    assert.equal(detail.costs[0].count, '5000');
    assert.equal(buildLandUpgradeDetail({ id: 99 }).unknown, true);
    assert.equal(buildLandUpgradeDetail({ id: 99, unlocked: true, level: 8 }).unknown, true);
    const unknown = buildLandUpgradeDetail({ id: 1, unlocked: true, level: 2, upgrade_condition: { items_need: [{ id: 1001, count: 'bad' }] } });
    assert.equal(unknown.unknown, true);
    assert.equal(unknown.needLevel, null);
    assert.equal(unknown.costs[0].count, null);
});
test('static fallback remains usable and maximum land level needs no further costs', () => {
    const fallback = buildLandUpgradeDetail({ id: 1, unlocked: true, level: 1 });
    assert.equal(fallback.next.name, '红土地');
    assert.ok(fallback.costs.length);
    const max = buildLandUpgradeDetail({ id: 1, unlocked: true, level: 5, max_level: 5 });
    assert.equal(max.mode, 'max');
    assert.equal(max.next, null);
    assert.deepEqual(max.costs, []);
});

test('blue crystal upgrade reports the exact preceding land count independently from player level', () => {
    const land = wire({ id: 1, unlocked: true, level: 5, max_level: 6,
        upgrade_condition: { preceeding_lands_count_need: 12, level_need: 80, items_need: [{ id: 1005, count: 1000 }] } });
    const map = new Map([[1, land], [2, { unlocked: true, level: 4 }], [3, { unlocked: true, level: 6 }]]);
    const detail = buildLandUpgradeDetail(land, map);
    assert.equal(detail.next.name, '蓝晶土地');
    assert.equal(detail.needLevel, 80);
    assert.equal(detail.precedingLands.required, 12);
    assert.equal(detail.precedingLands.owned, 2);
    assert.equal(detail.precedingLands.met, false);
    assert.equal(detail.costs[0].count, '1000');
});
