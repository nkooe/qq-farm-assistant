const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { QqScanError, validCode } = require('./qq-login-service');

function probeFarmIdentity(code, proxyURL, signal) {
  if (signal?.aborted) return Promise.reject(new QqScanError('扫码已取消', 410));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-identity-'));
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(path.join(__dirname, '../../qq-login/farm-identity-worker.cjs'), {
        workerData: { code, proxyURL, runtimeConfig: require('../config/config').getRuntimeConfig(),
          deviceProtocol: require('../models/store').getDeviceProtocol() }, stdout: true, stderr: true,
        env: { ...process.env, FARM_DATA_DIR: directory, FARM_LOG_DIR: path.join(directory, 'logs') },
      });
    } catch {
      fs.rmSync(directory, { recursive: true, force: true });
      reject(new QqScanError('无法启动农场身份核验，请重新扫码'));
      return;
    }
    worker.stdout.resume(); worker.stderr.resume();
    const timer = setTimeout(() => finish(new QqScanError('农场身份核验超时，请重新扫码', 504)), 65000);
    let done = false;
    const cancel = () => finish(new QqScanError('扫码已取消', 410));
    signal?.addEventListener('abort', cancel, { once: true });
    function finish(error, identity) {
      if (done) return; done = true; clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      void worker.terminate().finally(() => {
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        if (error) reject(error); else resolve(identity);
      });
    }
    worker.on('message', value => {
      if (!/^\d+$/.test(value.identity?.gid || '')) return finish(new QqScanError('农场身份核验失败，请重新扫码'));
      finish(null, value.identity);
    });
    worker.on('error', () => finish(new QqScanError('农场身份核验失败，请重新扫码')));
    worker.on('exit', () => finish(new QqScanError('农场身份核验进程已退出，请重新扫码')));
    if (signal?.aborted) cancel();
  });
}

function getQqUpdateTarget(provider, username, targetAccountId) {
  if (targetAccountId === undefined || targetAccountId === null || targetAccountId === '') return null;
  if (!['string', 'number'].includes(typeof targetAccountId)) throw new QqScanError('请选择有效的更新账号');
  const account = (provider.getAccounts().accounts || []).find(a => String(a.id) === String(targetAccountId) && a.username === username);
  if (!account) throw new QqScanError('更新账号不存在或无权访问', 404);
  if (account.platform !== 'qq' || account.yybOpenid || account.loginType === 'yyb') throw new QqScanError('此账号不支持 QQ 扫码更新，请使用原登录方式', 409);
  if (!(account.uin || account.qq || account.gid || account.openId)) throw new QqScanError('原账号缺少可核验的身份信息，请先手动更新 Code 并登录一次', 409);
  return account;
}

function createQqAccountImporter({ qqLogin, provider, addOrUpdateAccount, userStore, probe = probeFarmIdentity }) {
  const userLocks = new Map();
  return async function importAccount(req) {
    const owner = `${req.currentUser.username}:${req.adminToken}`;
    const item = qqLogin.owned(owner, req.params.id);
    if (req.body?.targetAccountId !== undefined && String(req.body.targetAccountId) !== String(item.targetAccountId || '')) {
      throw new QqScanError('更新目标与扫码会话不符，请重新生成二维码', 409);
    }
    if (item.importResult) return item.importResult;
    if (item.importPromise) return item.importPromise;
    const username = req.currentUser.username;
    const previous = userLocks.get(username) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      if (item.importResult) return item.importResult;
      qqLogin.owned(owner, item.id);
      if (!validCode(item.code) || !/^\d{5,20}$/.test(item.uin || '')) throw new QqScanError('扫码身份尚未就绪，请重新生成二维码');
      const ownAccounts = () => (provider.getAccounts().accounts || []).filter(a => a.username === username && a.platform === 'qq');
      const target = getQqUpdateTarget(provider, username, item.targetAccountId);
      if (target && (target.uin || target.qq) && String(target.uin || target.qq) !== item.uin) {
        throw new QqScanError('扫码账号与原账号不一致，请使用原账号对应的 QQ 重新扫码；原账号未修改', 409);
      }
      let matches = ownAccounts().filter(a => String(a.uin || a.qq || '') === item.uin);
      if ((!matches.length && ownAccounts().length) || (target && !matches.some(a => String(a.id) === String(target.id)))) {
        if (!item.farmIdentity) {
          if (item.probeAttempted) item.code = await qqLogin.refreshCode(owner, item.id);
          item.probeAttempted = true;
          item.farmIdentity = await probe(item.code, item.proxyURL || '', item.abortController?.signal);
        }
        // A login probe may consume its Code. Always mint a fresh credential.
        item.code = await qqLogin.refreshCode(owner, item.id);
        const { gid, openId } = item.farmIdentity;
        matches = ownAccounts().filter(a => (gid && String(a.gid) === String(gid)) || (openId && a.openId === openId));
        if (matches.some(a => (a.uin || a.qq) && String(a.uin || a.qq) !== item.uin)) throw new QqScanError('账号身份冲突，原账号已保留', 409);
      }
      qqLogin.owned(owner, item.id);
      if (matches.length > 1) throw new QqScanError('检测到多个相同身份的旧账号，请保留一个后重试', 409);
      const existing = matches[0];
      if (target) {
        getQqUpdateTarget(provider, username, target.id);
        if (!existing || String(existing.id) !== String(target.id)) {
          throw new QqScanError('扫码账号与原账号不一致，请使用原账号对应的 QQ 重新扫码；原账号未修改', 409);
        }
      }
      if (!existing && req.currentUser.role !== 'admin') {
        const count = (provider.getAccounts().accounts || []).filter(a => a.username === username).length;
        const limit = req.currentUser.accountLimit || userStore.DEFAULT_ACCOUNT_LIMIT || 2;
        if (count >= limit) throw new QqScanError(`账号数量已达上限（${limit}个）`, 403);
      }
      const name = target ? '' : String(req.body?.name || '').trim();
      const previousProfile = existing?.qqLoginProfile;
      if (!item.savedProfile) item.savedProfile = await qqLogin.saveProfile(item, username);
      const qqLoginProfile = item.savedProfile;
      try {
        qqLogin.owned(owner, item.id);
        if (existing && !ownAccounts().some(a => String(a.id) === String(existing.id))) throw new QqScanError('更新账号已删除，原账号未修改', 404);
      } catch (error) { qqLogin.discardProfile(qqLoginProfile); item.savedProfile = null; throw error; }
      const account = { ...(existing ? { id: existing.id } : { username, platform: 'qq', loginType: 'manual' }),
        ...(name ? { name } : {}), code: item.code, uin: item.uin, qq: item.uin,
        qqLoginProfile, qqAutoReconnect: existing?.qqAutoReconnect !== false,
        ...(item.farmIdentity || {}), proxyMode: item.proxyMode || 'direct', proxyProfileId: item.proxyProfileId || null };
      let data;
      try { data = addOrUpdateAccount(account); }
      catch (error) { qqLogin.discardProfile(qqLoginProfile); item.savedProfile = null; throw error; }
      if (previousProfile && previousProfile !== qqLoginProfile) {
        try { qqLogin.discardProfile(previousProfile); } catch { /* A stale profile must not undo a saved login. */ }
      }
      const accountId = String(existing?.id || data.accounts.at(-1)?.id || '');
      // Store the result before requesting a start: a retried HTTP import must
      // never restart a worker twice or create a second record.
      item.importResult = { accountId, updated: !!existing, code: item.code };
      qqLogin.stopChild(item);
      const action = existing && provider.isAccountRunning?.(accountId) ? 'restartAccount' : 'startAccount';
      void Promise.resolve().then(() => provider[action](accountId, { skipQqRefresh: true })).catch(() => {});
      provider.addAccountLog?.(existing ? 'update' : 'add', existing ? 'QQ 扫码更新账号' : 'QQ 扫码添加账号', accountId, name || existing?.name || '');
      return item.importResult;
    });
    userLocks.set(username, operation);
    item.importPromise = operation;
    try { return await operation; }
    finally { item.importPromise = null; if (userLocks.get(username) === operation) userLocks.delete(username); }
  };
}

module.exports = { createQqAccountImporter, probeFarmIdentity, getQqUpdateTarget };
