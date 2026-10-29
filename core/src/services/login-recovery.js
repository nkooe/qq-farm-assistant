const { sanitizeRefreshText } = require('../models/refresh-job-store');

class LoginRecoveryError extends Error {
  constructor(message, kind = 'temporary', status = 503) {
    super(sanitizeRefreshText(message));
    this.name = 'LoginRecoveryError';
    this.kind = kind;
    this.status = status;
  }
}

function classifyLoginError(error) {
  if (error?.kind) return error.kind;
  if (error?.name === 'AbortError' || error?.status === 410) return 'cancelled';
  if (error?.status === 429) return 'busy';
  // A game HTTP 400 alone does not prove that the underlying login has expired.
  return 'temporary';
}

function loginIdentity(account) {
  return JSON.stringify([account.id, account.username, account.platform, account.loginType,
    account.uin, account.qq, account.wxid, account.yybOpenid, account.qqLoginProfile,
    account.proxyMode, account.proxyProfileId, account.provider, account.thirdparty, account.code]);
}

function requestDeadline(signal, milliseconds) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new LoginRecoveryError('登录服务请求超时，请稍后重试', 'timeout', 504)), milliseconds);
  timer.unref?.();
  return { signal: controller.signal, close() { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
}

function createLoginRecovery() {
  const tasks = new Map();
  const states = new Map();
  function cancel(id) {
    const current = tasks.get(String(id));
    if (current) {
      current.controller.abort();
      const previous = states.get(String(id));
      if (previous) states.set(String(id), { ...previous, state: 'cancelled', kind: 'cancelled', durationMs: Date.now() - previous.startedAt });
      tasks.delete(String(id));
    }
  }
  function run(account, source, operation, { signal } = {}) {
    const id = String(account.id);
    const identity = loginIdentity(account);
    const previous = tasks.get(id);
    if (previous && previous.identity === identity && previous.source === source && !previous.controller.signal.aborted) return previous.promise;
    cancel(id);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const startedAt = Date.now();
    const last = states.get(id);
    const item = { controller, identity, source, promise: null };
    tasks.set(id, item);
    const mark = state => {
      if (tasks.get(id) === item && !controller.signal.aborted) states.set(id, { source, state, startedAt, lastSuccessAt: last?.lastSuccessAt || null, kind: '', durationMs: null });
    };
    mark('requesting');
    item.promise = (async () => {
      try {
        if (controller.signal.aborted) throw new LoginRecoveryError('取码已取消', 'cancelled', 410);
        let abort;
        const cancelled = new Promise((_, reject) => { abort = () => reject(new LoginRecoveryError('取码已取消', 'cancelled', 410)); controller.signal.addEventListener('abort', abort, { once: true }); });
        let result;
        try { result = await Promise.race([operation({ signal: controller.signal, mark }), cancelled]); }
        finally { controller.signal.removeEventListener('abort', abort); }
        if (controller.signal.aborted) throw new LoginRecoveryError('取码已取消', 'cancelled', 410);
        states.set(id, { source, state: result?.ok === false ? 'failed' : 'success', startedAt, lastSuccessAt: result?.ok === false ? last?.lastSuccessAt || null : Date.now(), kind: result?.ok === false ? result.kind || 'temporary' : '', durationMs: Date.now() - startedAt });
        return result;
      } catch (error) {
        if (tasks.get(id) === item) states.set(id, { source, state: controller.signal.aborted ? 'cancelled' : 'failed', startedAt, lastSuccessAt: last?.lastSuccessAt || null, kind: controller.signal.aborted ? 'cancelled' : classifyLoginError(error), durationMs: Date.now() - startedAt });
        throw error;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (tasks.get(id) === item) tasks.delete(id);
      }
    })();
    return item.promise;
  }
  return { run, cancel, getState: id => states.get(String(id)) || null, clear() { for (const id of tasks.keys()) cancel(id); states.clear(); } };
}

module.exports = { LoginRecoveryError, classifyLoginError, loginIdentity, requestDeadline, createLoginRecovery };
