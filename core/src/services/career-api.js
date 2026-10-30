/**
 * 个人生涯统计服务
 *
 * 功能：
 * - 获取生涯统计（作物/花卉收获排行 + 玩家自身维度聚合）
 * - 使用当前 CareerInfoGetReply 协议解码
 * - 返回前用 gameConfig 把 fruit_id 翻译为名字/头像/等级/稀有度
 */
const { types } = require('../utils/proto');
const { sendMsgAsync } = require('../utils/network');
const gameConfig = require('../config/gameConfig');
const { createModuleLogger } = require('./logger');

const logger = createModuleLogger('career');

/**
 * 把 CareerStatItem 装饰成前端可用结构
 * 用 gameConfig 查 fruit_id → name/image/level/rarity
 */
function decorateStatItem(rawItem) {
  const fruitId = Number(rawItem.fruit_id || 0);
  const count = Number(rawItem.count || 0);
  let name = '';
  let image = '';
  let level = 0;
  let rarity = 0;
  const info = gameConfig.getItemById(fruitId);
  if (info) {
    name = String(info.name || '').trim();
    rarity = Number(info.rarity || 0);
    level = Number(info.level || 0);
  }
  if (!name) name = gameConfig.getFruitName(fruitId) || '';
  image = gameConfig.getItemImageById(fruitId) || '';
  return {
    id: fruitId,
    count,
    name: name || `物品 ${fruitId}`,
    image,
    level,
    rarity,
  };
}

/**
 * 把 CareerLevelStat 装饰成前端可用结构
 */
function decorateLevelStat(raw) {
  const fruitId = Number(raw.fruit_id || 0);
  const count = Number(raw.count || 0);
  const level = Number(raw.level || 0);
  let name = '';
  let image = '';
  const info = gameConfig.getItemById(fruitId);
  if (info) name = String(info.name || '').trim();
  if (!name) name = gameConfig.getFruitName(fruitId) || '';
  image = gameConfig.getItemImageById(fruitId) || '';
  return { id: fruitId, count, level, name: name || `物品 ${fruitId}`, image };
}

/**
 * 获取生涯统计（主入口）
 */
async function getCareerInfo() {
  const request = types.CareerInfoGetRequest.encode(
    types.CareerInfoGetRequest.create({})
  ).finish();

  try {
    const { body } = await sendMsgAsync(
      'gamepb.careerpb.CareerService',
      'CareerInfoGet',
      request,
      10000 // 缩短超时：避免卡满 20s 与前端 axios 超时撞车
    );

    logger.info('生涯统计API响应', { bodyLength: body ? body.length : 0 });

    const decoded = types.CareerInfoGetReply.decode(body);
    const reply = {
      items: (decoded.items || []).map(it => ({
        fruit_id: Number(it.fruit_id || 0),
        count: Number(it.count || 0),
      })),
      level_stats: (decoded.level_stats || []).map(it => ({
        fruit_id: Number(it.fruit_id || 0),
        count: Number(it.count || 0),
        level: Number(it.level || 0),
      })),
      name: decoded.name || '',
      avatar: decoded.avatar || '',
      level: Number(decoded.level || 0),
      exp: Number(decoded.exp || 0),
      gid: Number(decoded.gid || 0),
      openid: decoded.openid || '',
      achieved_levels: Number(decoded.achieved_levels || 0),
      stats_total: Number(decoded.stats_total || 0),
      stats_count: Number(decoded.stats_count || 0),
    };
    // 装饰 items（fruit_id → name/image/level/rarity）并按 count 倒序
    const decoratedItems = (reply.items || [])
      .map(decorateStatItem)
      .filter(it => it.id > 0 && it.count > 0)
      .sort((a, b) => b.count - a.count);

    const decoratedLevelStats = (reply.level_stats || [])
      .map(decorateLevelStat)
      .filter(it => it.id > 0);

    return {
      items: decoratedItems,
      level_stats: decoratedLevelStats,
      player: {
        gid: Number(reply.gid || 0),
        name: reply.name || '',
        avatar: reply.avatar || '',
        openid: reply.openid || '',
        level: Number(reply.level || 0),
        exp: Number(reply.exp || 0),
      },
      meta: {
        achieved_levels: Number(reply.achieved_levels || 0),
        stats_total: Number(reply.stats_total || 0),
        stats_count: Number(reply.stats_count || 0),
      },
      __raw: { bodyLength: body.length },
    };
  } catch (err) {
    logger.error('获取生涯统计失败', { error: err.message, stack: err.stack });
    throw err;
  }
}

module.exports = {
  getCareerInfo,
  decorateStatItem,
  decorateLevelStat,
};
