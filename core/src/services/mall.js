/**
 * 商城服务 - 化肥购买、免费礼包领取
 *
 * 功能：
 * - 获取商城商品列表
 * - 购买商品（含价格/限购解析）
 * - 自动购买有机/无机化肥（按余额自适应）
 * - 每日免费礼包领取
 * - 根据化肥容器剩余时间阈值自动补货
 */
const { sendMsgAsync, getUserState } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum, log, sleep } = require('../utils/utils');
const { getAmbientRequestSignal } = require('../utils/request-context');

// ---- 商品 ID 常量 ----

const ORGANIC_FERTILIZER_MALL_GOODS_ID = 1002;   // 有机化肥
const INORGANIC_FERTILIZER_MALL_GOODS_ID = 1003;  // 无机化肥

// 两次购买最小间隔：10分钟
const BUY_COOLDOWN_MS = 10 * 60 * 1000;

// 购买轮次：100轮（防止无限循环）
const MAX_ROUNDS = 100;

// 每轮购买数量：10个
const BUY_PER_ROUND = 10;

// 每日免费礼包 Key
const FREE_GIFTS_DAILY_KEY = 'mall_free_gifts';

// ---- 状态追踪 ----

let lastBuyAt = 0;
let buyDoneDateKey = '';
let buyLastSuccessAt = 0;
let buyPausedNoGoldDateKey = '';

let freeGiftDoneDateKey = '';
let freeGiftLastAt = 0;
let freeGiftLastCheckAt = 0;

// ---- 日期工具 ----

function getDateKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ---- RPC 调用 ----

let mallMutationTail = Promise.resolve();
function serializeMallPurchase(operation) {
  const result = mallMutationTail.then(operation);
  mallMutationTail = result.catch(() => {});
  return result;
}

function validatePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name}必须为正整数`);
}

function checkPurchaseCancellation() {
  getAmbientRequestSignal()?.throwIfAborted();
}

async function getMallListBySlotType(slotType = 1) {
  if (!Number.isInteger(slotType) || slotType < 0 || slotType > 2147483647) throw new Error('商城槽位无效');
  const request = types.GetMallListBySlotTypeRequest.encode(
    types.GetMallListBySlotTypeRequest.create({ slot_type: slotType })
  ).finish();
  const { body } = await sendMsgAsync('gamepb.mallpb.MallService', 'GetMallListBySlotType', request);
  return types.GetMallListBySlotTypeResponse.decode(body);
}

function purchaseMallGoods(goodsId, count = 1) {
  return serializeMallPurchase(() => performPurchaseMallGoods(goodsId, count));
}

async function performPurchaseMallGoods(goodsId, count) {
  validatePositiveInteger(goodsId, '商品 ID');
  validatePositiveInteger(count, '购买数量');
  checkPurchaseCancellation();
  const request = types.PurchaseRequest.encode(
    types.PurchaseRequest.create({ goods_id: goodsId, count })
  ).finish();
  const { body } = await sendMsgAsync('gamepb.mallpb.MallService', 'Purchase', request);
  const reply = types.PurchaseResponse.decode(body);
  if (reply.success !== true || toNum(reply.goods_id) !== goodsId) throw new Error('商城未确认购买成功');
  return reply;
}

async function getMallGoodsList(slotType = 1) {
  const reply = await getMallListBySlotType(slotType);
  return Array.isArray(reply.goods_list) ? reply.goods_list : [];
}

function parseMallPriceValue(price) {
  const count = toNum(price?.count);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('商城价格无效');
  return count;
}

function getMallUnitPrice(goods) {
  const price = parseMallPriceValue(goods?.price);
  if (goods?.is_free === true) return 0;
  const discounted = toNum(goods?.discount_price);
  if (goods?.is_discounted === true && discounted > 0) {
    validatePositiveInteger(discounted, '折扣价格');
    return discounted;
  }
  if (price <= 0) throw new Error('付费商品价格缺失');
  return price;
}

function parseMallLimitInfo(limit) {
  const limitCount = toNum(limit?.limit_count);
  const boughtNum = toNum(limit?.bought_count);
  if (!Number.isSafeInteger(limitCount) || limitCount < 0 || !Number.isSafeInteger(boughtNum) || boughtNum < 0)
    throw new Error('商城限购信息无效');
  return { limitCount, boughtNum };
}

function parseMallItemIds(items) {
  return Array.isArray(items) ? items.map(item => toNum(item.id)).filter(id => id > 0) : [];
}

// ---- 商品查找 ----

function findOrganicFertilizerMallGoods(goodsList) {
  const list = Array.isArray(goodsList) ? goodsList : [];
  return list.find((g) => toNum(g && g.goods_id) === ORGANIC_FERTILIZER_MALL_GOODS_ID) || null;
}

function findInorganicFertilizerMallGoods(goodsList) {
  const list = Array.isArray(goodsList) ? goodsList : [];
  return list.find((g) => toNum(g && g.goods_id) === INORGANIC_FERTILIZER_MALL_GOODS_ID) || null;
}

function findFertilizerMallGoods(goodsList, type = 'organic') {
  if (type === 'normal') return findInorganicFertilizerMallGoods(goodsList);
  return findOrganicFertilizerMallGoods(goodsList);
}

// ---- 自动购买 ----

/**
 * 通过商城自动购买指定类型化肥
 */
async function autoBuyFertilizerViaMall(type, targetCount) {
  const typeLabel = type === 'normal' ? '无机化肥' : '有机化肥';
  checkPurchaseCancellation();
  const goodsList = await getMallGoodsList(1);
  checkPurchaseCancellation();
  const goods = findFertilizerMallGoods(goodsList, type);
  if (!goods) throw new Error(`未找到${typeLabel}商品`);
  if (goods.is_available !== true) return 0;
  if (goods.ad_only === true || goods.share?.share_only === true) throw new Error('化肥商品需要专用领取流程');
  const goodsId = toNum(goods.goods_id);
  const price = getMallUnitPrice(goods);
  if (price > 0 && toNum(goods.price?.id) !== 1002) throw new Error('化肥商品的支付货币不是点券');
  const { limitCount, boughtNum } = parseMallLimitInfo(goods.purchase_limit);
  const stockLimit = limitCount > 0 ? Math.max(0, limitCount - boughtNum) : Infinity;
  const limit = Math.min(targetCount > 0 ? targetCount : MAX_ROUNDS * BUY_PER_ROUND, stockLimit);
  let budget = Math.max(0, toNum(getUserState()?.coupon));
  let totalBought = 0;
  for (let round = 0; round < MAX_ROUNDS && totalBought < limit; round++) {
    checkPurchaseCancellation();
    // 本轮预算只减已确认支出；服务端推送可进一步缩小预算，但不估算写回余额。
    budget = Math.min(budget, Math.max(0, toNum(getUserState()?.coupon)));
    const affordable = price > 0 ? Math.floor(budget / price) : BUY_PER_ROUND;
    const count = Math.min(BUY_PER_ROUND, limit - totalBought, affordable);
    if (count <= 0) {
      buyPausedNoGoldDateKey = getDateKey();
      log('商城', `${typeLabel}点券不足，单价 ${price}，当前点券 ${budget}`, {
        module: 'warehouse', event: '购买化肥', result: 'insufficient_coupon', type, price, coupon: budget,
      });
      break;
    }
    try {
      await performPurchaseMallGoods(goodsId, count);
    } catch (error) {
      log('商城', `购买${typeLabel}失败: ${error.message}`, {
        module: 'warehouse', event: '购买化肥', result: 'error', type, bought: totalBought, error: error.message,
      });
      throw error;
    }
    totalBought += count;
    budget -= price * count;
    if (totalBought < limit && (price === 0 || budget >= price)) await sleep(300);
  }
  if (totalBought > 0) {
    buyDoneDateKey = getDateKey();
    buyLastSuccessAt = Date.now();
    log('商城', `购买${typeLabel}成功，共购买 ${totalBought} 个`, {
      module: 'warehouse', event: '购买化肥', result: 'ok', count: totalBought, type,
    });
  }
  return totalBought;
}

function autoBuyOrganicFertilizer(force = false) {
  return autoBuyFertilizer(force, 'organic', 0);
}

function autoBuyFertilizer(force = false, type = 'organic', targetCount = 0) {
  return serializeMallPurchase(async () => {
    if (!['organic', 'normal'].includes(type)) throw new Error('化肥类型无效');
    if (!Number.isSafeInteger(targetCount) || targetCount < 0) throw new Error('化肥购买数量无效');
    checkPurchaseCancellation();
    const now = Date.now();
    if (!force && now - lastBuyAt < BUY_COOLDOWN_MS) return 0;
    lastBuyAt = now;
    return autoBuyFertilizerViaMall(type, targetCount);
  });
}

// ---- 免费礼包 ----

function isDoneTodayByKey(dateKey) {
  return String(dateKey || '') === getDateKey();
}

/**
 * 自动购买免费礼包
 */
async function buyFreeGifts(force = false) {
  const now = Date.now();

  if (!force && isDoneTodayByKey(freeGiftDoneDateKey)) return 0;
  if (!force && now - freeGiftLastCheckAt < BUY_COOLDOWN_MS) return 0;

  freeGiftLastCheckAt = now;

  try {
    // 抓包显示“每日福利”(goodsId=1001)位于 slot_type=1。
    // 旧实现请求 slot_type=2，导致自动任务无法找到免费商品。
    const goodsList = await getMallGoodsList(1);
    const freeGoods = goodsList.filter(g => g.is_free === true && g.is_available === true
      && !g.ad_only && !g.share?.share_only && toNum(g.goods_id) > 0
      && (toNum(g.purchase_limit?.limit_count) <= 0
        || toNum(g.purchase_limit?.bought_count) < toNum(g.purchase_limit.limit_count)));

    if (!freeGoods.length) {
      freeGiftDoneDateKey = getDateKey();
      log('商城', '今日暂无可领取免费礼包', {
        module: 'task', event: FREE_GIFTS_DAILY_KEY, result: 'none',
      });
      return 0;
    }

    let claimed = 0;
    const failures = [];
    for (const goods of freeGoods) {
      try {
        await purchaseMallGoods(Number(goods.goods_id || 0), 1);
        claimed += 1;
      } catch (error) {
        failures.push(error);
      }
    }

    if (claimed > 0) freeGiftLastAt = Date.now();
    if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('; '));
    freeGiftDoneDateKey = getDateKey();

    if (claimed > 0) {
      freeGiftLastAt = Date.now();
      log('商城', `自动购买免费礼包 x${claimed}`, {
        module: 'task', event: FREE_GIFTS_DAILY_KEY, result: 'ok', count: claimed,
      });
    } else {
      log('商城', '本次未成功领取免费礼包', {
        module: 'task', event: FREE_GIFTS_DAILY_KEY, result: 'none',
      });
    }

    return claimed;
  } catch (err) {
    log('商城', `领取免费礼包失败: ${err.message}`, {
      module: 'task', event: FREE_GIFTS_DAILY_KEY, result: 'error',
    });
    throw err;
  }
}

// ---- 按阈值补货 ----

function normalizeFertilizerCheckOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('化肥检测参数无效');
  const normalized = { buyOrganic: false, buyNormal: false, organicCount: 0, normalCount: 0,
    organicThresholdHours: 0, normalThresholdHours: 0, ...options };
  for (const [enabled, count, hours] of [
    ['buyOrganic', 'organicCount', 'organicThresholdHours'], ['buyNormal', 'normalCount', 'normalThresholdHours'],
  ]) {
    if (typeof normalized[enabled] !== 'boolean'
      || !Number.isSafeInteger(normalized[count]) || normalized[count] < 0
      || typeof normalized[hours] !== 'number' || !Number.isFinite(normalized[hours]) || normalized[hours] < 0
      || (normalized[enabled] && (normalized[count] <= 0 || normalized[hours] <= 0)))
      throw new Error('化肥检测开关、数量或阈值无效');
  }
  return normalized;
}

/**
 * 根据化肥容器剩余时间阈值自动补货
 */
async function checkAndBuyFertilizerByThreshold(type, count, thresholdHours) {
  const { getBag, getBagItems, getContainerHoursFromBagItems } = require('./warehouse');

  if (!['organic', 'normal'].includes(type) || !Number.isSafeInteger(count) || count <= 0
    || typeof thresholdHours !== 'number' || !Number.isFinite(thresholdHours) || thresholdHours <= 0)
    throw new Error('化肥类型、数量或阈值无效');

  try {
    const bag = await getBag();
    const items = getBagItems(bag);
    const hours = getContainerHoursFromBagItems(items);
    const currentHours = type === 'normal' ? hours.normal : hours.organic;
    const label = type === 'normal' ? '无机化肥' : '有机化肥';

    log('商城', `检测${label}容器: 剩余 ${currentHours.toFixed(1)} 小时，阈值 ${thresholdHours} 小时`, {
      module: 'mall', event: 'check_fertilizer', type, currentHours, thresholdHours,
    });

    if (currentHours < thresholdHours) {
      const bought = await autoBuyFertilizer(true, type, count);
      return { bought, currentHours, thresholdHours, needed: true };
    }

    return { bought: 0, currentHours, thresholdHours, needed: false };
  } catch (err) {
    log('商城', `检测化肥容器失败: ${err.message}`, {
      module: 'mall', event: 'check_fertilizer', result: 'error', error: err.message,
    });
    throw err;
  }
}

/**
 * 同时检查并补充两种化肥
 */
async function checkAndBuyFertilizerBoth(options = {}) {
  const { getBag, getBagItems, getContainerHoursFromBagItems } = require('./warehouse');

  const {
    buyOrganic = false,
    buyNormal = false,
    organicCount = 0,
    organicThresholdHours = 0,
    normalCount = 0,
    normalThresholdHours = 0,
  } = normalizeFertilizerCheckOptions(options);

  const result = { organicBought: 0, normalBought: 0, organicCurrentHours: 0, normalCurrentHours: 0 };

  if (!buyOrganic && !buyNormal) return result;

  try {
    const bag = await getBag();
    const items = getBagItems(bag);
    const hours = getContainerHoursFromBagItems(items);

    result.organicCurrentHours = hours.organic;
    result.normalCurrentHours = hours.normal;

    // 有机化肥
    if (buyOrganic && organicCount > 0 && organicThresholdHours > 0) {
      log('商城', `检测有机化肥容器: 剩余 ${hours.organic.toFixed(1)} 小时，阈值 ${organicThresholdHours} 小时`, {
        module: 'mall', event: 'check_fertilizer_organic', currentHours: hours.organic, thresholdHours: organicThresholdHours,
      });

      if (hours.organic < organicThresholdHours) {
        result.organicBought = await autoBuyFertilizer(true, 'organic', organicCount);
      }
    }

    // 两次购买之间随机间隔 1~3 秒
    if (buyOrganic && buyNormal && result.organicBought > 0) {
      const delay = 1000 + Math.random() * 2000;
      await sleep(delay);
    }

    // 无机化肥
    if (buyNormal && normalCount > 0 && normalThresholdHours > 0) {
      log('商城', `检测无机化肥容器: 剩余 ${hours.normal.toFixed(1)} 小时，阈值 ${normalThresholdHours} 小时`, {
        module: 'mall', event: 'check_fertilizer_normal', currentHours: hours.normal, thresholdHours: normalThresholdHours,
      });

      if (hours.normal < normalThresholdHours) {
        result.normalBought = await autoBuyFertilizer(true, 'normal', normalCount);
      }
    }

    return result;
  } catch (err) {
    log('商城', `检测化肥容器失败: ${err.message}`, {
      module: 'mall', event: 'check_fertilizer', result: 'error', error: err.message,
    });
    throw err;
  }
}

// ---- 导出 ----

module.exports = {
  autoBuyOrganicFertilizer,
  autoBuyFertilizer,
  checkAndBuyFertilizerByThreshold,
  checkAndBuyFertilizerBoth,
  buyFreeGifts,
  getMallGoodsList,
  purchaseMallGoods,
  parseMallPriceValue,
  getMallUnitPrice,
  parseMallLimitInfo,
  parseMallItemIds,
  normalizeFertilizerCheckOptions,

  getFertilizerBuyDailyState: () => ({
    key: 'fertilizer_buy',
    doneToday: buyDoneDateKey === getDateKey(),
    pausedNoGoldToday: buyPausedNoGoldDateKey === getDateKey(),
    lastSuccessAt: buyLastSuccessAt,
  }),

  getFreeGiftDailyState: () => ({
    key: FREE_GIFTS_DAILY_KEY,
    doneToday: freeGiftDoneDateKey === getDateKey(),
    lastCheckAt: freeGiftLastCheckAt,
    lastClaimAt: freeGiftLastAt,
  }),
};
