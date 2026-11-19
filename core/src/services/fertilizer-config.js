function fertilizerConfigKey(automation = {}) {
  return JSON.stringify([
    automation.farm, automation.fertilizer, automation.fertilizer_smart_seconds,
    automation.fertilizer_multi_season,
    [...(automation.fertilizer_land_types || [])].sort(),
  ]);
}

function createFertilizerConfigGuard(automation, canContinue = () => true, store = require('../models/store')) {
  const revision = store.getFertilizerConfigRevision();
  const key = fertilizerConfigKey(automation);
  return () => canContinue() && revision === store.getFertilizerConfigRevision()
    && key === fertilizerConfigKey(store.getAutomation());
}

module.exports = { fertilizerConfigKey, createFertilizerConfigGuard };
