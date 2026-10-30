// Adapted from qq-farm-bot-master (ISC); see docs/activity-features.md.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 仓库系统 - 自动出售果实
 * 协议说明：BagReply 使用 item_bag（ItemBag），item_bag.items 才是背包物品列表
 */
const { getFruitName, getPlantByFruitId, getPlantBySeedId, getItemById, getItemImageById, getSeedImageBySeedId, getEffectiveSellInfo, getMutantEffectsByIds } = require('../config/gameConfig');
const { isAutomationOn } = require('../models/store');
const { sendMsgAsync, networkEvents, getUserState } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, toTimeSec, log, logWarn, sleep, getSystemDateKey } = require('../utils/utils');
const { getSellConditionContext } = require('./activity-windows');
const SELL_BATCH_SIZE = 15;
const LOCKABLE_ITEM_TYPES = new Set([17, 6, 5]);
const FERTILIZER_RELATED_IDS = new Set([
    100003, // 化肥礼包
    100004, // 有机化肥礼包
    80001, 80002, 80003, 80004, // 普通化肥道具
    80011, 80012, 80013, 80014, // 有机化肥道具
]);
const FERTILIZER_CONTAINER_LIMIT_HOURS = 990;
const NORMAL_CONTAINER_ID = 1011;
const ORGANIC_CONTAINER_ID = 1012;
const CHARITY_SETTLEMENT_GIFT_ID = 101604;
const SPECIAL_GIFT_CHECK_COOLDOWN_MS = 5 * 60 * 1000;
const NORMAL_FERTILIZER_ITEM_HOURS = new Map([
    [80001, 1], [80002, 4], [80003, 8], [80004, 12],
]);
const ORGANIC_FERTILIZER_ITEM_HOURS = new Map([
    [80011, 1], [80012, 4], [80013, 8], [80014, 12],
]);
let fertilizerGiftDoneDateKey = '';
let fertilizerGiftLastOpenAt = 0;
let charitySettlementGiftLastOpenAt = 0;
let pendingBagRequest = null;
// ============ API ============
async function getBag({ fresh = false } = {}) {
    if (!fresh && pendingBagRequest)
        return pendingBagRequest;
    const request = (async () => {
        const body = types.BagRequest.encode(types.BagRequest.create({})).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'Bag', body);
        return types.BagReply.decode(replyBody);
    })();
    pendingBagRequest = request;
    try {
        return await request;
    }
    finally {
        if (pendingBagRequest === request)
            pendingBagRequest = null;
    }
}
function toSellItem(item) {
    const idNum = toNum(item && item.id);
    const countNum = toNum(item && item.count);
    const uidNum = toNum(item && item.uid);
    const payload = {
        id: toLong(idNum),
        count: toLong(countNum),
    };
    // SellRequest 通常只需要 id + count；仅在 uid 有效时携带
    if (uidNum > 0)
        payload.uid = toLong(uidNum);
    return payload;
}
let inventoryMutationTail = Promise.resolve();
function serializeInventory(operation) {
    const result = inventoryMutationTail.then(operation);
    inventoryMutationTail = result.catch(() => {});
    return result;
}
function sellItems(items) { return serializeInventory(() => performSellItems(items)); }
async function performSellItems(items) {
    const requested = Array.isArray(items) ? items : [];
    if (requested.length === 0)
        throw new Error('没有可出售的物品');
    const baseContext = await getSellConditionContext();
    const bagItems = getBagItems(await getBag({ fresh: true }));
    const seenUids = new Set();
    for (const item of requested) {
        const id = toNum(item && item.id);
        const count = toNum(item && item.count);
        if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(count) || count <= 0)
            throw new Error('出售物品参数无效');
        if (toNum(item?.uid) <= 0 && bagItems.filter(v => toNum(v.id) === id).length > 1)
            throw new Error('同名物品存在多堆，请指定 UID 后出售');
        const info = getItemById(id);
        const bagItem = findBagItem(bagItems, item);
        if (!bagItem)
            throw new Error(`背包中未找到${info?.name || `物品${id}`}`);
        const uid = toNum(bagItem.uid);
        if (seenUids.has(uid)) throw new Error('同名物品堆不可重复出售');
        seenUids.add(uid);
        if (isItemLocked(bagItem))
            throw new Error(`${info?.name || `物品${id}`}已锁定，不能出售`);
        if (count > toNum(bagItem.count)) throw new Error('出售数量超过当前库存');
        const expireTime = getItemExpireTime(bagItem);
        const sellInfo = getEffectiveSellInfo(info, { ...baseContext, expireTime });
        if (!sellInfo.sellable) {
            throw new Error(`${info?.name || `物品${id}`}当前不可出售`);
        }
    }
    const payload = requested.map(toSellItem);
    const body = types.SellRequest.encode(types.SellRequest.create({ items: payload })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'Sell', body);
    return types.SellReply.decode(replyBody);
}
function validateUseEntry(itemId, count, uid) {
    if (!Number.isSafeInteger(itemId) || itemId <= 0
        || !Number.isSafeInteger(count) || count <= 0
        || !Number.isSafeInteger(uid) || uid < 0)
        throw new Error('使用物品参数无效');
}
function allocateUseItems(bagItems, requested) {
    const remainingByStack = new Map();
    const allocated = new Map();
    for (const entry of requested) {
        const { itemId, count, uid = 0 } = entry || {};
        validateUseEntry(itemId, count, uid);
        let remaining = count;
        let lockedCount = 0;
        for (const item of bagItems) {
            if (toNum(item.id) !== itemId || (uid > 0 && toNum(item.uid) !== uid)) continue;
            if (isItemLocked(item)) { lockedCount += Math.max(0, toNum(item.count)); continue; }
            const available = remainingByStack.has(item) ? remainingByStack.get(item) : Math.max(0, toNum(item.count));
            const useCount = Math.min(remaining, available);
            if (useCount <= 0) continue;
            remainingByStack.set(item, available - useCount);
            const current = allocated.get(item);
            if (current) current.count += useCount;
            else allocated.set(item, { itemId, count: useCount, uid: toNum(item.uid) });
            remaining -= useCount;
            if (remaining === 0) break;
        }
        if (remaining > 0) {
            const suffix = lockedCount > 0 ? `，另有 ${lockedCount} 个已锁定` : '';
            throw new Error(`物品可用数量不足: 需要 ${count}，当前 ${count - remaining}${suffix}`);
        }
    }
    return Array.from(allocated.values());
}
function useItem(itemId, count = 1, landIds = [], uid = 0) {
    return serializeInventory(() => performUseItem(itemId, count, landIds, uid));
}
async function performUseItem(itemId, count, landIds, uid) {
    validateUseEntry(itemId, count, uid);
    if (!Array.isArray(landIds) || landIds.length > 0)
        throw new Error('新版物品使用协议不再接受 landIds');
    const items = allocateUseItems(getBagItems(await getBag({ fresh: true })), [{ itemId, count, uid }]);
    if (items.length > 1) return sendBatchUseItems(items);
    const item = items[0];
    const body = types.UseRequest.encode(types.UseRequest.create({
        item: {
            id: toLong(itemId),
            count: toLong(count),
            uid: toLong(item.uid),
        },
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'Use', body);
    return types.UseReply.decode(replyBody);
}
function batchUseItems(items) {
    return serializeInventory(() => performBatchUseItems(items));
}
async function performBatchUseItems(items) {
    if (!Array.isArray(items) || items.length === 0) throw new Error('没有可使用的物品');
    for (const item of items) validateUseEntry(item?.itemId, item?.count, item?.uid ?? 0);
    const allocated = allocateUseItems(getBagItems(await getBag({ fresh: true })), items);
    return sendBatchUseItems(allocated);
}
async function sendBatchUseItems(items) {
    const payload = items.map((it) => ({
        id: toLong(it.itemId),
        count: toLong(it.count),
        uid: toLong(it.uid),
    }));
    const body = types.BatchUseRequest.encode(types.BatchUseRequest.create({ items: payload })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'BatchUse', body);
    return types.BatchUseReply.decode(replyBody);
}
function isFruitItemId(id) {
    return !!getPlantByFruitId(Number(id));
}
function getBagItems(bagReply) {
    if (bagReply && bagReply.item_bag && bagReply.item_bag.items && bagReply.item_bag.items.length) {
        return bagReply.item_bag.items;
    }
    return bagReply && bagReply.items ? bagReply.items : [];
}
function isItemLocked(item) {
    return item?.locked === true || item?.locked === 1 || item?.locked === '1';
}
function isLockableItem(item) {
    const id = toNum(item?.id);
    const info = id > 0 ? getItemById(id) : null;
    return LOCKABLE_ITEM_TYPES.has(Number(info?.type || 0));
}
function normalizeItemUids(values) {
    return [...new Set((Array.isArray(values) ? values : [])
            .map((value) => toNum(value))
            .filter((value) => Number.isSafeInteger(value) && value > 0))];
}
function setItemsLocked(itemUids, locked) { return serializeInventory(() => performSetItemsLocked(itemUids, locked)); }
async function performSetItemsLocked(itemUids, locked) {
    if (typeof locked !== 'boolean') throw new Error('锁定状态无效');
    const requestedUids = normalizeItemUids(itemUids);
    if (requestedUids.length === 0)
        throw new Error('缺少物品 UID');
    const bagItems = getBagItems(await getBag({ fresh: true }));
    const byUid = new Map(bagItems
        .filter((item) => toNum(item?.uid) > 0)
        .map((item) => [toNum(item.uid), item]));
    const actionableUids = [];
    for (const uid of requestedUids) {
        const item = byUid.get(uid);
        if (!item)
            throw new Error(`背包中未找到 UID ${uid}`);
        const info = getItemById(toNum(item.id));
        if (!isLockableItem(item)) {
            throw new Error(`${info?.name || `物品${toNum(item.id)}`}不支持锁定`);
        }
        if (isItemLocked(item) !== locked)
            actionableUids.push(uid);
    }
    if (actionableUids.length === 0) {
        return { locked, changed: 0, itemUids: [] };
    }
    const RequestType = locked ? types.LockItemsRequest : types.UnlockItemsRequest;
    const ReplyType = locked ? types.LockItemsReply : types.UnlockItemsReply;
    const method = locked ? 'LockItems' : 'UnlockItems';
    const body = RequestType.encode(RequestType.create({
        item_uids: actionableUids.map((uid) => toLong(uid)),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', method, body);
    const reply = ReplyType.decode(replyBody);
    const confirmedUids = normalizeItemUids(reply?.item_uids);
    return {
        locked,
        changed: confirmedUids.length || actionableUids.length,
        itemUids: confirmedUids.length > 0 ? confirmedUids : actionableUids,
    };
}
function getItemExpireTime(item) {
    if (!item)
        return 0;
    return toTimeSec(item.expire_time ?? item.expireTime);
}
function getItemSourceInfo(item) {
    const source = item?.source_info ?? item?.sourceInfo;
    if (!source || typeof source !== 'object')
        return null;
    const senderName = String(source.sender_name ?? source.senderName ?? '').trim();
    const sentAt = toTimeSec(source.sent_at ?? source.sentAt);
    // Qixi GiftQixiSachetRequest calls this value msg_text_id. The Bag reply
    // carries the same selector as ItemSourceInfo field 3.
    const messageTextId = toNum(source.source_type ?? source.sourceType);
    if (!senderName && sentAt <= 0 && messageTextId <= 0)
        return null;
    return { senderName, sentAt, messageTextId };
}
function getProtocolSellPrice(item) {
    const show = item?.show;
    const sellPrice = show?.sell_price ?? show?.sellPrice;
    const currencyId = toNum(sellPrice?.id);
    const price = toNum(sellPrice?.count);
    return currencyId > 0 && price > 0 ? { currencyId, price } : null;
}
function findBagItem(items, requested) {
    const id = toNum(requested?.id);
    const uid = toNum(requested?.uid);
    return (items || []).find((item) => (toNum(item?.id) === id && (uid <= 0 || toNum(item?.uid) === uid))) || null;
}
function getMutantTypes(item) {
    const values = Array.isArray(item?.mutant_types)
        ? item.mutant_types
        : (Array.isArray(item?.mutantTypes) ? item.mutantTypes : []);
    return values
        .map((value) => toNum(value))
        .filter((value) => value > 0)
        .sort((left, right) => left - right);
}
function isFertilizerRelatedItemId(itemId) {
    const id = Number(itemId) || 0;
    if (id <= 0)
        return false;
    // 禁止对容器道具执行使用，避免触发 1011/1012 补充逻辑
    if (id === 1011 || id === 1012)
        return false;
    if (FERTILIZER_RELATED_IDS.has(id))
        return true;
    const info = getItemById(id);
    if (!info || typeof info !== 'object')
        return false;
    const interactionType = String(info.interaction_type || '').toLowerCase();
    return interactionType === 'fertilizer' || interactionType === 'fertilizerpro';
}
function collectFertilizerUsePayload(items) {
    const merged = new Map();
    for (const it of (items || [])) {
        const id = toNum(it && it.id);
        const count = Math.max(0, toNum(it && it.count));
        if (isItemLocked(it))
            continue;
        if (id <= 0 || count <= 0)
            continue;
        if (!isFertilizerRelatedItemId(id))
            continue;
        merged.set(id, (merged.get(id) || 0) + count);
    }
    return Array.from(merged.entries()).map(([id, count]) => ({ id, count }));
}
function getContainerHoursFromBagItems(items) {
    let normalSec = 0;
    let organicSec = 0;
    for (const it of (items || [])) {
        const id = toNum(it && it.id);
        const count = Math.max(0, toNum(it && it.count));
        if (id === NORMAL_CONTAINER_ID)
            normalSec = count;
        if (id === ORGANIC_CONTAINER_ID)
            organicSec = count;
    }
    return {
        normal: normalSec / 3600,
        organic: organicSec / 3600,
    };
}
function getFertilizerItemTypeAndHours(itemId) {
    const id = Number(itemId) || 0;
    if (NORMAL_FERTILIZER_ITEM_HOURS.has(id)) {
        return { type: 'normal', perItemHours: NORMAL_FERTILIZER_ITEM_HOURS.get(id) };
    }
    if (ORGANIC_FERTILIZER_ITEM_HOURS.has(id)) {
        return { type: 'organic', perItemHours: ORGANIC_FERTILIZER_ITEM_HOURS.get(id) };
    }
    const info = getItemById(id) || {};
    const interactionType = String(info.interaction_type || '').toLowerCase();
    if (interactionType === 'fertilizer')
        return { type: 'normal', perItemHours: 1 };
    if (interactionType === 'fertilizerpro')
        return { type: 'organic', perItemHours: 1 };
    return { type: 'other', perItemHours: 0 };
}
function isFertilizerContainerFullError(err) {
    const msg = String((err && err.message) || '');
    return msg.includes('code=1003002')
        || msg.includes('普通化肥容器已达到上限')
        || msg.includes('普通化肥容器已满')
        || msg.includes('有机化肥容器已达到上限')
        || msg.includes('有机化肥容器已满');
}
async function autoOpenFertilizerGiftPacks() {
    try {
        const bagReply = await getBag();
        const bagItems = getBagItems(bagReply);
        const payloads = collectFertilizerUsePayload(bagItems);
        if (payloads.length <= 0) {
            return 0;
        }
        const containerHours = getContainerHoursFromBagItems(bagItems);
        let opened = 0;
        const details = [];
        // 按条目 BatchUse，避免数量大时逐个 Use 造成请求风暴
        for (const row of payloads) {
            const itemId = Number(row.id) || 0;
            const rawCount = Math.max(1, Number(row.count) || 0);
            const { type, perItemHours } = getFertilizerItemTypeAndHours(itemId);
            let useCount = rawCount;
            // 容器达到 990h 后不再使用对应化肥道具；未达到时也按剩余可用小时裁剪数量
            if (type === 'normal' || type === 'organic') {
                const currentHours = type === 'normal' ? containerHours.normal : containerHours.organic;
                if (currentHours >= FERTILIZER_CONTAINER_LIMIT_HOURS) {
                    continue;
                }
                if (perItemHours > 0) {
                    const remainHours = Math.max(0, FERTILIZER_CONTAINER_LIMIT_HOURS - currentHours);
                    const maxCountByHours = Math.floor(remainHours / perItemHours);
                    useCount = Math.max(0, Math.min(rawCount, maxCountByHours));
                    if (useCount <= 0)
                        continue;
                }
            }
            const itemInfo = getItemById(itemId);
            const itemName = itemInfo && itemInfo.name ? String(itemInfo.name) : `物品#${itemId}`;
            let used = 0;
            try {
                await batchUseItems([{ itemId, count: useCount, uid: 0 }]);
                used = useCount;
            }
            catch {
                // BatchUse 失败时直接跳过该条目
                used = 0;
            }
            if (used > 0) {
                opened += used;
                details.push(`${itemName}x${used}`);
                if (type === 'normal' && perItemHours > 0)
                    containerHours.normal += used * perItemHours;
                if (type === 'organic' && perItemHours > 0)
                    containerHours.organic += used * perItemHours;
            }
            await sleep(100);
        }
        if (opened > 0) {
            fertilizerGiftDoneDateKey = getSystemDateKey();
            fertilizerGiftLastOpenAt = Date.now();
            log('仓库', `自动使用化肥类道具 x${opened}${details.length ? ` [${details.join('，')}]` : ''}`, {
                module: 'warehouse',
                event: '开启化肥礼包',
                result: 'ok',
                count: opened,
            });
        }
        return opened;
    }
    catch (e) {
        if (isFertilizerContainerFullError(e)) {
            return 0;
        }
        logWarn('仓库', `开启化肥礼包失败: ${e.message}`, {
            module: 'warehouse',
            event: '开启化肥礼包',
            result: 'error',
        });
        return 0;
    }
}
async function openFertilizerGiftPacksSilently() {
    return autoOpenFertilizerGiftPacks();
}
async function openCharitySettlementGiftPacksSilently() {
    const now = Date.now();
    if (now - charitySettlementGiftLastOpenAt < SPECIAL_GIFT_CHECK_COOLDOWN_MS)
        return 0;
    charitySettlementGiftLastOpenAt = now;
    try {
        const bagReply = await getBag();
        const giftItems = getBagItems(bagReply).filter((item) => (toNum(item?.id) === CHARITY_SETTLEMENT_GIFT_ID
            && !isItemLocked(item)
            && toNum(item?.count) > 0));
        if (giftItems.length === 0)
            return 0;
        let opened = 0;
        for (const item of giftItems) {
            const count = Math.max(1, toNum(item?.count));
            try {
                await useItem(CHARITY_SETTLEMENT_GIFT_ID, count, [], toNum(item?.uid));
                opened += count;
            }
            catch {
                // Retry on a later cooldown if the bag changed or the request failed.
            }
        }
        if (opened > 0) {
            log('仓库', `自动打开公益小红花结算礼包 x${opened}`, {
                module: 'warehouse',
                event: 'charity_settlement_gift_open',
                result: 'ok',
                count: opened,
            });
        }
        return opened;
    }
    catch (e) {
        logWarn('仓库', `打开公益小红花结算礼包失败: ${e.message}`, {
            module: 'warehouse',
            event: 'charity_settlement_gift_open',
            result: 'error',
        });
        return 0;
    }
}
function getGoldFromItems(items) {
    for (const item of (items || [])) {
        const id = toNum(item.id);
        if (id === 1 || id === 1001) {
            const count = toNum(item.count);
            if (count > 0)
                return count;
        }
    }
    return 0;
}
function getCurrentTotals() {
    const state = getUserState() || {};
    return {
        gold: Number(state.gold || 0),
        exp: Number(state.exp || 0),
    };
}
async function getCurrentTotalsFromBag() {
    const bagReply = await getBag();
    const items = getBagItems(bagReply);
    let gold = null;
    let exp = null;
    for (const item of items) {
        const id = toNum(item.id);
        const count = toNum(item.count);
        if (id === 1 || id === 1001)
            gold = count; // 金币
        if (id === 1101)
            exp = count; // 累计经验
    }
    return { gold, exp };
}
async function getBagDetail() {
    const bagReply = await getBag();
    const rawItems = getBagItems(bagReply);
    const baseContext = await getSellConditionContext();
    // Balance/container entries have no UID and are not real bag stacks. Keep
    // them separate so status widgets can consume them without displaying them.
    const systemItems = (rawItems || [])
        .filter((it) => toNum(it.id) > 0 && toNum(it.count) > 0 && toNum(it.uid) <= 0)
        .map((it) => {
        const id = toNum(it.id);
        const count = toNum(it.count);
        const info = getItemById(id) || null;
        const interactionType = info && info.interaction_type ? String(info.interaction_type) : '';
        const hoursText = interactionType === 'fertilizerbucket'
            ? `${(Math.floor((count / 3600) * 10) / 10).toFixed(1)}小时`
            : '';
        return { id, count, name: info?.name || `物品${id}`, interactionType, hoursText };
    });
    // 保留原始物品列表（用于出售等操作）
    const originalItems = [];
    for (const it of (rawItems || [])) {
        const id = toNum(it.id);
        const count = toNum(it.count);
        const uid = toNum(it.uid);
        if (id <= 0 || count <= 0 || uid <= 0)
            continue;
        const mutantTypes = getMutantTypes(it);
        const mutantEffects = getMutantEffectsByIds(mutantTypes);
        originalItems.push({
            id,
            count,
            uid,
            expireTime: getItemExpireTime(it),
            mutantTypes,
            mutantEffects,
            mutantTypeNames: mutantEffects.map((effect) => effect.name),
            locked: isItemLocked(it),
            groupKey: `uid:${uid}`,
        });
    }
    // UID is the authoritative identity of a concrete bag stack.
    const merged = new Map();
    for (const it of (rawItems || [])) {
        const id = toNum(it.id);
        const count = toNum(it.count);
        const uid = toNum(it.uid);
        if (id <= 0 || count <= 0 || uid <= 0)
            continue;
        const mutantTypes = getMutantTypes(it);
        const mutantEffects = getMutantEffectsByIds(mutantTypes);
        const groupKey = `uid:${uid}`;
        const info = getItemById(id) || null;
        let name = info && info.name ? String(info.name) : '';
        const itemType = info ? (Number(info.type) || 0) : 0;
        let category = 'item';
        if (id === 1 || id === 1001) {
            name = '金币';
            category = 'gold';
        }
        else if (id === 1101) {
            name = '经验';
            category = 'exp';
        }
        else if (itemType === 17) {
            if (!name)
                name = `${getFruitName(id)}果实`;
            category = 'mutant';
        }
        else if (itemType === 6 || getPlantByFruitId(id)) {
            if (!name)
                name = `${getFruitName(id)}果实`;
            category = 'fruit';
        }
        else if (itemType === 5 || getPlantBySeedId(id)) {
            const p = getPlantBySeedId(id);
            if (!name)
                name = `${p && p.name ? p.name : '未知'}种子`;
            category = 'seed';
        }
        if (!name)
            name = `物品${id}`;
        const interactionType = info && info.interaction_type ? String(info.interaction_type) : '';
        const expireTime = getItemExpireTime(it);
        const sourceInfo = getItemSourceInfo(it);
        const sellInfo = getEffectiveSellInfo(info, { ...baseContext, expireTime });
        const sellsList = sellInfo.sells;
        const protocolSellPrice = getProtocolSellPrice(it);
        const priceId = protocolSellPrice?.currencyId || (sellsList.length > 0 ? sellsList[0].currencyId : 0);
        const price = protocolSellPrice?.price || (sellsList.length > 0 ? sellsList[0].price : 0);
        const priceUnit = priceId === 1005 ? '金豆豆' : priceId === 1002 ? '点券' : '金';
        if (!merged.has(groupKey)) {
            merged.set(groupKey, {
                key: groupKey,
                id,
                count: 0,
                uid,
                expireTime,
                mutantTypes,
                mutantEffects,
                mutantTypeNames: mutantEffects.map((effect) => effect.name),
                locked: isItemLocked(it),
                sourceInfo,
                name,
                image: getItemImageById(id),
                category,
                itemType,
                sellable: sellInfo.sellable,
                sellStatus: sellInfo.status,
                sellCondition: sellInfo.condition,
                priceId,
                price,
                priceUnit,
                level: info ? (Number(info.level) || 0) : 0,
                interactionType,
                description: info?.desc ? String(info.desc) : '',
                viewable: Number(info?.to_see || 0) > 0,
                hoursText: '',
            });
        }
        const row = merged.get(groupKey);
        row.count += count;
    }
    const items = Array.from(merged.values()).map((row) => {
        if (row.interactionType === 'fertilizerbucket' && row.count > 0) {
            // 游戏显示更接近截断到 1 位小数（非四舍五入）
            const hoursFloor1 = Math.floor((row.count / 3600) * 10) / 10;
            row.hoursText = `${hoursFloor1.toFixed(1)}小时`;
        }
        else {
            row.hoursText = '';
        }
        return row;
    });
    items.sort((a, b) => {
        const taRaw = Number(a.itemType || 0);
        const tbRaw = Number(b.itemType || 0);
        const typePriority = new Map([
            [6, 0],
            [17, 1],
            [5, 2],
        ]);
        const ta = typePriority.has(taRaw) ? typePriority.get(taRaw) : (taRaw > 0 ? (1000 + taRaw) : Number.MAX_SAFE_INTEGER);
        const tb = typePriority.has(tbRaw) ? typePriority.get(tbRaw) : (tbRaw > 0 ? (1000 + tbRaw) : Number.MAX_SAFE_INTEGER);
        if (ta !== tb)
            return ta - tb;
        const ca = Number(a.count || 0);
        const cb = Number(b.count || 0);
        if (cb !== ca)
            return cb - ca;
        return Number(a.id || 0) - Number(b.id || 0);
    });
    return { totalKinds: items.length, items, originalItems, systemItems };
}
// ============ 出售逻辑 ============
/**
 * 检查并出售所有果实
 */
async function sellAllFruits() {
    const sellEnabled = isAutomationOn('sell');
    if (!sellEnabled) {
        return;
    }
    try {
        const bagReply = await getBag();
        const items = getBagItems(bagReply);
        const baseContext = await getSellConditionContext();
        const toSell = [];
        const names = [];
        for (const item of items) {
            const id = toNum(item.id);
            const count = toNum(item.count);
            const expireTime = getItemExpireTime(item);
            if (isFruitItemId(id) && id !== 41221 && count > 0
                && !isItemLocked(item)
                && getEffectiveSellInfo(id, { ...baseContext, expireTime }).sellable) {
                toSell.push(item);
                names.push(`${getFruitName(id)}x${count}`);
            }
        }
        if (toSell.length === 0) {
            log('仓库', '无果实可出售');
            return;
        }
        const totalsBefore = getCurrentTotals();
        let serverGoldTotal = 0;
        for (let i = 0; i < toSell.length; i += SELL_BATCH_SIZE) {
            const batch = toSell.slice(i, i + SELL_BATCH_SIZE);
            try {
                const reply = await sellItems(batch);
                const gained = getGoldFromItems(reply.get_items || []);
                if (gained > 0)
                    serverGoldTotal += gained;
            }
            catch (error) { throw error; }
            if (i + SELL_BATCH_SIZE < toSell.length)
                await sleep(300);
        }
        // 余额只由服务端通知维护；出售统计只使用该次 RPC 确认的收益。
        const totalsAfter = getCurrentTotals();
        const totalsDeltaGold = totalsAfter.gold - totalsBefore.gold;
        const totalsDeltaExp = totalsAfter.exp - totalsBefore.exp;
        const totalGoldEarned = serverGoldTotal;
        log('仓库', `出售 ${names.join(', ')}${totalGoldEarned > 0 ? `，获得 ${totalGoldEarned} 金币` : ''}`, {
            module: 'warehouse',
            event: totalGoldEarned > 0 ? 'sell_success' : 'sell_done',
            result: totalGoldEarned > 0 ? 'ok' : 'unknown_gain',
            count: toSell.length,
            gold: totalGoldEarned,
            totalsBefore,
            totalsAfter,
            totalsDeltaGold,
            totalsDeltaExp,
        });
        // 发送出售事件，用于统计金币收益
        if (totalGoldEarned > 0) {
            networkEvents.emit('sell', totalGoldEarned);
        }
    }
    catch (e) {
        logWarn('仓库', `出售失败: ${e.message}`);
        throw e;
    }
}
async function getBagSeeds() {
    const bagReply = await getBag();
    const rawItems = getBagItems(bagReply);
    const merged = new Map();
    for (const item of (rawItems || [])) {
        const seedId = toNum(item && item.id);
        const count = toNum(item && item.count);
        if (seedId <= 0 || count <= 0)
            continue;
        if (isItemLocked(item))
            continue;
        const plant = getPlantBySeedId(seedId);
        const info = getItemById(seedId);
        if (!plant && Number(info?.type) !== 5 && String(info?.interaction_type || '').toLowerCase() !== 'plant')
            continue;
        const current = merged.get(seedId) || {
            seedId,
            name: String(plant?.name || info?.name?.replace(/种子$/, '') || `种子#${seedId}`),
            count: 0,
            requiredLevel: Math.max(0, Number(info?.level || plant?.land_level_need || 0)),
            image: getSeedImageBySeedId(seedId) || getItemImageById(seedId),
            plantSize: Math.max(1, Number(plant?.size || 1)),
        };
        current.count += count;
        merged.set(seedId, current);
    }
    return Array.from(merged.values());
}
module.exports = {
    getBag,
    getBagDetail,
    sellItems,
    useItem,
    batchUseItems,
    openFertilizerGiftPacksSilently,
    openCharitySettlementGiftPacksSilently,
    getFertilizerGiftDailyState: () => ({
        key: 'fertilizer_gift_open',
        doneToday: fertilizerGiftDoneDateKey === getSystemDateKey(),
        lastOpenAt: fertilizerGiftLastOpenAt,
    }),
    sellAllFruits,
    getBagItems,
    getCurrentTotalsFromBag,
    getBagSeeds,
    getContainerHoursFromBagItems,
    setItemsLocked,
    isItemLocked,
};
