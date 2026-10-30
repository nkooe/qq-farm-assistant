const fetch = require('node-fetch');
const { createScheduler } = require('../services/scheduler');
const { createLoginRecovery, LoginRecoveryError, loginIdentity, requestDeadline } = require('../services/login-recovery');
const { sanitizeRefreshText } = require('../models/refresh-job-store');

function createAutoCodeRefreshService(deps) {
  const { store, getAccounts, addOrUpdateAccount, resolveWorkerControls, log, addAccountLog } = deps;
  const loginRecovery = deps.loginRecovery || createLoginRecovery();
  const request = deps.fetch || fetch;
  const getAccountAccessRejection = deps.getAccountAccessRejection || require('../services/account-access').getAccountAccessRejection;
  const pending = new Map();
  const scheduler = createScheduler('auto_code_refresh');
  const taskName = id => `refresh_${String(id || '')}`;
  const findAccount = id => (getAccounts().accounts || []).find(account => String(account.id) === String(id));
  const controls = () => resolveWorkerControls?.() || {};
  const online = id => controls().getWorkerRuntime?.(id)?.connected === true;

  async function requestFarmCode(account, config, signal) {
    if (!account.wxid) throw new LoginRecoveryError('账号缺少 wxid，无法刷新 Code', 'configuration');
    const deadline = requestDeadline(signal, 25000);
    try {
      const key = String(config.apiKey || '').trim();
      const appid = String(config.appId || 'wx5306c5978fdb76e4');
      const base = String(key ? config.proxyApiUrl || 'https://code.z74d.top/api' : config.apiBase || 'https://code.z74d.top/api').replace(/\/+$/, '');
      const url = key ? `${base}?api_key=${encodeURIComponent(key)}&action=jslogin` : `${base}/Wxapp/JSLogin`;
      const response = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(key ? { wxid: account.wxid, appid } : { Wxid: account.wxid, Appid: appid }), signal: deadline.signal });
      if (!response.ok) throw new LoginRecoveryError(`微信取码接口返回 HTTP ${response.status}`, response.status === 401 || response.status === 403 ? 'configuration' : response.status === 429 ? 'busy' : 'temporary');
      const data = await response.json();
      const code = key ? data?.code === 0 && data.data?.code : data?.Success && data.Data?.code;
      if (typeof code !== 'string' || !code.trim()) throw new LoginRecoveryError('微信接口未返回有效 Code，请检查登录状态');
      return code;
    } catch (error) {
      if (signal.aborted) throw new LoginRecoveryError('微信取码已取消', 'cancelled', 410);
      if (deadline.signal.aborted) throw new LoginRecoveryError('微信取码超时，请稍后重试', 'timeout', 504);
      throw error;
    } finally { deadline.close(); }
  }

  function refreshAccountCode(id, reason = 'timer') {
    id = String(id);
    const account = findAccount(id);
    if (!account || account.platform === 'qq' || account.loginType === 'yyb') return Promise.resolve(false);
    if (getAccountAccessRejection(account)) { stopAccount(id); return Promise.resolve(false); }
    if (pending.has(id)) return pending.get(id);
    const config = store.getUserWxConfig(account.userId);
    if (config.enabled === false || (reason === 'timer' && (account.autoStart === false || online(id)))) return Promise.resolve(false);
    const identity = loginIdentity(account);
    const operation = (async () => {
      try {
        const code = await loginRecovery.run(account, 'wxid', ({ signal }) => requestFarmCode(account, config, signal));
        const current = findAccount(id);
        if (pending.get(id) !== operation || !current || loginIdentity(current) !== identity || getAccountAccessRejection(current)) return false;
        if (reason === 'timer' && online(id)) return false;
        addOrUpdateAccount({ id, code });
        if (typeof controls().restartWorker === 'function' && current.autoStart !== false) await controls().restartWorker({ ...current, code });
        addAccountLog('auto_code_refresh', '微信 Code 已刷新', id, current.name, { reason });
        return true;
      } catch (error) {
        if (error.kind !== 'cancelled') {
          const message = sanitizeRefreshText(error.message || '微信取码失败');
          addAccountLog('auto_code_refresh_failed', message, id, account.name, { reason });
          log('错误', `微信 Code 刷新失败: ${message}`, { accountId: id });
        }
        return false;
      } finally { if (pending.get(id) === operation) pending.delete(id); }
    })();
    pending.set(id, operation);
    return operation;
  }

  function stopAccount(id) {
    id = String(id);
    const operation = pending.get(id);
    scheduler.clear(taskName(id)); loginRecovery.cancel(id); pending.delete(id);
    return operation;
  }
  function scheduleAccount(id) {
    scheduler.clear(taskName(id));
    const config = store.getAutoCodeRefresh?.(id);
    const account = findAccount(id);
    if (!account || account.platform === 'qq' || account.loginType === 'yyb') return;
    if (getAccountAccessRejection(account)) { stopAccount(id); return; }
    if (!config?.enabled) { loginRecovery.cancel(id); return; }
    if (!account.wxid || account.autoStart === false) return;
    const minutes = Math.max(1, Math.min(1440, Number(config.intervalMinutes) || 60));
    scheduler.setIntervalTask(taskName(id), minutes * 60000, () => refreshAccountCode(id, 'timer'), { preventOverlap: true });
  }
  function rescheduleAll() { scheduler.clearAll(); for (const account of getAccounts().accounts || []) scheduleAccount(account.id); }
  function close() { scheduler.clearAll(); for (const id of pending.keys()) stopAccount(id); }
  return { refreshAccountCode, scheduleAccount, rescheduleAll, stopAccount, close };
}

module.exports = { createAutoCodeRefreshService };
