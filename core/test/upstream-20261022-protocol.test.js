const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const protobuf = require('protobufjs');

function roundtrip(type, value) {
    return type.toObject(type.decode(type.encode(type.fromObject(value)).finish()), { longs: String });
}

test('milk tea protocol preserves actual interaction rewards, shop status and activity metadata', () => {
    const root = new protobuf.Root().loadSync(path.join(__dirname, '../src/modern/proto/milk-tea.proto'), { keepCase: true });
    const interact = root.lookupType('gamepb.activitypb.MilkTeaHireInteract');
    assert.equal(interact.fields.items_gained.id, 8);
    const value = roundtrip(interact, { type: 4, interaction_id: '90014', success: true, items_gained: [{ id: '1042', count: '6' }] });
    assert.deepEqual(value.items_gained, [{ id: '1042', count: '6' }]);
    const head = root.lookupType('gamepb.activitypb.MilkTeaActivityHead');
    const metadata = { client_id: '2026110101', status: 1, splash_order: '2', splashed: true, has_red_dot: true, settle_start_time: '1794671999' };
    assert.deepEqual(roundtrip(head, metadata), metadata);
    const rank = root.lookupType('gamepb.activitypb.MilkTeaRankItem');
    assert.equal(roundtrip(rank, { shop_opened: true }).shop_opened, true);
});

test('both shop protocol roots preserve existing type numbers and decode ownership', () => {
    for (const dir of ['proto', 'modern/proto']) {
        const root = new protobuf.Root().loadSync(path.join(__dirname, '../src', dir, 'shoppb.proto'), { keepCase: true });
        assert.deepEqual({ ...root.lookupEnum('gamepb.shoppb.ShopType').values }, {
            SHOP_TYPE_UNKNOWN: 0, ITEM: 1, SEED: 2, PET: 3, SKIN: 4, CUB: 5, FEED: 6,
        });
        const goods = root.lookupType('gamepb.shoppb.GoodsInfo');
        assert.equal(goods.fields.owned.id, 15);
        assert.equal(roundtrip(goods, { id: '1', owned: true }).owned, true);
        assert.equal(roundtrip(goods, { id: '1' }).id, '1');
    }
});

test('updated resource tables retain the activity buff, milk tea formula and local compatibility items', () => {
    const buff = require('../src/modern/gameConfig/BuffCfg.json').find(row => row.id === 2101);
    assert.equal(buff.attr_value, 10000);
    const config = require('../src/modern/activity-data/milk-tea-20261015.json');
    const recipe = config.MilkTeaRecipeConfig.find(row => row.recipe_id === 9);
    assert.equal(recipe.coin_formula_a, 7296);
    assert.equal(recipe.coin_formula_c, 5472);
    const legacy = require('../src/gameConfig/ItemInfo.json');
    const modern = require('../src/modern/gameConfig/ItemInfo.json');
    assert.equal(legacy.length - modern.length, 6);
    for (const row of modern) assert.ok(legacy.some(item => item.id === row.id));
});
