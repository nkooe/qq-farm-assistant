const test = require('node:test');
const assert = require('node:assert/strict');
const { createSelectedFarmOperations } = require('../src/services/farm-selected-operations');
const { validateFarmSelection } = require('../src/services/farm-selection');
const analyzer = require('../src/services/farm-land-analyzer');
const utils = require('../src/utils/utils');
const { PlantPhase } = require('../src/config/config');

const now = utils.getServerTimeSec();
const crop = (id, options = {}) => ({ id, unlocked: true, plant: {
    phases: [{ phase: PlantPhase.SEED, begin_time: now - 60 }, { phase: PlantPhase.MATURE, begin_time: now + 3600 }],
    left_inorc_fert_times: 2
}, ...options });
function setup(lands, overrides = {}) {
    const calls = []; const stats = [];
    const operation = createSelectedFarmOperations({ ...analyzer, ...utils, PlantPhase,
        getAllLands: async () => ({ lands }),
        mutate: async (action, ids) => { calls.push([action, ids]); return { land: ids.map(id => ({ id })) }; },
        recordOperation: (...args) => stats.push(args), log() {}, ...overrides });
    return { ...operation, calls, stats };
}

test('invalid or explicit empty selections never read or mutate the whole farm', async () => {
    const h = setup([crop(1)], { getAllLands: () => { throw new Error('must not read'); } });
    for (const ids of [undefined, null, {}, [], '1', [0], [-1], [1.2], ['1'], [true], [Number.NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1], Array.from({length: 65}).fill(1)]) {
        await assert.rejects(h.operate('remove', ids), /选择|ID/);
    }
    assert.throws(() => validateFarmSelection('all', [1]), /不支持/);
    assert.deepEqual(validateFarmSelection('remove', Array.from({ length: 64 }, (_, i) => i + 1)).length, 64);
    assert.deepEqual(h.calls, []);
});

test('selected slaves and duplicate IDs map to one master; unselected crops stay untouched', async () => {
    const h = setup([crop(1, { slave_land_ids: [2, 3, 4] }),
        { id: 2, unlocked: true, master_land_id: 1 }, { id: 3, unlocked: true, master_land_id: 1 }, crop(5)]);
    const result = await h.operate('fertilizeOrganic', [2, 1, 2, 3]);
    assert.deepEqual(h.calls, [['fertilizeOrganic', [1]]]);
    assert.deepEqual(result.successLandIds, [1]);
    assert.deepEqual(h.stats, [['fertilize', 1]]);
});

test('fresh snapshot skips mature, exhausted, empty, locked and missing selections', async () => {
    const mature = crop(2); mature.plant.phases = [{ phase: PlantPhase.MATURE, begin_time: now - 1 }];
    const exhausted = crop(3); exhausted.plant.left_inorc_fert_times = 0;
    const h = setup([crop(1), mature, exhausted, { id: 4, unlocked: true }, crop(5, { unlocked: false }), crop(6)]);
    const result = await h.operate('fertilizeOrganic', [1, 2, 3, 4, 5, 99]);
    assert.deepEqual(h.calls, [['fertilizeOrganic', [1]]]);
    assert.equal(result.skipped.length, 5);
    assert.equal((await h.operate('fertilizeNormal', [3])).successLandIds.length, 1);
});

test('harvest and maintenance filter candidates without silently performing other farm work', async () => {
    const mature = crop(2); mature.plant.phases = [{ phase: PlantPhase.MATURE, begin_time: now - 1 }];
    const dry = crop(3); dry.plant.dry_num = 1;
    const bug = crop(4); bug.plant.social_items = [{ item_id: 301101, type: 2 }];
    const h = setup([crop(1), mature, dry, bug]);
    await h.operate('harvest', [1, 2]);
    await h.operate('clear', [1, 3, 4]);
    await h.operate('remove', [1]);
    assert.deepEqual(h.calls, [['harvest', [2]], ['clear', [3, 4]], ['remove', [1]]]);
});

test('partial acknowledgements and missing replies remain uncertain; fertilizer counters use item costs', async () => {
    let sends = 0;
    const h = setup([crop(1), crop(2)], { mutate: async () => { sends++; return {
        land: [{ id: 1 }, { id: 99 }], fertilizer: { id: 1011, count: 0 },
        land_op_drops: [{ land_id: 1, costs: [{ id: 1011, count: 600 }, { id: 99, count: 20 }] }]
    }; } });
    const result = await h.operate('fertilizeNormal', [1, 2]);
    assert.deepEqual(result.successLandIds, [1]);
    assert.deepEqual(result.unconfirmedLandIds, [2]);
    assert.equal(result.uncertain, true);
    assert.equal(result.fertilizerRemainingSec, 0);
    assert.equal(result.fertilizerConsumedSec, 600);
    assert.equal(sends, 1);
});

test('resource rejections and uncertain timeouts are never retried', async () => {
    for (const [error, uncertain] of [[Object.assign(new Error('肥料不足'), { code: 1001 }), false], [new Error('请求超时'), true]]) {
        let sends = 0;
        const h = setup([crop(1)], { mutate: async () => { sends++; throw error; } });
        const result = await h.operate('fertilizeNormal', [1]);
        assert.equal(result.uncertain, uncertain);
        assert.equal(result.successLandIds.length, 0);
        assert.deepEqual(result[uncertain ? 'unconfirmedLandIds' : 'failedLandIds'], [1]);
        assert.equal(sends, 1);
        assert.deepEqual(h.stats, []);
        assert.equal(h.isPending(), false);
    }
});

test('duplicate pending operations are rejected, independent accounts proceed and failed reads release the lock', async () => {
    let release;
    const h = setup([crop(1)], { getAllLands: () => new Promise(resolve => { release = resolve; }) });
    const first = h.operate('remove', [1]);
    await assert.rejects(h.operate('harvest', [1]), /正在进行/);
    assert.deepEqual((await setup([crop(1)]).operate('remove', [1])).successLandIds, [1]);
    release({ lands: [crop(1)] }); await first;
    assert.equal(h.isPending(), false);
    for (const snapshot of [{}, { lands: null }]) {
        const bad = setup([], { getAllLands: async () => snapshot });
        await assert.rejects(bad.operate('remove', [1]), /最新土地/);
        assert.equal(bad.isPending(), false); assert.deepEqual(bad.calls, []);
    }
});

test('batch API encodes only selected IDs, harvest disables is_all and decodes 1.15 item/drop fields', async t => {
    const network = require('../src/utils/network');
    const { types, loadProto } = require('../src/utils/proto');
    await loadProto();
    const original = network.sendMsgAsync; const apiPath = require.resolve('../src/services/farm-api'); const cached = require.cache[apiPath];
    const calls = [];
    // Encode independently by wire field numbers, instead of round-tripping the same schema.
    const { Writer } = require('protobufjs/minimal');
    const item = Writer.create().uint32(8).int64(1011).uint32(16).int64(1234).finish();
    const cost = Writer.create().uint32(8).int64(1011).uint32(16).int64(600).finish();
    const drop = Writer.create().uint32(8).int64(1).uint32(26).bytes(cost).finish();
    const reply = Writer.create().uint32(10).bytes(Writer.create().uint32(8).int64(1).finish())
        .uint32(26).bytes(item).uint32(34).bytes(drop).finish();
    network.sendMsgAsync = async (_service, method, bytes) => { calls.push({ method, bytes }); return { body: method === 'Fertilize' ? reply : Buffer.alloc(0) }; };
    delete require.cache[apiPath];
    t.after(() => { network.sendMsgAsync = original; require.cache[apiPath] = cached; });
    const api = require(apiPath);
    const result = await api.fertilizeBatch([1, 7], 1011);
    const request = types.FertilizeRequest.decode(calls[0].bytes);
    assert.deepEqual(request.land_ids.map(Number), [1, 7]);
    assert.equal(Number(request.fertilizer_id), 1011);
    assert.equal(Number(result.fertilizer.count), 1234);
    assert.equal(Number(result.land_op_drops[0].costs[0].count), 600);
    await api.harvest([7], false);
    assert.equal(types.HarvestRequest.decode(calls[1].bytes).is_all, false);
    await api.harvest([1, 7]);
    assert.equal(types.HarvestRequest.decode(calls[2].bytes).is_all, true);
    assert.equal(calls.length, 3);
});

test('land details expose fertilizer limits and golden bugs, count merged crops once and propagate read failures', async t => {
    const api = require('../src/services/farm-api');
    const original = api.getAllLands;
    const analyzerPath = require.resolve('../src/services/farm-land-analyzer');
    const cached = require.cache[analyzerPath];
    const master = crop(1, { slave_land_ids: [2] });
    master.plant.id = 1020516;
    master.plant.left_inorc_fert_times = 0;
    master.plant.social_items = [{ item_id: 301101, type: 2 }];
    api.getAllLands = async () => ({ lands: [master, { id: 2, unlocked: true, master_land_id: 1 }] });
    delete require.cache[analyzerPath];
    t.after(() => { api.getAllLands = original; require.cache[analyzerPath] = cached; });
    const { getLandsDetail } = require(analyzerPath);
    const details = await getLandsDetail();
    assert.equal(details.lands[0].organicFertilizerRemaining, 0);
    assert.equal(details.lands[0].needGoldenBug, true);
    assert.equal(details.lands[1].occupiedByMaster, true);
    assert.equal(details.summary.growing, 1);
    api.getAllLands = async () => { throw new Error('read unavailable'); };
    // Reload to capture the failing API, rather than returning a misleading empty farm.
    delete require.cache[analyzerPath];
    await assert.rejects(require(analyzerPath).getLandsDetail(), /read unavailable/);
});
