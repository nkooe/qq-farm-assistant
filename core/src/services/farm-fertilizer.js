const { sendMsgAsync, getWs, isConnected } = require('../utils/network');
const { types } = require('../utils/proto');
const { PlantPhase } = require('../config/config');
const { toNum, toTimeSec, getServerTimeSec, log, logWarn, randomDelay, isTransientNetworkError } = require('../utils/utils');
const store = require('../models/store');
const { getAutomation } = store;
const { createFertilizerConfigGuard } = require('./fertilizer-config');
const { createOrganicFertilizerQueue } = require('./farm-organic-queue');
const { createScheduler } = require('./scheduler');
const { runExclusiveAutomationTask } = require('./automation-lock');
const { farmOperationGuard } = require('./farm-operation-guard');
const { recordOperation } = require('./stats');
const { getAllLands, fertilize, NORMAL_FERTILIZER_ID, ORGANIC_FERTILIZER_ID } = require('./farm-api');
const { getCurrentPhase } = require('./farm-land-analyzer');

// ─── 常量 ───

/** 全部可施肥土地类型 */
const DEFAULT_FERTILIZER_LAND_TYPES = ['purple', 'gold', 'black', 'red', 'normal'];
const ALL_FERTILIZER_LAND_TYPES = ['blue', 'purple', 'gold', 'black', 'red', 'normal'];

/** 土地类型中文标签 */
const FERTILIZER_LAND_TYPE_LABELS = {
  blue: '蓝晶土地',
  purple: '紫金土地',
  gold: '金土地',
  black: '黑土地',
  red: '红土地',
  normal: '普通土地'
};

// ─── 辅助函数 ───

/**
 * 每批最多施肥四次，其余由后台队列续跑。
 * @param {number[]} landIds - 地块 ID 列表
 * @returns {number} 本批成功次数；后续批次分别记入统计。
 */
async function fertilizeOrganicLoop(landIds, propagateErrors = false, canContinue = () => true) {
  const ids = [...new Set((Array.isArray(landIds) ? landIds : []).map(toNum).filter(id => Number.isSafeInteger(id) && id > 0))];
  if (ids.length === 0) return 0;
  const connection = getWs();
  const allowed = createFertilizerConfigGuard(getAutomation(),
    () => canContinue() && isConnected() && getWs() === connection, store);
  try { return await organicQueue.enqueue(ids, allowed); }
  catch (cause) {
    if (propagateErrors && isTransientNetworkError(cause)) throw cause;
    return 0;
  }
}

const organicQueue = createOrganicFertilizerQueue({
  scheduler: createScheduler('farm_organic'),
  runExclusive: task => {
    // Keep the same guard order as patrol and manual farm operations.
    if (farmOperationGuard.isPending()) return;
    return farmOperationGuard.run(() => runExclusiveAutomationTask('organic_fertilizer', task, { detached: true }));
  },
  prepare: async ids => {
    const { lands } = await getAllLands();
    const roots = (lands || []).filter(land => land && (!toNum(land.master_land_id) || toNum(land.master_land_id) === toNum(land.id)));
    const automation = getAutomation();
    const mode = automation.fertilizer;
    let eligible;
    if (mode === 'organic' || mode === 'both') eligible = getOrganicFertilizerTargetsFromLands(roots);
    else if (mode === 'final_organic') eligible = getFinalStageLands(roots);
    else if (mode === 'smart' || mode === 'smart_only') eligible = getFastMatureLands(roots, automation.fertilizer_smart_seconds);
    else eligible = [];
    const types = new Map(roots.map(land => [toNum(land.id), getLandTypeByLevel(land.level)]));
    const selected = new Set(filterLandIdsByTypes(eligible, types, automation.fertilizer_land_types));
    const requested = new Set(ids);
    return new Map(roots.filter(land => requested.has(toNum(land.id)) && selected.has(toNum(land.id)))
      .map(land => [toNum(land.id), `${toNum(land.plant.id)}:${toNum(land.plant.season)}:${toTimeSec(land.plant.phases[0].begin_time)}`]));
  },
  send: async (landId, allowed) => {
    const payload = types.FertilizeRequest.encode(types.FertilizeRequest.create({
      land_ids: [landId], fertilizer_id: toNum(ORGANIC_FERTILIZER_ID),
    })).finish();
    await sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', payload, {
      beforeSend: () => allowed() ? null : Object.assign(new Error('施肥任务已暂停'), { code: 'FARM_STOPPED' }),
    });
  },
  delay: randomDelay,
  onProgress: count => {
    recordOperation('fertilize', count);
    log('施肥', `有机施肥 ${count} 次`, { module: 'farm', event: '有机施肥', result: 'ok', type: 'organic', count });
  },
  onError: error => {
    if (error.code !== 'FARM_STOPPED') logWarn('施肥', `有机施肥已停止: ${error.message}`);
  },
});

/**
 * 从地块列表获取可施有机肥的目标
 * @param {Array} lands - 地块数据列表
 * @returns {number[]} 可施有机肥的地块 ID
 */
function getOrganicFertilizerTargetsFromLands(lands) {
  const list = Array.isArray(lands) ? lands : [];
  const targets = [];
  for (const land of list) {
    if (!land || !land.unlocked) continue;
    const landId = toNum(land.id);
    if (!landId) continue;

    const plant = land.plant;
    if (!plant || !plant.phases || plant.phases.length === 0) continue;

    const currentPhase = getCurrentPhase(plant.phases);
    if (!currentPhase) continue;
    if (currentPhase.phase === PlantPhase.DEAD || currentPhase.phase === PlantPhase.MATURE) continue;

    targets.push(landId);
  }
  return targets;
}

/**
 * 获取即将成熟的地块（用于智能施肥）
 * @param {Array} lands - 地块数据
 * @param {number} thresholdSec - 距成熟时间阈值（秒），默认 300（5分钟）
 */
function getFastMatureLands(lands, thresholdSec = 300) {
  const list = Array.isArray(lands) ? lands : [];
  const result = [];
  const serverTime = getServerTimeSec();
  const threshold = Math.max(0, toNum(thresholdSec) || 300);

  for (const land of list) {
    if (!land || !land.unlocked) continue;
    const landId = toNum(land.id);
    if (!landId) continue;

    const plant = land.plant;
    if (!plant || !plant.phases || plant.phases.length === 0) continue;

    const currentPhase = getCurrentPhase(plant.phases);
    if (!currentPhase) continue;
    if (currentPhase.phase === PlantPhase.DEAD) continue;
    if (currentPhase.phase === PlantPhase.MATURE) continue;

    // 查找成熟阶段
    const maturePhase = plant.phases.find(p => toNum(p.phase) === PlantPhase.MATURE);
    if (!maturePhase) continue;

    const matureTime = toTimeSec(maturePhase.begin_time);
    if (matureTime <= 0) continue;

    const remaining = matureTime - serverTime;
    if (remaining <= threshold && remaining >= 0) {
      result.push(landId);
    }
  }
  return result;
}

/**
 * 获取处于成熟前最后一个生长阶段的地块（用于最终阶段施肥）
 * @param {Array} lands - 地块数据
 * @returns {number[]} 最终阶段地块 ID
 */
function getFinalStageLands(lands) {
  const list = Array.isArray(lands) ? lands : [];
  const result = [];

  for (const land of list) {
    if (!land || !land.unlocked) continue;
    const landId = toNum(land.id);
    if (!landId) continue;

    const plant = land.plant;
    if (!plant || !Array.isArray(plant.phases) || plant.phases.length === 0) continue;

    const currentPhase = getCurrentPhase(plant.phases);
    if (!currentPhase) continue;

    const currentPhaseValue = toNum(currentPhase.phase);
    if (currentPhaseValue === PlantPhase.DEAD) continue;
    if (currentPhaseValue === PlantPhase.MATURE) continue;

    const orderedPhases = plant.phases
      .map((phase, index) => ({
        phase,
        index,
        beginTime: toTimeSec(phase && phase.begin_time)
      }))
      .filter(item => item.beginTime > 0)
      .sort((a, b) => (a.beginTime - b.beginTime) || (a.index - b.index));

    const matureIndex = orderedPhases.findIndex(item => toNum(item.phase && item.phase.phase) === PlantPhase.MATURE);
    if (matureIndex <= 0) continue;

    const currentIndex = orderedPhases.findIndex(item => item.phase === currentPhase);
    if (currentIndex !== matureIndex - 1) continue;

    result.push(landId);
  }

  return result;
}

/** 根据等级获取土地类型 */
function getLandTypeByLevel(level) {
  const lv = toNum(level);
  if (lv === 6) return 'blue';
  if (lv === 5) return 'purple';   // 紫土地
  if (lv === 4) return 'gold';     // 金土地
  if (lv === 3) return 'black';    // 黑土地
  if (lv === 2) return 'red';      // 红土地
  return 'normal';
}

/** 标准化施肥土地类型列表 */
function normalizeFertilizerLandTypes(types) {
  const input = Array.isArray(types) ? types : DEFAULT_FERTILIZER_LAND_TYPES;
  const result = [];
  for (const t of input) {
    const normalized = String(t || '').trim().toLowerCase();
    if (!ALL_FERTILIZER_LAND_TYPES.includes(normalized)) continue;
    if (result.includes(normalized)) continue;
    result.push(normalized);
  }
  return result;
}

/** 按土地类型过滤地块 ID */
function filterLandIdsByTypes(landIds, landTypeMap, allowedTypes) {
  const ids = Array.isArray(landIds) ? landIds : [];
  const typeSet = new Set(normalizeFertilizerLandTypes(allowedTypes));
  if (typeSet.size === 0) return [];
  if (typeSet.size === ALL_FERTILIZER_LAND_TYPES.length) return [...ids];

  const result = [];
  for (const landId of ids) {
    const landType = String(landTypeMap.get(landId) || '');
    if (!landType) continue;
    if (typeSet.has(landType)) result.push(landId);
  }
  return result;
}

/** 格式化土地类型为中文标签 */
function formatFertilizerLandTypes(types) {
  return normalizeFertilizerLandTypes(types).map(t => FERTILIZER_LAND_TYPE_LABELS[t] || t);
}

// ─── 核心施肥逻辑 ───

/**
 * 根据配置执行施肥
 * @param {number[]} explicitLandIds - 指定地块 ID（空数组则自动获取）
 * @param {object} options - { reason, skipNormal }
 * @returns {{ normal: number, organic: number }} 本批实际使用的无机和有机肥数量
 */
async function runFertilizerByConfig(explicitLandIds = [], options = {}) {
  const automation = getAutomation() || {};
  const canContinue = createFertilizerConfigGuard(automation, options.canContinue, store);
  const sendOptions = {
    canContinue,
    beforeSend: () => canContinue() ? null : Object.assign(new Error('施肥任务已暂停'), { code: 'FARM_STOPPED' }),
  };
  if (!canContinue()) return { normal: 0, organic: 0 };
  const mode = automation.fertilizer || 'none';
  const { isRipeningOnlyMode, runRipeningFertilizer } = require('./farm-ripening');
  if (isRipeningOnlyMode(mode)) return { normal: 0, organic: 0 };
  if (options.skipNormal && mode === 'smart') {
    return { normal: 0, organic: await runRipeningFertilizer(automation, undefined, options.propagateErrors, canContinue) };
  }
  const reason = String(options.reason || '').trim().toLowerCase() === 'multi_season' ? 'multi_season' : 'normal';
  const label = reason === 'multi_season' ? '多季补肥' : '常规施肥';
  const eventLabel = reason === 'multi_season' ? '多季节施肥' : '常规施肥';
  const landTypes = normalizeFertilizerLandTypes(automation.fertilizer_land_types);
  const landTypeLabels = formatFertilizerLandTypes(landTypes);

  if (reason === 'multi_season' && mode === 'final_normal') {
    log('施肥', '多季补肥：当前策略为最终阶段普通肥，跳过本轮多季补肥', {
      module: 'farm', event: eventLabel, result: 'skip', reason, type: 'normal'
    });
    return { normal: 0, organic: 0 };
  }

  const explicitIds = [...new Set(
    (Array.isArray(explicitLandIds) ? explicitLandIds : [])
      .map(id => toNum(id))
      .filter(Boolean)
  )];

  // 没有选中土地类型 → 跳过
  if (landTypes.length === 0) {
    log('施肥', `${label}：未勾选施肥范围，跳过本轮施肥`, {
      module: 'farm', event: eventLabel, result: 'skip', reason, scope: 'none'
    });
    return { normal: 0, organic: 0 };
  }

  const { skipNormal = false } = options;

  // 没有指定地块且非有机模式 → 空返回
  if (explicitIds.length === 0 &&
      mode !== 'organic' && mode !== 'both' &&
      mode !== 'smart' && mode !== 'smart_only' && mode !== 'smart_normal' &&
      mode !== 'final_normal' && mode !== 'final_organic') {
    return { normal: 0, organic: 0 };
  }

  // 获取全农场土地信息构建类型映射
  let allLands = [];
  const landTypeMap = new Map();
  try {
    const landsReply = await getAllLands();
    allLands = (Array.isArray(landsReply && landsReply.lands) ? landsReply.lands : [])
      .filter(land => !toNum(land?.master_land_id) || toNum(land.master_land_id) === toNum(land.id));
    for (const land of allLands) {
      if (!land) continue;
      const landId = toNum(land.id);
      if (!landId) continue;
      landTypeMap.set(landId, getLandTypeByLevel(land.level));
    }
  } catch (err) {
    if (!isTransientNetworkError(err)) {
      logWarn('施肥', `${label}：获取土地信息失败，按已知地块继续: ${err.message}`, {
        module: 'farm', event: eventLabel, result: 'error', reason
      });
    }
  }

  const isAllTypes = landTypes.length === ALL_FERTILIZER_LAND_TYPES.length;
  if (!canContinue()) return { normal: 0, organic: 0 };

  if (landTypeMap.size === 0 && !isAllTypes) {
    logWarn('施肥', `${label}：无法确认土地类型，已跳过本轮施肥`, {
      module: 'farm', event: eventLabel, result: 'skip', reason, landTypes
    });
    return { normal: 0, organic: 0 };
  }

  let targetIds = explicitIds;
  if (landTypeMap.size > 0) {
    targetIds = filterLandIdsByTypes(explicitIds, landTypeMap, landTypes);
  }

  let normalCount = 0;
  let organicCount = 0;

  // 普通化肥
  if (!skipNormal && (mode === 'normal' || mode === 'both' || mode === 'smart') && targetIds.length > 0) {
    const eligible = new Set(allLands.filter(land => toNum(land.plant?.left_inorc_fert_times) > 0).map(land => toNum(land.id)));
    targetIds = targetIds.filter(id => eligible.has(id));
    normalCount = await fertilize(targetIds, NORMAL_FERTILIZER_ID, sendOptions);
    if (normalCount > 0) {
      log('施肥', `${label}：已为 ${normalCount}/${targetIds.length} 块地施普通化肥（范围: ${landTypeLabels.join('、')}）`, {
        module: 'farm', event: eventLabel, result: 'ok', reason, type: 'normal',
        count: normalCount, landTypes
      });
      recordOperation('fertilize', normalCount);
    }
  }

  // 有机化肥
  if (mode === 'organic' || mode === 'both') {
    let organicTargets = explicitIds;
    if (allLands.length > 0) {
      organicTargets = getOrganicFertilizerTargetsFromLands(allLands);
    }
    if (landTypeMap.size > 0) {
      organicTargets = filterLandIdsByTypes(organicTargets, landTypeMap, landTypes);
    }
    organicCount = await fertilizeOrganicLoop(organicTargets, options.propagateErrors, canContinue);
  } else if (mode === 'smart' || mode === 'smart_only' || mode === 'smart_normal' ||
      mode === 'final_normal' || mode === 'final_organic') {
    // 智能/最终阶段施肥：寻找目标作物施肥
    let targetFertilizerLands = [];
    const isFinalStageMode = mode === 'final_normal' || mode === 'final_organic';
    const explicitIdSet = new Set(explicitIds);

    if (isFinalStageMode) {
      targetFertilizerLands = getFinalStageLands(allLands);
      if (explicitIdSet.size > 0) {
        targetFertilizerLands = targetFertilizerLands.filter(id => explicitIdSet.has(id));
      }
    } else {
      const smartSeconds = toNum(automation.fertilizer_smart_seconds) || 3600;

      try {
        const landsReply = await getAllLands();
        targetFertilizerLands = getFastMatureLands(landsReply && landsReply.lands, smartSeconds);
      } catch (err) {
        if (!isTransientNetworkError(err)) {
          logWarn('施肥', `获取全农场地块失败: ${err.message}`);
        }
      }
    }

    if (landTypeMap.size > 0) {
      targetFertilizerLands = filterLandIdsByTypes(targetFertilizerLands, landTypeMap, landTypes);
    }

    if (targetFertilizerLands.length > 0) {
      const useOrganic = mode === 'smart' || mode === 'smart_only' || mode === 'final_organic';
      const typeLabel = useOrganic ? '有机' : '普通';
      const fertId = useOrganic ? ORGANIC_FERTILIZER_ID : NORMAL_FERTILIZER_ID;
      const modeLabel = isFinalStageMode ? '最终阶段' : '快成熟';

      if (useOrganic) {
        organicCount = await fertilizeOrganicLoop(targetFertilizerLands, options.propagateErrors, canContinue);
      } else {
        const eligible = new Set(allLands.filter(land => toNum(land.plant?.left_inorc_fert_times) > 0).map(land => toNum(land.id)));
        normalCount = await fertilize(targetFertilizerLands.filter(id => eligible.has(id)), fertId, sendOptions);
      }

      const totalCount = useOrganic ? organicCount : normalCount;
      if (totalCount > 0 && !useOrganic) {
        log('施肥', `${typeLabel}化肥${modeLabel}施肥完成，共施 ${totalCount} 次（范围: ${landTypeLabels.join('、')}）`, {
          module: 'farm', event: '施肥', result: 'ok',
          type: useOrganic ? 'organic' : 'normal', count: totalCount
        });
        recordOperation('fertilize', totalCount);
      }
    }
  }

  return { normal: normalCount, organic: organicCount };
}

module.exports = {
  getFastMatureLands, getLandTypeByLevel, normalizeFertilizerLandTypes, filterLandIdsByTypes, fertilizeOrganicLoop,
  ALL_FERTILIZER_LAND_TYPES,
  FERTILIZER_LAND_TYPE_LABELS,
  runFertilizerByConfig
};
