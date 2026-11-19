const { getAllLands, fertilizeBatch } = require('./farm-api');
const { getFastMatureLands, getLandTypeByLevel, normalizeFertilizerLandTypes,
  filterLandIdsByTypes, fertilizeOrganicLoop } = require('./farm-fertilizer');
const { log, toNum } = require('../utils/utils');
const { recordOperation } = require('./stats');

const isRipeningOnlyMode = mode => mode === 'normal_ripen' || mode === 'organic_ripen';
async function runRipeningFertilizer(automation, lands, propagateErrors = false, canContinue = () => true) {
  if (!canContinue()) return 0;
  const mode = automation.fertilizer;
  if (mode !== 'smart' && !isRipeningOnlyMode(mode)) return 0;
  const selected = normalizeFertilizerLandTypes(automation.fertilizer_land_types);
  if (!selected.length) return 0;
  const snapshot = lands ?? (await getAllLands())?.lands;
  if (!canContinue() || !Array.isArray(snapshot)) return 0;
  const roots = snapshot.filter(land => land && (!toNum(land.master_land_id) || toNum(land.master_land_id) === toNum(land.id)));
  const types = new Map(roots.map(land => [toNum(land.id), getLandTypeByLevel(land.level)]));
  let targets = [...new Set(filterLandIdsByTypes(getFastMatureLands(roots, automation.fertilizer_smart_seconds), types, selected))];
  const normal = mode === 'normal_ripen';
  if (normal) {
    const eligible = new Set(roots.filter(land => toNum(land.plant?.left_inorc_fert_times) > 0).map(land => toNum(land.id)));
    targets = targets.filter(id => eligible.has(id));
  }
  if (!targets.length) return 0;
  let count;
  if (mode === 'smart') count = await fertilizeOrganicLoop(targets, propagateErrors, canContinue);
  else {
    let reply;
    try {
      reply = await fertilizeBatch(targets, normal ? 1011 : 1012, {
        beforeSend: () => canContinue() ? null : Object.assign(new Error('施肥任务已暂停'), { code: 'FARM_STOPPED' }),
      });
    } catch (cause) {
      if (cause.code === 'FARM_STOPPED') return 0;
      throw cause;
    }
    const updated = new Set((Array.isArray(reply?.land) ? reply.land : []).map(land => toNum(land.id)));
    count = targets.filter(id => updated.has(id)).length;
  }
  if (count) {
    recordOperation('fertilize', count);
    log('施肥', `临熟催熟：${normal ? '普通' : '有机'}化肥 ${count} 次`, {
      module: 'farm', event: '临熟催熟', result: 'ok', type: normal ? 'normal' : 'organic', count,
    });
  }
  return count;
}
module.exports = { isRipeningOnlyMode, runRipeningFertilizer };
