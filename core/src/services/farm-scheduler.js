/**
 * 农场调度辅助模块
 * 负责化肥自动购买检测定时器
 */
const { log, logWarn } = require('../utils/utils');
const {
  isAutomationOn,
  getFertilizerBuyOrganicCount,
  getFertilizerBuyOrganicThresholdHours,
  getFertilizerBuyNormalCount,
  getFertilizerBuyNormalThresholdHours,
  getFertilizerBuyCheckIntervalMinutes
} = require('../models/store');
const { checkAndBuyFertilizerBoth } = require('./mall');
const { createScheduler } = require('./scheduler');
const { runWithRequestClass } = require('../utils/request-context');

const scheduler = createScheduler('farm_fertilizer_buy');
let timerSignature = '';
let checking = false;
let pendingController = null;

function currentSignature() {
  return JSON.stringify([isAutomationOn('fertilizer_buy_organic'), isAutomationOn('fertilizer_buy_normal'),
    getFertilizerBuyCheckIntervalMinutes(), getFertilizerBuyOrganicCount(), getFertilizerBuyOrganicThresholdHours(),
    getFertilizerBuyNormalCount(), getFertilizerBuyNormalThresholdHours()]);
}

/** 启动化肥自动购买检测定时器 */
function startFertilizerBuyCheckTimer() {
  pendingController?.abort(new Error('化肥自动购买配置已更新'));
  scheduler.clearAll();
  timerSignature = currentSignature();

  if (!isAutomationOn('fertilizer_buy_organic') && !isAutomationOn('fertilizer_buy_normal')) return;

  const intervalMinutes = getFertilizerBuyCheckIntervalMinutes();
  const intervalMs = intervalMinutes * 60 * 1000;

  scheduler.setIntervalTask('check', intervalMs, checkFertilizerBuyOnce);

  log('农场', `化肥自动购买检测定时器已启动，间隔 ${intervalMinutes} 分钟`, {
    module: 'farm',
    event: '购买化肥计时器',
    result: 'start',
    intervalMinutes
  });
}

/** 停止化肥自动购买检测定时器 */
function stopFertilizerBuyCheckTimer() {
  pendingController?.abort(new Error('化肥自动购买已停止'));
  scheduler.clearAll();
  timerSignature = '';
  log('农场', '化肥自动购买检测定时器已停止', {
    module: 'farm',
    event: '购买化肥计时器',
    result: 'stop'
  });
}

function refreshFertilizerBuyCheckTimer() {
  if (currentSignature() !== timerSignature) startFertilizerBuyCheckTimer();
}

/** 执行一次化肥购买检测 */
async function checkFertilizerBuyOnce() {
  if (checking) return;
  if (!isAutomationOn('fertilizer_buy_organic') && !isAutomationOn('fertilizer_buy_normal')) return;

  checking = true;
  const controller = new AbortController();
  pendingController = controller;
  try {
    const config = {
      buyOrganic: isAutomationOn('fertilizer_buy_organic'),
      buyNormal: isAutomationOn('fertilizer_buy_normal'),
      organicCount: getFertilizerBuyOrganicCount(),
      organicThresholdHours: getFertilizerBuyOrganicThresholdHours(),
      normalCount: getFertilizerBuyNormalCount(),
      normalThresholdHours: getFertilizerBuyNormalThresholdHours()
    };
    await runWithRequestClass('farm', () => checkAndBuyFertilizerBoth(config), { signal: controller.signal });
  } catch (err) {
    logWarn('农场', `化肥自动购买检测失败: ${err.message}`, {
      module: 'farm',
      event: 'fertilizer_auto_buy',
      result: 'error',
      error: err.message
    });
  } finally {
    if (pendingController === controller) pendingController = null;
    checking = false;
  }
}

module.exports = {
  startFertilizerBuyCheckTimer,
  stopFertilizerBuyCheckTimer,
  refreshFertilizerBuyCheckTimer
};
