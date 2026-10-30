const { log, logWarn, toNum } = require('../utils/utils');
const {
  isMysteryAutoBuyOn,
  getMysteryAutoBuyCurrencies
} = require('../models/store');
const { getActiveMysteryShop, buyMysteryShopGoods } = require('./mystery-shop');
const { runWithRequestClass } = require('../utils/request-context');

const MYSTERY_AUTO_BUY_INTERVAL_MS = 60 * 60 * 1000;
const MYSTERY_AUTO_BUY_MAX_PER_CYCLE = 20;

let mysteryAutoBuyTimer = null;
let generation = 0;
let checking = false;
let pendingController = null;

function startMysteryAutoBuyTimer() {
  pendingController?.abort(new Error('神秘商人自动购买已重新配置'));
  if (mysteryAutoBuyTimer) clearInterval(mysteryAutoBuyTimer);
  mysteryAutoBuyTimer = null;
  const currentGeneration = ++generation;
  if (!isMysteryAutoBuyOn()) return;

  // 启动时立即执行一次（单次查询+购买，不循环避免队列卡死）
  checkMysteryAutoBuyOnce(1, currentGeneration);

  mysteryAutoBuyTimer = setInterval(() => {
    checkMysteryAutoBuyOnce(MYSTERY_AUTO_BUY_MAX_PER_CYCLE, currentGeneration);
  }, MYSTERY_AUTO_BUY_INTERVAL_MS);

  log('神秘商人', `自动购买定时器已启动，间隔 ${MYSTERY_AUTO_BUY_INTERVAL_MS / 1000} 秒`, {
    module: 'mystery',
    event: 'auto_buy_timer',
    result: 'start'
  });
}

function stopMysteryAutoBuyTimer() {
  pendingController?.abort(new Error('神秘商人自动购买已停止'));
  generation++;
  if (mysteryAutoBuyTimer) {
    clearInterval(mysteryAutoBuyTimer);
    mysteryAutoBuyTimer = null;
  }
  log('神秘商人', '自动购买定时器已停止', {
    module: 'mystery',
    event: 'auto_buy_timer',
    result: 'stop'
  });
}

async function checkMysteryAutoBuyOnce(maxPurchases = MYSTERY_AUTO_BUY_MAX_PER_CYCLE, currentGeneration = generation) {
  if (checking || currentGeneration !== generation || !isMysteryAutoBuyOn()) return;
  const allowedCurrencies = getMysteryAutoBuyCurrencies();
  if (!Array.isArray(allowedCurrencies) || allowedCurrencies.length === 0) {
    logWarn('神秘商人', '自动购买已开启，但未勾选任何货币类型，跳过', {
      module: 'mystery', event: 'auto_buy', result: 'skip'
    });
    return;
  }
  let bought = 0;
  let lastNpcId = -1;
  checking = true;
  const controller = new AbortController();
  pendingController = controller;
  try {
    await runWithRequestClass('farm', async () => {
      for (let i = 0; i < maxPurchases; i++) {
        if (currentGeneration !== generation || !isMysteryAutoBuyOn()) break;
        const offer = await getActiveMysteryShop();
        if (currentGeneration !== generation || !isMysteryAutoBuyOn()) break;
        if (!offer || !offer.active) break;
        if (toNum(offer.npcId) === lastNpcId) break;
        const currentCurrencies = getMysteryAutoBuyCurrencies();
        if (!Array.isArray(currentCurrencies) || !currentCurrencies.includes(toNum(offer.currencyId))) break;
        await buyMysteryShopGoods(offer.npcId);
        bought++;
        lastNpcId = toNum(offer.npcId);
        log('神秘商人', `自动购买成功：${offer.itemName || ('物品' + offer.itemId)}（${offer.currencyName}）`, {
          module: 'mystery', event: 'auto_buy', result: 'ok',
          npcId: offer.npcId, itemId: offer.itemId, currencyId: offer.currencyId
        });
      }
      if (bought > 0) {
        log('神秘商人', `本次自动购买共完成 ${bought} 笔`, {
          module: 'mystery', event: 'auto_buy', result: 'done', bought
        });
      }
    }, { signal: controller.signal });
  } catch (err) {
    logWarn('神秘商人', `自动购买检测失败: ${err.message}`, {
      module: 'mystery', event: 'auto_buy', result: 'error', error: err.message
    });
  } finally {
    if (pendingController === controller) pendingController = null;
    checking = false;
  }
}

module.exports = {
  startMysteryAutoBuyTimer,
  stopMysteryAutoBuyTimer,
  checkMysteryAutoBuyOnce
};
