const { getPlantById } = require('../config/gameConfig');
const { getServerTimeSec, toNum, toTimeSec } = require('../utils/utils');

const SNAPSHOT_MAX_AGE_SEC = 180;
const HISTORY_MIN_SECONDS = 60;

// A merged footprint earns one harvest reward; future seasons have no confirmed schedule yet.
function buildHarvestEvents(lands, nowSec, getPlant = getPlantById) {
    const events = [], seen = new Set(), slaves = new Set();
    for (const land of lands) for (const id of land.slave_land_ids || []) slaves.add(toNum(id));
    for (const land of lands) {
        const id = toNum(land.id), master = toNum(land.master_land_id);
        if (!id || seen.has(id) || !land.unlocked || slaves.has(id) || (master && master !== id)) continue;
        seen.add(id);
        const plant = land.plant;
        if (!plant || !Array.isArray(plant.phases) || !plant.phases.length) continue;
        if ([0, 7].includes(toNum(plant.phases[0].phase))) continue;
        const phases = plant.phases.filter(p => toTimeSec(p.begin_time) > 0);
        const config = getPlant(toNum(plant.id));
        const configured = String(config?.grow_phases || '').split(';').filter(Boolean);
        const finalName = configured.at(-1)?.split(':')[0];
        const explicit = phases.find(p => [6, 19].includes(toNum(p.phase)) || toNum(p.phase_id) === 19);
        const last = phases.at(-1);
        const mature = explicit || (['成熟', '盛开'].includes(finalName)
            && plant.phases.length <= configured.length && toNum(last?.phase) === 2 ? last : null);
        if (!mature || !config || !land.buff || !Object.hasOwn(land.buff, 'plant_exp_bonus')
            || !Number.isFinite(Number(land.buff.plant_exp_bonus))) continue;
        const exp = Math.floor(toNum(config.exp) * (1 + Math.max(0, toNum(land.buff.plant_exp_bonus)) / 10000));
        if (exp > 0) events.push({ landId: id, at: Math.max(nowSec, toTimeSec(mature.begin_time)), exp });
    }
    return events.sort((a, b) => a.at - b.at || a.landId - b.landId);
}

function calculateLevelForecast(options) {
    const { nowSec } = options;
    const remainingExp = Math.max(0, toNum(options.remainingExp));
    const base = { generatedAt: nowSec * 1000, remainingExp, scheduledExp: 0, plotCount: 0, readyExp: 0,
        estimatedAt: null, source: 'unavailable', automatic: !!options.autoHarvest && !options.quiet };
    if (!options.connected || remainingExp <= 0) return base;
    const events = buildHarvestEvents(options.lands || [], nowSec, options.getPlant);
    base.scheduledExp = events.reduce((sum, event) => sum + event.exp, 0);
    base.plotCount = events.length;
    base.readyExp = events.filter(event => event.at <= nowSec).reduce((sum, event) => sum + event.exp, 0);
    let total = 0;
    for (const event of events) {
        total += event.exp;
        if (total >= remainingExp) return { ...base, source: event.at <= nowSec ? 'ready' : 'planted', estimatedAt: event.at * 1000 };
    }
    // Historical gains extend the schedule only after its last harvest, avoiding double counting.
    const rate = Math.max(0, toNum(options.historyRate));
    if (rate <= 0 || !base.automatic) return base;
    const startAt = events.length ? events.at(-1).at : nowSec;
    return { ...base, source: events.length ? 'mixed' : 'history',
        estimatedAt: (startAt + Math.ceil((remainingExp - total) / rate * 3600)) * 1000 };
}

function createLandForecast({ now = getServerTimeSec, getPlant = getPlantById } = {}) {
    let revision = 0, snapshot = null;
    function invalidateLandForecast() { snapshot = null; revision++; }
    function getLandForecastRevision() { return revision; }
    function rememberLandForecast(lands, user, expectedRevision) {
        if (revision !== expectedRevision || !Array.isArray(lands)) return;
        snapshot = { lands, gid: toNum(user.gid), exp: toNum(user.exp), at: now() };
    }
    function getLevelForecast(user, progress, stats, automation, quiet = false) {
        const nowSec = now();
        const valid = snapshot && snapshot.gid === toNum(user.gid) && snapshot.exp === toNum(user.exp)
            && nowSec >= snapshot.at && nowSec - snapshot.at <= SNAPSHOT_MAX_AGE_SEC;
        const elapsed = Math.max(0, toNum(stats.sessionElapsedSeconds));
        return calculateLevelForecast({ lands: valid ? snapshot.lands : [], nowSec, getPlant,
            remainingExp: progress ? toNum(progress.needed) - toNum(progress.current) : 0,
            historyRate: elapsed >= HISTORY_MIN_SECONDS ? Math.max(0, toNum(stats.sessionExpGained)) / elapsed * 3600 : 0,
            connected: !!stats.connection?.connected, autoHarvest: !!automation?.farm, quiet });
    }
    return { invalidateLandForecast, getLandForecastRevision, rememberLandForecast, getLevelForecast };
}
module.exports = { buildHarvestEvents, calculateLevelForecast, createLandForecast, ...createLandForecast() };
