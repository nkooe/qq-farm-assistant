const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHarvestEvents, calculateLevelForecast, createLandForecast } = require('../src/services/level-forecast');
const now = 1800000000;
const getPlant = () => ({ exp: 100, seasons: 3, grow_phases: '种子:10;成熟:10' });
function land(id = 1, at = now + 60, bonus = 0) {
    return { id, unlocked: true, buff: { plant_exp_bonus: bonus }, plant: { id: 99, season: 1,
        phases: [{ phase: 2, begin_time: now - 20 }, { phase: 6, begin_time: at }] } };
}
const options = { nowSec: now, remainingExp: 150, historyRate: 100, connected: true, autoHarvest: true, getPlant };

test('merged plots and multi-season crops produce one confirmed current-season reward each', () => {
    const master = { ...land(1), slave_land_ids: [2, 3] };
    const slave = { ...land(2), master_land_id: 1 };
    const secondSlave = { ...land(3), master_land_id: 1 };
    const events = buildHarvestEvents([master, slave, secondSlave, land(4, now + 120, 5000), master], now, getPlant);
    assert.deepEqual(events, [{ landId: 1, at: now + 60, exp: 100 }, { landId: 4, at: now + 120, exp: 150 }]);
});

test('locked, dead, missing maturity or missing server bonus never invent harvest XP', () => {
    const missing = land(1); delete missing.buff.plant_exp_bonus;
    const protoDefault = land(2); protoDefault.buff = Object.create({ plant_exp_bonus: 0 });
    const dead = land(3); dead.plant.phases[0].phase = 7;
    const unknown = land(4); unknown.plant.phases.pop();
    assert.deepEqual(buildHarvestEvents([missing, protoDefault, dead, { ...land(5), unlocked: false }], now, getPlant), []);
    assert.deepEqual(buildHarvestEvents([unknown], now, () => ({ exp: 100 })), []);
});

test('forecasts distinguish ready, planted, mixed, history, disabled automation and offline', () => {
    assert.equal(calculateLevelForecast({ ...options, lands: [land()], remainingExp: 100 }).source, 'planted');
    assert.equal(calculateLevelForecast({ ...options, lands: [land(1, now - 2)], remainingExp: 100 }).source, 'ready');
    const mixed = calculateLevelForecast({ ...options, lands: [land()] });
    assert.equal(mixed.source, 'mixed');
    assert.equal(mixed.estimatedAt, (now + 60 + 1800) * 1000);
    assert.equal(calculateLevelForecast(options).source, 'history');
    assert.equal(calculateLevelForecast({ ...options, autoHarvest: false }).estimatedAt, null);
    assert.equal(calculateLevelForecast({ ...options, quiet: true, lands: [land()] }).estimatedAt, null);
    assert.equal(calculateLevelForecast({ ...options, connected: false, lands: [land()] }).plotCount, 0);
    assert.equal(calculateLevelForecast({ ...options, historyRate: -10 }).estimatedAt, null);
});

test('snapshots reject mutation races, stale account/XP and expiry; history requires 60 seconds', () => {
    let clock = now;
    const cache = createLandForecast({ now: () => clock, getPlant });
    const user = { gid: 1, exp: 200 }, progress = { needed: 100, current: 0 };
    const stats = { connection: { connected: true }, sessionElapsedSeconds: 59, sessionExpGained: 100 };
    const read = (u = user) => cache.getLevelForecast(u, progress, stats, { farm: true });
    const revision = cache.getLandForecastRevision();
    cache.invalidateLandForecast(); cache.rememberLandForecast([land()], user, revision);
    assert.equal(read().source, 'unavailable');
    cache.rememberLandForecast([land()], user, cache.getLandForecastRevision());
    assert.equal(read().source, 'planted');
    assert.equal(read({ gid: 2, exp: 200 }).source, 'unavailable');
    assert.equal(read({ gid: 1, exp: 201 }).source, 'unavailable');
    clock += 181; assert.equal(read().source, 'unavailable');
    stats.sessionElapsedSeconds = 60; assert.equal(read().source, 'history');
    stats.connection.connected = false; assert.equal(read().estimatedAt, null);
});
