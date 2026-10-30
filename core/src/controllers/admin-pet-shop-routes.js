const { getItemById, getSeedImageBySeedId } = require("../config/gameConfig");
const { toNum } = require("../utils/utils");

// 宠物商店的商店 ID（协议里固定为 3）
const PET_SHOP_ID = 3;

const PET_ITEM_ORDER = {
  90011: 1,
  90002: 2,
  90003: 3,
};

function getAuthorizedAccountId({
  req,
  res,
  getAccountIdFromRequest,
  canAccessAccount,
}) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    res.status(400).json({ ok: false, error: "Missing\x20x-account-id" });
    return null;
  }
  if (!canAccessAccount(req, accountId)) {
    res.status(403).json({ ok: false, error: "无权访问此账号" });
    return null;
  }
  return accountId;
}

function extractRequiredLevel(goods) {
  let requiredLevel = 0;
  for (const condition of goods.conds || []) {
    if (toNum(condition.type) === 1)
      requiredLevel = toNum(condition.param) || 0;
  }
  return requiredLevel;
}

/**
 * 从游戏服务器原始商品构建宠物条目。
 * 不再依赖 PET_ITEM_IDS 白名单过滤 —— 服务器返回什么宠物就展示什么。
 */
function buildPetItemFromGoods(goods, { userLevel, userGold, userGoldBean }) {
  const itemId = toNum(goods && goods.item_id) || 0;
  if (itemId <= 0) return null;

  const itemConfig = getItemById(itemId);
  const price = toNum(goods && goods.price) || 0;
  const limitCount = toNum(goods && goods.limit_count) || 0;
  const boughtNum = toNum(goods && goods.bought_num) || 0;
  const isSoldOut = limitCount > 0 && boughtNum >= limitCount;
  const unlocked = !!goods.unlocked;
  const requiredLevel = extractRequiredLevel(goods);

  // 金豆豆购买判定：沿用旧逻辑（柯基用金豆豆），其余用金币。
  // 新宠物如使用其它货币，可在此按 itemId 扩展。
  const isGoldenBean = itemId === 90011;

  return {
    id: toNum(goods && goods.id) || 0,
    itemId,
    itemCount: toNum(goods && goods.item_count) || 1,
    price,
    limitCount,
    boughtNum,
    unlocked,
    requiredLevel,
    name: (itemConfig && itemConfig.name) || `宠物${itemId}`,
    image: getSeedImageBySeedId(itemId),
    desc: (itemConfig && itemConfig.desc) || "",
    isGoldenBean,
    canBuy:
      unlocked &&
      userLevel >= requiredLevel &&
      !isSoldOut &&
      (isGoldenBean ? userGoldBean >= price : userGold >= price),
    isSoldOut,
  };
}

function registerAdminPetShopRoutes({
  app,
  provider,
  adminLogger,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
}) {
  app.get("/api/shop/pet", async (req, res) => {
    const accountId = getAuthorizedAccountId({
      req,
      res,
      getAccountIdFromRequest,
      canAccessAccount,
    });
    if (!accountId) return;

    try {
      const status = provider.getStatus(accountId);
      const userLevel = status?.status?.level || 0;
      const userGold = status?.status?.gold || 0;
      const userGoldBean = status?.status?.goldBean || 0;

      const shopReply = await provider.getShopInfo(accountId, PET_SHOP_ID);
      if (!Array.isArray(shopReply?.goods_list)) throw new Error('宠物商店响应格式无效');
      const goods = shopReply.goods_list.map(g => buildPetItemFromGoods(g, { userLevel, userGold, userGoldBean })).filter(Boolean);

      goods.sort(
        (left, right) =>
          (PET_ITEM_ORDER[left.itemId] || 99) -
          (PET_ITEM_ORDER[right.itemId] || 99),
      );

      res.json({
        ok: true,
        data: goods,
        userGold,
        userGoldBean,
      });
    } catch (error) {
      adminLogger.error("获取宠物商店失败", {
        error: error.message,
        stack: error.stack,
      });
      sendProviderError(res, error);
    }
  });
}

module.exports = { registerAdminPetShopRoutes };
