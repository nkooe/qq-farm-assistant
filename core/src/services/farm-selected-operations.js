const { validateFarmSelection } = require('./farm-selection');
const { createFarmOperationGuard, farmOperationGuard } = require('./farm-operation-guard');

// One instance per account worker. No retries: a missing reply may still have consumed resources.
function createSelectedFarmOperations({ getAllLands, buildLandMap, getDisplayLandContext,
    getCurrentPhase, getServerTimeSec, toNum, toTimeSec, PlantPhase, mutate, recordOperation, log,
    runExclusive = createFarmOperationGuard().run }) {
    let pending = false;

    async function operate(action, input) {
        return runExclusive(() => perform(action, input));
    }

    async function perform(action, input) {
        const selected = validateFarmSelection(action, input);
        if (pending) throw new Error('选地操作正在进行，请稍后再试');
        pending = true;
        try {
            const snapshot = await getAllLands();
            if (!Array.isArray(snapshot?.lands)) throw new Error('无法读取最新土地，请刷新后重试');
            const map = buildLandMap(snapshot.lands);
            const roots = new Set(); const skipped = [];
            for (const id of selected) {
                const land = map.get(id);
                if (!land) { skipped.push({ id, reason: '土地不存在' }); continue; }
                const context = getDisplayLandContext(land, map);
                roots.add(context.occupiedByMaster ? context.masterLandId : id);
            }
            const now = getServerTimeSec(); const targets = [];
            for (const id of roots) {
                const land = map.get(id); const plant = land?.plant;
                const phase = getCurrentPhase(plant?.phases);
                let reason = '';
                if (!land?.unlocked) reason = '土地未解锁';
                else if (!phase || phase.phase === PlantPhase.UNKNOWN) reason = '没有作物';
                else if (action.startsWith('fertilize')) {
                    const mature = plant.phases.find(p => toNum(p.phase) === PlantPhase.MATURE);
                    if ([PlantPhase.MATURE, PlantPhase.DEAD].includes(phase.phase)
                        || !mature || toTimeSec(mature.begin_time) <= now) reason = '作物已成熟或不能施肥';
                    else if (action === 'fertilizeOrganic' && Object.hasOwn(plant, 'left_inorc_fert_times')
                        && toNum(plant.left_inorc_fert_times) <= 0) reason = '有机肥次数已用完';
                } else if (action === 'harvest' && phase.phase !== PlantPhase.MATURE) reason = '作物尚未成熟';
                else if (action === 'clear') {
                    const due = key => toTimeSec(phase[key]) > 0 && toTimeSec(phase[key]) <= now;
                    if (phase.phase === PlantPhase.DEAD || !(toNum(plant.dry_num) > 0
                        || plant.weed_owners?.length || plant.insect_owners?.length
                        || due('dry_time') || due('weeds_time') || due('insect_time')
                        || plant.social_items?.some(item => toNum(item.item_id) === 301101 && toNum(item.type) === 2))) {
                        reason = '无需务农';
                    }
                }
                if (reason) skipped.push({ id, reason }); else targets.push(id);
            }
            const result = { action, requestedLandIds: selected, targetLandIds: targets,
                successLandIds: [], skipped, failedLandIds: [], unconfirmedLandIds: [],
                error: '', uncertain: false, fertilizerRemainingSec: null, fertilizerConsumedSec: null };
            if (!targets.length) return result;
            try {
                const reply = await mutate(action, targets);
                // Count only server-confirmed land IDs, including a returned slave's linked master.
                const acknowledged = [...(reply?.land || []), ...(reply?.results || [])]
                    .map(land => toNum(land.id || land.land_id)).map(id => {
                        const land = map.get(id);
                        return land ? getDisplayLandContext(land, map).masterLandId : id;
                    });
                const succeeded = new Set(acknowledged);
                result.successLandIds = targets.filter(id => succeeded.has(id));
                result.unconfirmedLandIds = targets.filter(id => !succeeded.has(id));
                result.uncertain = result.unconfirmedLandIds.length > 0;
                if (action.startsWith('fertilize')) {
                    const fertilizerId = action === 'fertilizeNormal' ? 1011 : 1012;
                    if (reply?.fertilizer) result.fertilizerRemainingSec = toNum(reply.fertilizer.count);
                    if (reply?.land_op_drops?.length) {
                        result.fertilizerConsumedSec = reply.land_op_drops.flatMap(drop => drop.costs || [])
                            .filter(item => toNum(item.id) === fertilizerId).reduce((sum, item) => sum + toNum(item.count), 0);
                    }
                }
            } catch (error) {
                result.error = error.message || '操作失败';
                // Numeric gateway errors are confirmed rejections. Transport failures have unknown outcomes.
                const rejected = Number.isFinite(Number(error.code)) && error.code != null;
                result[rejected ? 'failedLandIds' : 'unconfirmedLandIds'] = [...targets];
                result.uncertain = !rejected;
            }
            if (result.successLandIds.length) recordOperation(action.startsWith('fertilize') ? 'fertilize'
                : action === 'clear' ? 'farming' : action, result.successLandIds.length);
            log('农场', `选地操作 ${action}：确认成功 ${result.successLandIds.length}/${targets.length} 株`, {
                module: 'farm', event: '选地操作', action, landIds: targets,
                result: result.uncertain ? 'unknown' : result.error ? 'error' : 'ok'
            });
            return result;
        } finally { pending = false; }
    }
    return { operate, isPending: () => pending };
}

let instance;
function selectedFarmOperations() {
    if (!instance) {
        const api = require('./farm-api');
        const analyzer = require('./farm-land-analyzer');
        const utils = require('../utils/utils');
        const { PlantPhase } = require('../config/config');
        const { recordOperation } = require('./stats');
        instance = createSelectedFarmOperations({ ...api, ...analyzer, ...utils, PlantPhase, recordOperation,
            runExclusive: farmOperationGuard.run,
            mutate: (action, ids) => action.startsWith('fertilize')
                ? api.fertilizeBatch(ids, action === 'fertilizeNormal' ? 1011 : 1012)
                : action === 'clear' ? api.farming(ids)
                    : action === 'harvest' ? api.harvest(ids, false) : api.removePlant(ids)
        });
    }
    return instance;
}

module.exports = { createSelectedFarmOperations, selectedFarmOperations };
