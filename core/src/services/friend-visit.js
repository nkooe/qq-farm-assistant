const { PlantPhase } = require('../config/config');
const {
  getPlantBlacklist,
  isAutomationOn,
  readFriendDogInfoCache,
} = require('../models/store');
const { getUserState } = require('../utils/network');
const { toNum, log, logWarn, randomDelay, sleep } = require('../utils/utils');
const { recordOperation } = require('./stats');
const { sellAllFruits } = require('./warehouse');
const {
  enterFriendFarm,
  leaveFriendFarm,
  handleFriendEnterError,
} = require('./friend-api');
const { analyzeFriendLands } = require('./friend-land-analyzer');
const { getCurrentPhase } = require('./farm-land-analyzer');
const {
  getRemainingTimes,
  getBadRemainingTimes,
  PUT_BUG_OPERATION_ID,
  PUT_WEED_OPERATION_ID,
  BAD_DAILY_LIMIT,
  canGetExpByCandidates,
  getCanGetHelpExp,
  setCanGetHelpExp,
  helpWater,
  helpWeed,
  helpInsecticide,
  helpFarming,
  stealHarvest,
  putInsectsDetailed,
  putWeedsDetailed,
} = require('./friend-operation-limits');

// ===== 超时包装 =====
/**
 * 给一个 Promise 加超时。超时后 reject，并吞掉原 promise 可能后来才到的 reject，
 * 避免 unhandledRejection。原 promise 的正常 resolve/reject 仍按结果传递（未被吞）。
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || '操作'}超时(${ms}ms)`)), ms);
  });
  if (promise && typeof promise.catch === 'function') {
    promise.catch(() => { /* 吞掉超时后迟到的 reject */ });
  }
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

// ===== Batch helper =====

/** Submit one batch. Failed requests are reported without replaying mutations. */
async function runBatch(landIds, batchFn, opts = {}) {
  const ids = landIds.filter(Boolean);
  if (!ids.length) return 0;
  await batchFn(ids);
  if (opts.stepDelayMs > 0) await sleep(opts.stepDelayMs);
  return ids.length;
}

// ===== Single friend operation =====

/**
 * Perform a single operation on a friend's farm (steal/water/weed/bug/bad).
 * Handles entering/leaving the farm and error classification.
 */
async function doFriendOperation(gid, opType) {
  const numericGid = toNum(gid);
  if (!numericGid) {
    return { ok: false, message: '无效好友ID', opType };
  }

  // Enter friend's farm
  let enterReply;
  try {
    enterReply = await enterFriendFarm(numericGid);
  } catch (err) {
    const handled = handleFriendEnterError(numericGid, `GID:${numericGid}`, err);
    if (handled.handled && handled.kind === 'blacklist') {
      return { ok: true, opType, count: 0, message: '好友已自动加入黑名单' };
    }
    if (handled.handled && handled.kind === 'invalid_removed') {
      return { ok: true, opType, count: 0, message: '好友 GID 已失效，已自动移出已知列表' };
    }
    return { ok: false, message: `进入好友农场失败: ${err.message}`, opType };
  }

  try {
    const lands = enterReply.lands || [];
    const userState = getUserState();
    const plantBlacklist = getPlantBlacklist(userState.accountId);
    const analysis = analyzeFriendLands(lands, userState.gid, '', { plantBlacklist });

    let okCount = 0;

    // ---- Steal ----
    if (opType === 'steal') {
      if (!analysis.stealable.length) {
        return { ok: true, opType, count: 0, message: '没有可偷取土地' };
      }

      // 直接发起偷取请求，服务端会自行截断可偷数量（is_all=true）。
      // 去掉 checkCanOperateRemote 预检查：被偷光时服务端返回错误码，catch 即可。
      try {
        okCount = await runBatch(
          analysis.stealable,
          ids => stealHarvest(numericGid, ids)
        );
      } catch (_) {
        return { ok: true, opType, count: 0, message: 'Ta已经被偷的精光了QAQ' };
      }

      if (okCount > 0) {
        recordOperation('steal', okCount);
        try {
          await sellAllFruits();
        } catch (sellErr) {
          logWarn('仓库', `手动偷取后自动出售失败: ${sellErr.message}`, {
            module: 'warehouse',
            event: '偷菜后出售',
            result: 'error',
            mode: 'manual',
          });
        }
      }

      return { ok: true, opType, count: okCount, message: `偷取完成 ${okCount} 块` };
    }

    // ---- Water ----
    if (opType === 'water') {
      if (!analysis.needWater.length) {
        return { ok: true, opType, count: 0, message: '没有可浇水土地' };
      }

      try {
        okCount = await runBatch(
          analysis.needWater,
          ids => helpWater(numericGid, ids)
        );
      } catch (_) {
        return { ok: true, opType, count: 0, message: '浇水失败，来晚一步，可惜' };
      }

      if (okCount > 0) recordOperation('helpWater', okCount);
      return { ok: true, opType, count: okCount, message: `浇水完成 ${okCount} 块` };
    }

    // ---- Weed ----
    if (opType === 'weed') {
      if (!analysis.needWeed.length) {
        return { ok: true, opType, count: 0, message: '没有可除草土地' };
      }

      try {
        okCount = await runBatch(
          analysis.needWeed,
          ids => helpWeed(numericGid, ids)
        );
      } catch (_) {
        return { ok: true, opType, count: 0, message: '除草失败，来晚一步，可惜' };
      }

      if (okCount > 0) recordOperation('helpWeed', okCount);
      return { ok: true, opType, count: okCount, message: `除草完成 ${okCount} 块` };
    }

    // ---- Bug ----
    if (opType === 'bug') {
      if (!analysis.needBug.length) {
        return { ok: true, opType, count: 0, message: '没有可除虫土地' };
      }

      try {
        okCount = await runBatch(
          analysis.needBug,
          ids => helpInsecticide(numericGid, ids)
        );
      } catch (_) {
        return { ok: true, opType, count: 0, message: '除虫失败，来晚一步，可惜' };
      }

      if (okCount > 0) recordOperation('helpBug', okCount);
      return { ok: true, opType, count: okCount, message: `除虫完成 ${okCount} 块` };
    }

    // ---- Bad (put weeds & insects) ----
    if (opType === 'bad') {
      let bugCount = 0;
      let weedCount = 0;

      if (!analysis.canPutBug.length && !analysis.canPutWeed.length) {
        return {
          ok: true,
          opType,
          count: 0,
          bugCount: 0,
          weedCount: 0,
          message: '没有可捣乱土地',
        };
      }

      let failedMsgs = [];

      // Put insects（去掉 checkCanOperateRemote 预检查，直接尝试）
      if (analysis.canPutBug.length && getBadRemainingTimes() > 0) {
        const remainingBug = Math.min(
          getRemainingTimes(PUT_BUG_OPERATION_ID, BAD_DAILY_LIMIT),
          getBadRemainingTimes()
        );
        const targets = analysis.canPutBug.slice(0, remainingBug);
        const result = targets.length > 0
          ? await putInsectsDetailed(numericGid, targets)
          : { ok: 0, failed: [] };
        bugCount = result.ok;
        failedMsgs = failedMsgs.concat(
          (result.failed || []).map(f => `放虫#${f.landId}:${f.reason}`)
        );
        if (bugCount > 0) recordOperation('bug', bugCount);
      }

      // Put weeds（去掉 checkCanOperateRemote 预检查，直接尝试）
      if (analysis.canPutWeed.length && getBadRemainingTimes() > 0) {
        const remainingWeed = Math.min(
          getRemainingTimes(PUT_WEED_OPERATION_ID, BAD_DAILY_LIMIT),
          getBadRemainingTimes()
        );
        const targets = analysis.canPutWeed.slice(0, remainingWeed);
        const result = targets.length > 0
          ? await putWeedsDetailed(numericGid, targets)
          : { ok: 0, failed: [] };
        weedCount = result.ok;
        failedMsgs = failedMsgs.concat(
          (result.failed || []).map(f => `放草#${f.landId}:${f.reason}`)
        );
        if (weedCount > 0) recordOperation('weed', weedCount);
      }

      okCount = bugCount + weedCount;

      if (okCount <= 0) {
        const errSummary = failedMsgs.slice(-3).join(' | ');
        return {
          ok: true,
          opType,
          count: 0,
          bugCount,
          weedCount,
          message: errSummary ? `捣乱失败: ${errSummary}` : '捣乱失败或今日次数已用完',
        };
      }

      return {
        ok: true,
        opType,
        count: okCount,
        bugCount,
        weedCount,
        message: `捣乱完成 虫${bugCount}/草${weedCount}`,
      };
    }

    return { ok: false, opType, count: 0, message: '未知操作类型' };
  } catch (err) {
    return { ok: false, opType, count: 0, message: err.message || '操作失败' };
  } finally {
    try {
      await leaveFriendFarm(numericGid);
    } catch (_) {
      // Ignore leave errors
    }
  }
}

// ===== Full friend visit =====

/**
 * Visit a friend and perform all enabled operations (help + steal + bad).
 * Tracks per-operation counts in the `tally` object.
 * Returns: { acted, entered }
 */
async function visitFriend(friend, tally, myGid, accountId) {
  const { gid, name } = friend;
  let enterReply;

  // Enter friend's farm
  try {
    enterReply = await enterFriendFarm(gid);
  } catch (err) {
    const handled = handleFriendEnterError(gid, name, err);
    if (handled.handled) {
      return { acted: false, entered: false };
    }
    logWarn('好友', `进入 ${name} 农场失败: ${err.message}`, {
      module: 'friend',
      event: '进入农场',
      result: 'error',
      friendName: name,
      friendGid: gid,
    });
    return { acted: false, entered: false };
  }

  const lands = enterReply.lands || [];
  if (lands.length === 0) {
    await leaveFriendFarm(gid);
    return { acted: false, entered: true };
  }


  const plantBlacklist = getPlantBlacklist(accountId);
  const analysis = analyzeFriendLands(lands, myGid, name, { plantBlacklist });
  const actionLogs = [];

  // ---- Help (weed / bug / water) ----
  const helpEnabled = !!isAutomationOn('friend_help');
  const expLimitEnabled = !!isAutomationOn('friend_help_exp_limit');

  // 护主犬(90021)判定：与巡查主流程一致，优先用传入字段，否则查本地狗信息缓存
  const friendGidNum = toNum(gid);
  const dogCache = readFriendDogInfoCache(accountId);
  const hasGuardDog = !!(dogCache && dogCache[friendGidNum] && toNum(dogCache[friendGidNum].dogId) === 90021);

  if (!expLimitEnabled) setCanGetHelpExp(true);

  if (helpEnabled) {
    // 经验满时仍帮助护主犬好友，仅跳过普通好友（与 visitFriendForHelp 行为一致）
    if (!expLimitEnabled || getCanGetHelpExp() || hasGuardDog) {
      const helpOptions = [
        {
          id: 0x2715,             // 10005 = 放虫（占位，未直接使用）
          expIds: [0x2713],       // [10003 = 帮好友除草]
          list: analysis.needWeed,
          fn: helpWeed,
          key: 'weed',
          name: '草',
          record: 'helpWeed',
        },
        {
          id: 0x2716,             // 10006 = 放草（占位，未直接使用）
          expIds: [0x2712],       // [10002 = 帮好友除虫]
          list: analysis.needBug,
          fn: helpInsecticide,
          key: 'bug',
          name: '虫',
          record: 'helpBug',
        },
        {
          id: 0x2717,             // 10007 = 帮好友复活（占位，未直接使用）
          expIds: [0x2711],       // [10001 = 帮好友浇水]
          list: analysis.needWater,
          fn: helpWater,
          key: 'water',
          name: '水',
          record: 'helpWater',
        },
      ];

      for (const opt of helpOptions) {
        const useExpCheck = hasGuardDog ? false : expLimitEnabled;
        const canGetExp = !expLimitEnabled ||
          hasGuardDog ||
          (canGetExpByCandidates(opt.expIds) && getCanGetHelpExp());

        if (opt.list.length > 0 && canGetExp) {
          // 去掉 checkCanOperateRemote 预检查，直接发起帮忙操作
          try {
            const okCount = await runBatch(
              opt.list,
              ids => opt.fn(gid, ids, useExpCheck)
            );
            if (okCount > 0) {
              actionLogs.push(`${opt.name}${okCount}`);
              tally[opt.key] += okCount;
              recordOperation(opt.record, okCount);
              await randomDelay(50, 100);
            }
          } catch (_) {
            // 帮忙操作整体失败，跳过该类操作
          }
        }
      }
    }
  }

  // ---- Steal ----
  if (isAutomationOn('friend_steal') && analysis.stealable.length > 0) {

    let stolen = 0;
    const stolenNames = [];

    try {
      await stealHarvest(gid, analysis.stealable);
      stolen = analysis.stealable.length;
      analysis.stealable.forEach(landId => {
        const info = analysis.stealableInfo.find(s => s.landId === landId);
        if (info) stolenNames.push(info.name);
      });
    } catch (error) {
      throw error;
    }

    if (stolen > 0) {
      const namesStr = [...new Set(stolenNames)].join('/');
      actionLogs.push(`偷${stolen}${namesStr ? `(${namesStr})` : ''}`);
      tally.steal += stolen;
      recordOperation('steal', stolen);
    }
  }

  // ---- Bad (put weeds & insects) ----
  const badEnabled = isAutomationOn('friend_bad');
  let badCount = 0;
  let putBugCount = 0;
  let putWeedCount = 0;
  const badFailedMsgs = [];

  if (badEnabled) {
    // Put insects（去掉 checkCanOperateRemote 预检查）
    if (analysis.canPutBug.length > 0 && getBadRemainingTimes() > 0) {
      const remainingBug = Math.min(
        getRemainingTimes(PUT_BUG_OPERATION_ID, BAD_DAILY_LIMIT),
        getBadRemainingTimes()
      );
      const targets = analysis.canPutBug.slice(0, remainingBug);
      const result = await putInsectsDetailed(gid, targets);
      const okCount = result.ok;
      badFailedMsgs.push(...(result.failed || []).map(f => `放虫#${f.landId}:${f.reason}`));
      if (okCount > 0) {
        actionLogs.push(`放虫${okCount}`);
        tally.putBug += okCount;
        putBugCount += okCount;
        badCount += okCount;
      }
      await randomDelay(50, 100);
    }

    // Put weeds（去掉 checkCanOperateRemote 预检查）
    if (analysis.canPutWeed.length > 0 && getBadRemainingTimes() > 0) {
      const remainingWeed = Math.min(
        getRemainingTimes(PUT_WEED_OPERATION_ID, BAD_DAILY_LIMIT),
        getBadRemainingTimes()
      );
      const targets = analysis.canPutWeed.slice(0, remainingWeed);
      const result = await putWeedsDetailed(gid, targets);
      const okCount = result.ok;
      badFailedMsgs.push(...(result.failed || []).map(f => `放草#${f.landId}:${f.reason}`));
      if (okCount > 0) {
        actionLogs.push(`放草${okCount}`);
        tally.putWeed += okCount;
        putWeedCount += okCount;
        badCount += okCount;
      }
      await randomDelay(50, 100);
    }
  }

  if (actionLogs.length > 0) {
    log('好友', `${name}: ${actionLogs.join('/')}`, {
      module: 'friend',
      event: '照顾好友',
      result: 'ok',
      friendName: name,
      friendGid: gid,
      actions: actionLogs,
    });
  }

  await leaveFriendFarm(gid);
  return {
    acted: actionLogs.length > 0,
    entered: true,
    count: badCount,
    bugCount: putBugCount,
    weedCount: putWeedCount,
    message: badCount > 0
      ? `捣乱完成 虫${putBugCount}/草${putWeedCount}`
      : badFailedMsgs.slice(-3).join(' | '),
  };
}

// ===== Visit friend for steal only =====

/**
 * Visit a friend specifically to steal crops.
 */
async function visitFriendForSteal(friend, tally, myGid, accountId) {
  const { gid, name } = friend;
  let enterReply;

  try {
    enterReply = await enterFriendFarm(gid);
  } catch (err) {
    const handled = handleFriendEnterError(gid, name, err);
    if (handled.handled) {
      return { acted: false, entered: false };
    }
    logWarn('好友', `进入 ${name} 农场失败: ${err.message}`, {
      module: 'friend',
      event: '进入农场',
      result: 'error',
      friendName: name,
      friendGid: gid,
    });
    return { acted: false, entered: false };
  }

  const lands = enterReply.lands || [];
  if (lands.length === 0) {
    await leaveFriendFarm(gid);
    return { acted: false, entered: true };
  }


  const plantBlacklist = getPlantBlacklist(accountId);
  const analysis = analyzeFriendLands(lands, myGid, name, { plantBlacklist });
  const actionLogs = [];

  // Check if any stealable land still has remaining steal slots for us
  const hasStealSlot = lands.some(land => {
    const plant = land.plant;
    if (!plant || !plant.phases || plant.phases.length === 0) return false;
    const phase = getCurrentPhase(plant.phases, false);
    if (!phase || phase.phase !== PlantPhase.MATURE) return false;
    if (!plant.stealable) return false;

    const stealPlayers = plant.steal_player;
    if (!stealPlayers || stealPlayers.length === 0) return true;

    const mySteal = stealPlayers.find(s => toNum(s.gid) === myGid);
    const myStealCount = mySteal ? toNum(mySteal.num) : 0;
    const maxSteal = toNum(plant.steal_num, 0);
    return myStealCount < maxSteal;
  });

  if (!hasStealSlot && analysis.stealable.length === 0) {
    await leaveFriendFarm(gid);
    return { acted: false, entered: true };
  }

  if (analysis.stealable.length > 0) {
    let stolen = 0;
    const stolenNames = [];

    // 先尝试批量偷取（stealHarvest 用 is_all=true，服务端会截断到可偷数量）
    try {
      await stealHarvest(gid, analysis.stealable);

      // 但为了效率，直接按 stealable.length 计数（服务端 is_all=true 语义是"尽量偷"）

      stolen = analysis.stealable.length;
      analysis.stealable.forEach(landId => {
        const info = analysis.stealableInfo.find(s => s.landId === landId);
        if (info) stolenNames.push(info.name);
      });
    } catch (error) {
      throw error;
    }

    if (stolen > 0) {
      const namesStr = [...new Set(stolenNames)].join('/');
      actionLogs.push(`偷${stolen}${namesStr ? `(${namesStr})` : ''}`);
      tally.steal += stolen;
      recordOperation('steal', stolen);
    }
  }

  if (actionLogs.length > 0) {
    log('好友', `${name}: ${actionLogs.join('/')}`, {
      module: 'friend',
      event: '偷好友菜',
      result: 'ok',
      friendName: name,
      friendGid: gid,
      actions: actionLogs,
    });
  }

  await leaveFriendFarm(gid);
  return { acted: actionLogs.length > 0, entered: true };
}

// ===== Visit friend for help only =====

/**
 * Visit a friend specifically to help (water/weed/bug).
 * Honors experience limit. Guard dog friends bypass the limit.
 */

// ===== 帮好友务农：recent-help 去重 + 批量/回退（完整对齐参考仓库）=====
const _recentHelp = new Map();
const _HELP_IN_FLIGHT_TTL_MS = 15000;
const _HELP_RESULT_TTL_MS = 30000;
const _HELP_CACHE_MAX = 2048;

function _getHelpKey(hostGid, landId) {
  return `${hostGid}:${landId}`;
}

function _pruneRecentHelp(now = Date.now()) {
  for (const [key, entry] of _recentHelp) {
    if (entry.expiresAt <= now) _recentHelp.delete(key);
  }
  while (_recentHelp.size > _HELP_CACHE_MAX) {
    const oldestKey = _recentHelp.keys().next().value;
    if (!oldestKey) break;
    _recentHelp.delete(oldestKey);
  }
}

function _getHelpSnapshotKey(lands) {
  return (Array.isArray(lands) ? lands : []).map(land => {
    const plant = land && land.plant;
    const phase = plant && Array.isArray(plant.phases) ? getCurrentPhase(plant.phases) : null;
    const weeds = (plant && Array.isArray(plant.weed_owners) ? plant.weed_owners : []).map(toNum).join(',');
    const insects = (plant && Array.isArray(plant.insect_owners) ? plant.insect_owners : []).map(toNum).join(',');
    return [
      toNum(land && land.id),
      toNum(plant && plant.id),
      toNum(phase && phase.phase),
      toNum(plant && plant.dry_num),
      weeds,
      insects,
    ].join(':');
  }).join('|');
}

function _filterRecentHelp(hostGid, landIds, snapshotKey) {
  const now = Date.now();
  _pruneRecentHelp(now);
  return [...new Set((landIds || []).map(id => toNum(id)).filter(id => id > 0))].filter(landId => {
    const key = _getHelpKey(hostGid, landId);
    const entry = _recentHelp.get(key);
    if (!entry || entry.expiresAt <= now) return true;
    if (entry.snapshotKey !== snapshotKey) {
      _recentHelp.delete(key);
      return true;
    }
    return false;
  });
}

function _markRecentHelp(hostGid, landIds, state, ttlMs, snapshotKey) {
  const expiresAt = Date.now() + ttlMs;
  for (const landId of landIds) {
    _recentHelp.set(_getHelpKey(hostGid, landId), { state, snapshotKey, expiresAt });
  }
  _pruneRecentHelp();
}

function _releaseRecentHelp(hostGid, landIds) {
  for (const landId of landIds) _recentHelp.delete(_getHelpKey(hostGid, landId));
}

function _emptyFarmingOutcome(effect = 'noop') {
  return { effect, operationCount: 0, landCount: 0, landIds: [], operationLimits: [], code: 0 };
}

/** 一键务农只发送一次；失败保留原始错误。 */
async function runFarmingBatch(hostGid, ids, stopWhenExpLimit, snapshotKey) {
  const target = _filterRecentHelp(hostGid, ids, snapshotKey);
  if (target.length === 0) return _emptyFarmingOutcome();
  _markRecentHelp(hostGid, target, 'in_flight', _HELP_IN_FLIGHT_TTL_MS, snapshotKey);
  try {
    const batch = await helpFarming(hostGid, target, stopWhenExpLimit);
    if (batch.effect === 'noop') {
      _markRecentHelp(hostGid, target, 'noop', _HELP_RESULT_TTL_MS, snapshotKey);
      return batch;
    }
    if (batch.effect === 'confirmed') {
      _markRecentHelp(hostGid, batch.landIds, 'confirmed', _HELP_RESULT_TTL_MS, snapshotKey);
    }
    const unconfirmed = target.filter(landId => !batch.landIds.includes(landId));
    _releaseRecentHelp(hostGid, unconfirmed);
    return batch;
  } catch (error) {
    _releaseRecentHelp(hostGid, target);
    throw error;
  }
}

async function visitFriendForHelp(friend, tally, myGid, accountId, ignoreExpLimit = false, expLimitMode = false, fastMode = false) {
  const { gid, name } = friend;
  const expLimitEnabled = !!isAutomationOn('friend_help_exp_limit');
  const checkExpLimit = expLimitEnabled && !ignoreExpLimit;
  let hasGuardDog = !!friend.hasGuardDog;

  // 仅当"经验上限开关本就关闭"时，才自由保持/恢复 canGetHelpExp=true。
  // 若开关开着却因 ignoreExpLimit 导致本次 checkExpLimit=false，绝不擅自清掉已触发的
  // 仅帮护主犬禁用状态，否则会出现"无差别帮所有人"的回退。
  if (!expLimitEnabled) setCanGetHelpExp(true);

  // Skip if exp limit reached and no guard dog
  if (checkExpLimit && !getCanGetHelpExp() && !hasGuardDog) {
    return { acted: false, entered: false };
  }

  let enterReply;
  try {
    // 【2026-08-15】对齐纯 Go 版：Enter 统一走默认超时（sendMsgAsync 20s），无 fastMode 短门限；
    // 失败立即跳过（catch 里 return 下一个，不重试不卡）。
    enterReply = await enterFriendFarm(gid);
  } catch (err) {
    const handled = handleFriendEnterError(gid, name, err);
    if (handled.handled) {
      return { acted: false, entered: false };
    }
    if (!fastMode) {
      logWarn('好友', `进入 ${name} 农场失败: ${err.message}`, {
        module: 'friend',
        event: '进入农场',
        result: 'error',
        friendName: name,
        friendGid: gid,
      });
    }
    return { acted: false, entered: false };
  }

  // 【2026-08-15】对齐纯 Go 版 enterHasGuardDog：进农场后用 enter 实时 brief_dog_info 判定护主犬，
  // 不再只信磁盘缓存（缓存可能滞后/为空导致误判）。
  hasGuardDog = require('./friend-pet-cache').getState(gid, accountId || process.env.FARM_ACCOUNT_ID || '') === 'protect';
  friend.hasGuardDog = hasGuardDog;

  const lands = enterReply.lands || [];
  if (lands.length === 0) {
    await leaveFriendFarm(gid);
    return { acted: false, entered: true };
  }


  const analysis = analyzeFriendLands(lands, myGid, name, {});
  const actionLogs = [];

  const useExpCheck = hasGuardDog ? false : checkExpLimit;

  // 【2026-08-15】完整对齐参考仓库：帮好友用 PlantService.Farming 一键务农
  // （FarmingRequest{land_ids, host_gid, field_3:0, field_4:2}，回包 FarmingReply.results 逐地块确认，
  //  code=1001057 静默），带 recent-help 去重，失败直接上报，不再拆三个独立 RPC。
  const allHelpLandIds = [...new Set([...analysis.needWeed, ...analysis.needBug, ...analysis.needWater])];
  if (allHelpLandIds.length > 0) {
    const allowByExp = !checkExpLimit ||
      hasGuardDog ||
      (canGetExpByCandidates([0x2713, 0x2712, 0x2711]) && getCanGetHelpExp());
    if (allowByExp) {
      try {
        const outcome = await runFarmingBatch(gid, allHelpLandIds, useExpCheck, _getHelpSnapshotKey(lands));
        if (outcome.landCount > 0) {
          const parts = [];
          if (analysis.needWeed.length) parts.push(`草${analysis.needWeed.length}`);
          if (analysis.needBug.length) parts.push(`虫${analysis.needBug.length}`);
          if (analysis.needWater.length) parts.push(`水${analysis.needWater.length}`);
          actionLogs.push(`一键务农${outcome.landCount}块/${outcome.operationCount}项(${parts.join('/')})`);
          tally.weed += Math.min(analysis.needWeed.length, outcome.landCount);
          tally.bug += Math.min(analysis.needBug.length, outcome.landCount);
          tally.water += Math.min(analysis.needWater.length, outcome.landCount);
          recordOperation('helpFarming', outcome.operationCount);
          if (expLimitMode && hasGuardDog) {
            log('好友', `[护主犬好友] ✅ ${name}: 一键务农${outcome.landCount}块(${parts.join('/')})`, {
              module: 'friend',
              event: '护主犬好友帮助成功',
              friendName: name,
              operation: 'farming',
              count: outcome.landCount,
            });
          }
        } else {
          log('好友', `[护主犬好友] ${name}: 一键务农无效果（need ${allHelpLandIds.length} 块, 服务端确认 0）`, {
            module: 'friend',
            event: '护主犬好友帮助无效果',
            friendName: name,
            need: allHelpLandIds.length,
            outcomeEffect: outcome.effect,
            outcomeCode: outcome.code,
          });
        }
      } catch (err) {
        logWarn('好友', `${name} 一键务农异常: ${err.message}`, {
          module: 'friend',
          event: '帮助好友',
          result: 'error',
          friendName: name,
          friendGid: gid,
          error: err.message,
          code: err.code || 0,
        });
      }
    }
  }

  if (actionLogs.length > 0) {
    log('好友', `${name}: ${actionLogs.join('/')}`, {
      module: 'friend',
      event: '帮助好友',
      result: 'ok',
      friendName: name,
      friendGid: gid,
      actions: actionLogs,
    });
  } else if (expLimitMode && hasGuardDog && (analysis.needWater.length + analysis.needWeed.length + analysis.needBug.length) > 0) {
    // 护主犬好友但所有操作都没成功，记录原因方便排查
    // 调试：对比 列表快照(friend.dryNum/weedNum/insectNum) 与 进农场实测土地合计，
    // 用于判断是"快照滞后"还是"分析漏判"。
    const freshDry = lands.reduce((s, l) => s + toNum(l.plant && l.plant.dry_num), 0);
    const freshWeed = lands.reduce((s, l) => s + toNum(l.plant && l.plant.weed_num), 0);
    const freshInsect = lands.reduce((s, l) => s + toNum(l.plant && l.plant.insect_num), 0);
    const weedOwners = lands.reduce((s, l) => s + ((l.plant && l.plant.weed_owners) ? l.plant.weed_owners.length : 0), 0);
    logWarn('好友', `[护主犬好友] ${name}: 进入农场但无有效操作（可能土地状态已变或次数用完）`, {
      module: 'friend',
      event: '护主犬好友帮助无效果',
      friendName: name,
      friendGid: gid,
      needWater: analysis.needWater.length,
      needWeed: analysis.needWeed.length,
      needBug: analysis.needBug.length,
      lands: lands.length,
      snapDry: toNum(friend.dryNum),
      snapWeed: toNum(friend.weedNum),
      snapInsect: toNum(friend.insectNum),
      freshDry,
      freshWeed,
      freshInsect,
      freshWeedOwners: weedOwners,
    });
  }

  await leaveFriendFarm(gid);
  return { acted: actionLogs.length > 0, entered: true };
}

// ===== Exports =====
module.exports = {
  runBatch,
  doFriendOperation,
  visitFriend,
  visitFriendForSteal,
  visitFriendForHelp,
};
