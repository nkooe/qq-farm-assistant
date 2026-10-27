// Adapted from liyangpengs/qq-farm-bot (ISC), e5f3552; see docs/activity-features.md.
const levels = require('../modern/activity-data/LandLevel.json');
const needs = require('../modern/activity-data/LandLevelNeed.json');
const { getItemById, getItemImageById } = require('../config/gameConfig');
const number = value => Number(value?.toString?.() ?? value) || 0;

function levelInfo(level, buff) {
  const config = levels.find(entry => entry.id === level);
  if (!config) return null;
  return {
    level, name: config.level_name, image: `/land-assets/${level}.png`,
    yieldBonus: number(buff?.plant_yield_bonus ?? config.plant_yield_bonus) / 100,
    growthReduction: number(buff?.planting_time_reduction ?? config.planting_time_reduction) / 100,
    expBonus: number(buff?.plant_exp_bonus ?? config.plant_exp_bonus) / 100,
    mutantMultiplier: number(config.plant_mutant_bonus) / 10000,
    resonanceBonus: number(config.plant_mutant_exp_bonus) / 100,
  };
}

function costs(items) {
  return items.filter(item => String(item.count) !== '0').map(item => ({
    id: String(item.id), count: /^\d+$/.test(String(item.count)) && number(item.id) > 0 ? String(item.count) : null,
    name: getItemById(number(item.id))?.name || `物品 ${item.id}`,
    image: getItemImageById(number(item.id)) || '',
  }));
}

function buildLandUpgradeDetail(land, landsMap = new Map()) {
  const id = number(land?.id);
  const level = number(land?.level);
  const current = land?.unlocked ? levelInfo(level, land.buff) : null;
  if (!land?.unlocked) {
    const condition = land?.unlock_condition;
    const precedingId = number(condition?.preceding_land_id);
    return {
      mode: 'unlock', current, next: levelInfo(1), serverAllowed: !!land?.could_unlock,
      needLevel: condition ? number(condition.need_level) : null,
      prerequisite: precedingId ? { landId: precedingId, met: !!landsMap.get(precedingId)?.unlocked } : null,
      costs: condition ? costs([{ id: 1001, count: condition.need_gold ?? 0 }]) : [], unknown: !condition,
    };
  }
  if (number(land.max_level) > 0 && level >= number(land.max_level))
    return { mode: 'max', current, next: null, costs: [], unknown: !current };
  const next = levelInfo(level + 1);
  const condition = land.upgrade_condition;
  const config = needs.find(entry => entry.land_id === id && entry.level === level + 1);
  const configItems = String(config?.items_need || '').split(';').filter(Boolean).map(part => {
    const [itemId, count] = part.split(':');
    return { id: itemId, count };
  });
  const conditionType = number(condition?.condition_type);
  return {
    mode: 'upgrade', current, next, serverAllowed: !!land.could_upgrade,
    needLevel: condition ? (conditionType === 1 ? number(condition.condition_value) : null) : (config?.level_need ?? null),
    prerequisite: null, costs: costs(condition ? (condition.required_items || []) : configItems),
    unknown: !next || (condition ? conditionType !== 1 : !config),
  };
}

module.exports = { buildLandUpgradeDetail };
