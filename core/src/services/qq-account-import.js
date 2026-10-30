const { QqScanError, validCode } = require('./qq-login-service');
const { loginIdentity } = require('./login-recovery');

function getQqUpdateTarget(provider, userId, targetAccountId, role) {
  if (targetAccountId === undefined || targetAccountId === null || targetAccountId === '') return null;
  if (!['string', 'number'].includes(typeof targetAccountId)) throw new QqScanError('请选择有效的更新账号');
  const account = (provider.getAccounts().accounts || []).find(a => String(a.id) === String(targetAccountId) && (role === 'admin' || a.userId === userId));
  if (!account) throw new QqScanError('更新账号不存在或无权访问', 404);
  if (account.deleting) throw new QqScanError('账号正在删除，请等待清理完成', 409);
  if (account.platform !== 'qq' || account.yybOpenid || account.loginType === 'yyb') throw new QqScanError('此账号不支持 QQ 扫码更新，请使用原登录方式', 409);
  if (!(account.uin || account.qq)) throw new QqScanError('原账号缺少可核验的身份信息，请先手动更新 Code 并登录一次', 409);
  return account;
}

function createQqAccountImporter({ qqLogin, provider, addOrUpdateAccount, userStore }) {
  const userLocks = new Map();
  return async function importAccount(req) {
    const owner = `${req.currentUser.id}:${req.adminToken}`;
    const item = qqLogin.owned(owner, req.params.id);
    if (req.body?.targetAccountId !== undefined && String(req.body.targetAccountId) !== String(item.targetAccountId || '')) {
      throw new QqScanError('更新目标与扫码会话不符，请重新生成二维码', 409);
    }
    if (item.importResult) return item.importResult;
    if (item.importPromise) return item.importPromise;
    const initialTarget = getQqUpdateTarget(provider, req.currentUser.id, item.targetAccountId, req.currentUser.role);
    const userId = initialTarget?.userId || req.currentUser.id;
    const assertActive = () => {
      for (const name of new Set([req.currentUser.id, userId])) {
        const user = userStore.getUser(name);
        const rejection = require('../models/access-policy').getUserAccessRejection(user);
        if (rejection) throw new QqScanError(rejection.error, 403);
      }
    };
    const assertQuota = () => {
      const currentUser = userStore.getUser(req.currentUser.id);
      if (currentUser.role === 'admin') return;
      const count = provider.getAccounts().accounts.filter(a => a.userId === userId).length;
      const limit = currentUser.accountLimit ?? userStore.DEFAULT_ACCOUNT_LIMIT;
      if (!Number.isSafeInteger(limit) || limit < 1) throw new QqScanError('用户账号额度无效', 403);
      if (count >= limit) throw new QqScanError(`账号数量已达上限（${limit}个）`, 403);
    };
    assertActive();
    const previous = userLocks.get(userId) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      if (item.importResult) return item.importResult;
      assertActive();
      qqLogin.owned(owner, item.id);
      if (!validCode(item.code) || !/^\d{5,20}$/.test(item.uin || '')) throw new QqScanError('扫码身份尚未就绪，请重新生成二维码');
      const ownAccounts = () => (provider.getAccounts().accounts || []).filter(a => a.userId === userId && a.platform === 'qq');
      const target = getQqUpdateTarget(provider, req.currentUser.id, item.targetAccountId, req.currentUser.role);
      if (target && target.userId !== userId) throw new QqScanError('账号归属已变化，请重新扫码', 409);
      if (target && (target.uin || target.qq) && String(target.uin || target.qq) !== item.uin) {
        throw new QqScanError('扫码账号与原账号不一致，请使用原账号对应的 QQ 重新扫码；原账号未修改', 409);
      }
      const matches = ownAccounts().filter(a => String(a.uin || a.qq || '') === item.uin);
      assertActive();
      qqLogin.owned(owner, item.id);
      if (matches.length > 1) throw new QqScanError('检测到多个相同身份的旧账号，请保留一个后重试', 409);
      const existing = matches[0];
      if (existing?.deleting) throw new QqScanError('账号正在删除，请等待清理完成', 409);
      const existingIdentity = existing ? loginIdentity(existing) : null;
      if (target) {
        getQqUpdateTarget(provider, req.currentUser.id, target.id, req.currentUser.role);
        if (!existing || String(existing.id) !== String(target.id)) {
          throw new QqScanError('扫码账号与原账号不一致，请使用原账号对应的 QQ 重新扫码；原账号未修改', 409);
        }
      }
      if (!existing) assertQuota();
      const name = target ? '' : String(req.body?.name || '').trim();
      const previousProfile = existing?.qqLoginProfile;
      if (!item.savedProfile) item.savedProfile = await qqLogin.saveProfile(item, userId);
      const qqLoginProfile = item.savedProfile;
      try {
        assertActive();
        qqLogin.owned(owner, item.id);
        const currentAccounts = ownAccounts();
        const current = existing && currentAccounts.find(a => String(a.id) === String(existing.id));
        if (existing && !current) throw new QqScanError('更新账号已删除，原账号未修改', 404);
        if ((current && loginIdentity(current) !== existingIdentity)
          || currentAccounts.some(a => String(a.uin || a.qq || '') === item.uin && String(a.id) !== String(existing?.id || ''))) {
          throw new QqScanError('账号身份或登录配置已变化，请重新扫码；最新账号数据已保留', 409);
        }
      } catch (error) { qqLogin.discardProfile(qqLoginProfile); item.savedProfile = null; throw error; }
      if (!existing) {
        try { assertQuota(); } catch (error) {
          qqLogin.discardProfile(qqLoginProfile); item.savedProfile = null;
          throw error;
        }
      }
      const account = { ...(existing ? { id: existing.id } : { userId, platform: 'qq', loginType: 'manual' }),
        ...(name ? { name } : {}), code: item.code, uin: item.uin, qq: item.uin,
        qqLoginProfile, qqAutoReconnect: existing?.qqAutoReconnect !== false,
        proxyMode: item.proxyMode || 'direct', proxyProfileId: item.proxyProfileId || null };
      let data;
      try { data = addOrUpdateAccount(account); }
      catch (error) { qqLogin.discardProfile(qqLoginProfile); item.savedProfile = null; throw error; }
      if (previousProfile && previousProfile !== qqLoginProfile) {
        qqLogin.discardProfile(previousProfile);
      }
      const accountId = String(existing?.id || data.accounts.at(-1)?.id || '');
      // Store the result before requesting a start: a retried HTTP import must
      // never restart a worker twice or create a second record.
      item.importResult = { accountId, updated: !!existing, code: item.code };
      qqLogin.stopChild(item);
      const action = existing && provider.isAccountRunning?.(accountId) ? 'restartAccount' : 'startAccount';
      await provider[action](accountId, { skipQqRefresh: true });
      provider.addAccountLog?.(existing ? 'update' : 'add', existing ? 'QQ 扫码更新账号' : 'QQ 扫码添加账号', accountId, name || existing?.name || '');
      return item.importResult;
    });
    userLocks.set(userId, operation);
    item.importPromise = operation;
    try { return await operation; }
    finally { item.importPromise = null; if (userLocks.get(userId) === operation) userLocks.delete(userId); }
  };
}

module.exports = { createQqAccountImporter, getQqUpdateTarget };
