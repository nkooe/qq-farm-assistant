/**
 * Adapter for an ALREADY INITIALIZED QQ 9.9.35 in-process session.
 * This module does not load wrapper.node, inject QQ, start a server, or sign in.
 * Native return shape verified at wrapper.node RVA 0x024c6075.
 */
export class QqLoginError extends Error {
  constructor(message, status = null, diagnostic = null) {
    super(message);
    this.name = 'QqLoginError';
    this.status = status;
    if (diagnostic) this.diagnostic = diagnostic;
  }
}

export function describeIdentity(self) {
  const value = self?.uin;
  const type = value === null ? 'null' : typeof value;
  const text = ['string', 'number', 'bigint'].includes(type) ? String(value) : '';
  return { type, length: Math.min(text.length, 100), valid: /^\d{5,20}$/.test(text) };
}

// Read only the identity returned by QQ. A requested quick-login account is
// never evidence of the account that actually signed in.
export async function waitForIdentity(self, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (describeIdentity(self).valid) return String(self.uin);
    if (Date.now() >= deadline) throw new QqLoginError('QQ 身份尚未就绪，稍后自动重试');
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

// Only structural metadata is allowed across the native diagnostic pipe.
// Never include result values, errMsg, account identifiers, or arbitrary keys.
export function describeLoginResult(reply) {
  const value = reply?.result;
  const diagnostic = {
    status: Number.isInteger(reply?.errCode) ? reply.errCode : null,
    resultType: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
    length: typeof value === 'string' ? Math.min(value.length, 65536) : null,
  };
  if (typeof value === 'string') {
    diagnostic.syntax = value === '' ? 'empty' : /^[-+]?\d+$/.test(value) ? 'numeric'
      : /^[\w.~+/=%-]+$/.test(value) ? 'opaque' : 'other';
    if (value.length <= 65536) {
      try {
        const parsed = JSON.parse(value);
        diagnostic.jsonType = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          diagnostic.jsonFields = ['code', 'errCode', 'ret', 'result', 'data', 'qq_login'].filter(key => Object.hasOwn(parsed, key));
          for (const key of diagnostic.jsonFields) {
            diagnostic[`${key}Type`] = typeof parsed[key];
          }
        }
      } catch { /* Not JSON; no response content is retained. */ }
    }
  }
  return diagnostic;
}

export function decodeLoginResult(reply) {
  if (!reply || typeof reply !== 'object' || !Number.isInteger(reply.errCode)) {
    throw new QqLoginError('QQ 返回格式与已分析版本不符');
  }
  if (reply.errCode !== 0) {
    // Deliberately omit raw errMsg: it may contain private response details.
    throw new QqLoginError(`QQ 小程序授权失败（${reply.errCode}）`, reply.errCode);
  }
  const value = reply.result;
  // Opaque value validation mirrors the existing extractor. It establishes
  // syntax only; server acceptance and remaining TTL are separate questions.
  if (typeof value !== 'string' || !/^[\w.~+/=%-]{8,2048}$/.test(value)
      || /^[-+]?\d+$/.test(value)) {
    const diagnostic = describeLoginResult(reply);
    const detail = diagnostic.syntax === 'empty' ? '空字符串'
      : diagnostic.resultType === 'undefined' ? '缺少 result'
        : `${diagnostic.resultType}${diagnostic.length === null ? '' : `，${diagnostic.length} 字符`}`;
    throw new QqLoginError(`QQ 未返回有效格式的授权结果（${detail}）`, null, diagnostic);
  }
  return value;
}

export async function requestFarmCode(session, {appId = '1112386029', timeoutMs = 15000, signal} = {}) {
  if (typeof appId !== 'string' || !/^\d{6,20}$/.test(appId)) {
    throw new QqLoginError('appId 必须是数字字符串');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw new QqLoginError('timeoutMs 必须是 1–120000 的整数');
  }
  if (signal?.aborted) throw new QqLoginError('操作已取消');
  const misc = session?.getNodeMiscService?.();
  if (typeof misc?.loginWithAppId !== 'function') {
    throw new QqLoginError('QQ 进程内的小程序授权服务尚未就绪');
  }
  // No retries here: an unobserved success could have minted a short-lived Code.
  // Timeout/cancellation only stops this caller from waiting; the native
  // operation has no proven cancellation API in this investigation.
  let timer;
  let cancel;
  const stopped = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new QqLoginError('等待 QQ 授权结果超时')), timeoutMs);
    cancel = () => reject(new QqLoginError('操作已取消'));
    signal?.addEventListener('abort', cancel, {once: true});
  });
  try {
    const operation = Promise.resolve().then(() => {
      if (signal?.aborted) throw new QqLoginError('操作已取消');
      return misc.loginWithAppId(appId);
    });
    let reply;
    try {
      reply = await Promise.race([operation, stopped]);
    } catch (error) {
      if (error instanceof QqLoginError) throw error;
      throw new QqLoginError('QQ 原生授权调用失败');
    }
    return {code: decodeLoginResult(reply)};
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export function decodeQrPicture(event) {
  // Native serializer: 0x02252e58. Keep expiry/interval raw: their units and
  // clock semantics require runtime observation. They are NOT Code TTL.
  const uint32 = x => Number.isInteger(x) && x >= 0 && x <= 0xFFFFFFFF;
  if (!event || typeof event.pngBase64QrcodeData !== 'string'
      || typeof event.qrcodeUrl !== 'string'
      || !uint32(event.expireTime) || !uint32(event.pollTimeInterval)) {
    throw new QqLoginError('QQ 二维码事件格式与已分析版本不符');
  }
  return {pngBase64QrcodeData: event.pngBase64QrcodeData, qrcodeUrl: event.qrcodeUrl,
    expireTime: event.expireTime, pollTimeInterval: event.pollTimeInterval};
}
