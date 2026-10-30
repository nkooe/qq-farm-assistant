/**
 * 应用宝（YYB Go）代理路由
 *
 * 代理前端调应用宝接口，避免浏览器跨域 + 保护 apiKey 不暴露。
 * 接口规范：
 *   GET  {apiBase}/accounts          — 列出应用宝账号
 *   POST {apiBase}/wxapp/getCode     — 用 openid 换小程序 code（登录凭证）
 *
 * 鉴权：应用宝接口要求 Header Authorization: Bearer {apiKey}
 */

const DEFAULT_APP_ID = "wx5306c5978fdb76e4";
const { getThirdpartyYybCode } = require("../utils/thirdpartyYyb");

/**
 * 规范化 apiBase：去掉尾部斜杠，以及用户可能误带的 /wxapp/getCode 等路径后缀。
 * 用户在前端可能填 "http://x.x.x.x:8000/wxapp/getCode"（完整接口地址），
 * 这里统一还原为基准地址 "http://x.x.x.x:8000"，再拼接具体 path。
 */
function normalizeApiBase(value) {
  let base = String(value || "").trim().replace(/\/+$/, "");
  // 去掉用户可能误带的已知路径后缀
  base = base.replace(/\/wxapp\/getCode$/i, "");
  base = base.replace(/\/wxapp$/i, "");
  base = base.replace(/\/accounts$/i, "");
  return base;
}

/**
 * 解析应用宝连接凭据：优先用请求体里的 apiBase/apiKey（前端手动填写），
 * 未传时回退到容器内环境变量 YYB_API_URL / YYB_API_KEY（单镜像部署时由
 * docker-compose 注入，指向同容器内的 yyb-go 服务，无需前端再填外部地址）。
 */
function resolveYybCreds(body = {}) {
  // 透传 body 其余字段（如 openid / sessionId / appId），否则 poll/confirm/getcode
  // 等 handler 解构不到这些字段，会永远返回「缺少 sessionId / openid」。
  const { apiBase, apiKey, ...rest } = body;
  return {
    apiBase: (apiBase || "").trim() || process.env.YYB_API_URL || "",
    apiKey: (apiKey || "").trim() || process.env.YYB_API_KEY || "",
    ...rest,
  };
}

/**
 * 统一调用应用宝接口的 helper
 * @returns {Promise<{ok:boolean, data?:any, error?:string, yybCode?:number}>}
 */
async function callYybApi(apiBase, path, apiKey, init = {}) {
  const base = normalizeApiBase(apiBase);
  if (!base) return { ok: false, error: "应用宝接口地址未配置" };
  if (!apiKey) return { ok: false, error: "应用宝 API Token 未配置" };

  const url = `${base}${path}`;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    ...(init.headers || {}),
  };
  if (init.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  try {
    const resp = await fetch(url, { ...init, headers, signal: init.signal || AbortSignal.timeout(50000) });
    let data = null;
    try {
      data = await resp.json();
    } catch {
      return { ok: false, error: `应用宝接口返回非 JSON（HTTP ${resp.status}）`, retryable: resp.status >= 500 };
    }

    if (resp.status >= 400 && (!data || data.code === 0)) {
      return { ok: false, error: `应用宝接口请求失败（HTTP ${resp.status}）`, retryable: resp.status >= 500 };
    }

    // 应用宝统一响应：{ code:0, msg, data }
    if (data && typeof data === "object" && "code" in data) {
      if (data.code !== 0) {
        return { ok: false, error: data.msg || `应用宝接口错误 code=${data.code}`, yybCode: data.code, needsRescan: resp.status === 409, retryable: resp.status >= 500 };
      }
      return { ok: true, data: data.data };
    }
    return { ok: false, error: "应用宝接口响应格式无效" };
  } catch (e) {
    return { ok: false, error: `应用宝接口请求失败: ${e.message}`, retryable: true };
  }
}

function callerHeaders(req) {
  if (!require('../models/user-id').isUserIdentity(req.currentUser)) throw new Error('缺少有效用户身份');
  return {
    'X-Farm-User-ID': String(req.currentUser.id),
    'X-Farm-Role': req.currentUser.role,
  };
}

function callWithIdentity(req, apiBase, path, apiKey, init = {}) {
  return callYybApi(apiBase, path, apiKey, {
    ...init,
    headers: { ...(init.headers || {}), ...callerHeaders(req) },
  });
}

function filterYybAccountsForUser(data, req, getAccountsForUser) {
  if (!Array.isArray(data)) throw new Error('应用宝账号响应格式无效');
  const accounts = data;
  if (req.currentUser?.role === 'admin') return accounts;
  if (req.currentUser?.role !== 'user' || !req.currentUser.id) throw new Error('缺少有效用户身份');
  const owned = new Set(getAccountsForUser(req.currentUser.id)
    .map(account => String(account.yybOpenid || '').trim()).filter(Boolean));
  return accounts.filter(account => owned.has(String(account.openid || account.open_id || '').trim()));
}

function registerAdminYybRoutes({ app, requireAdminToken, getAccountsForUser, canAccessAccount, onProxyProfileChanged }) {
  if (typeof getAccountsForUser !== 'function' || typeof canAccessAccount !== 'function') throw new Error('YYB routes require account access controls');
  const run = handler => async (req, res) => {
    try { await handler(req, res); }
    catch (error) {
      if (!res.headersSent) res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  };
  const confirmedIdentities = new Map();
  const retiredUsers = new Set();
  const suspendedUsers = new Set();
  const pendingCalls = new Map();
  async function runFor(req, request, signal) {
    const userId = req.currentUser.id;
    if (retiredUsers.has(userId) || suspendedUsers.has(userId)) throw Object.assign(new Error('用户已停用'), { status: 403 });
    const controller = new AbortController();
    const operation = request(AbortSignal.any([controller.signal, signal || AbortSignal.timeout(50000)]));
    const pending = { userId, controller, operation };
    pendingCalls.set(operation, pending);
    try {
      const result = await operation;
      if (retiredUsers.has(userId) || suspendedUsers.has(userId) || controller.signal.aborted) throw Object.assign(new Error('用户已停用或请求已取消'), { status: 403 });
      return result;
    } finally { pendingCalls.delete(operation); }
  }
  function callFor(req, apiBase, path, apiKey, init = {}) {
    return runFor(req, signal => callWithIdentity(req, apiBase, path, apiKey, { ...init, signal }), init.signal);
  }
  function credentialsFor(req, input = {}) {
    // Browser-selected endpoints must never receive the server's API token.
    if (req.currentUser?.role !== 'admin') {
      const { apiBase: _base, apiKey: _key, ...fields } = input;
      return resolveYybCreds(fields);
    }
    return resolveYybCreds(input);
  }
  function ownsIdentity(req, ref, includeConfirmed = false) {
    if (req.currentUser?.role === 'admin') return true;
    const userId = req.currentUser?.id;
    if (!userId || req.currentUser.role !== 'user') return false;
    const account = getAccountsForUser(userId).find(item => item.provider !== 'thirdparty' && String(item.yybOpenid || '') === String(ref));
    if (account && canAccessAccount(req, account.id)) return true;
    const key = JSON.stringify([userId, String(ref)]);
    return includeConfirmed && (confirmedIdentities.get(key) || 0) > Date.now();
  }
  function sendYybResult(res, result, successStatus = 200) {
    if (!result.ok) {
      return res.status(result.retryable ? 502 : result.needsRescan ? 409 : 400).json({ ok: false, error: result.error, yybCode: result.yybCode, retryable: !!result.retryable, needsRescan: !!result.needsRescan });
    }
    return res.status(successStatus).json({ ok: true, data: result.data });
  }

  // 静态代理配置库（密码仅保存在 YYB 本机 SQLite，列表接口只返回是否已配置）
  app.get("/api/yyb/proxy-profiles", requireAdminToken, run(async (req, res) => {
    const { apiBase, apiKey } = credentialsFor(req, req.query);
    return sendYybResult(res, await callFor(req, apiBase, "/proxy-profiles", apiKey, { method: "GET" }));
  }));

  app.post("/api/yyb/proxy-profiles", requireAdminToken, run(async (req, res) => {
    const { apiBase, apiKey, ...profile } = credentialsFor(req, req.body);
    return sendYybResult(res, await callFor(req, apiBase, "/proxy-profiles", apiKey, {
      method: "POST",
      body: JSON.stringify(profile),
    }), 201);
  }));

  app.put("/api/yyb/proxy-profiles", requireAdminToken, run(async (req, res) => {
    const { apiBase, apiKey, ...profile } = credentialsFor(req, req.body);
    const result = await callFor(req, apiBase, "/proxy-profiles", apiKey, {
      method: "PUT",
      body: JSON.stringify(profile),
    });
    if (result.ok && onProxyProfileChanged) await onProxyProfileChanged(Number(profile.id), apiBase);
    return sendYybResult(res, result);
  }));

  app.delete("/api/yyb/proxy-profiles/:id", requireAdminToken, run(async (req, res) => {
    const { apiBase, apiKey } = credentialsFor(req, req.query);
    const id = encodeURIComponent(String(req.params.id || ""));
    const result = await callFor(req, apiBase, `/proxy-profiles?id=${id}`, apiKey, { method: "DELETE" });
    if (result.ok && onProxyProfileChanged) await onProxyProfileChanged(Number(req.params.id), apiBase);
    return sendYybResult(res, result);
  }));

  app.post("/api/yyb/proxy-profiles/:id/test", requireAdminToken, run(async (req, res) => {
    const { apiBase, apiKey } = credentialsFor(req, req.body);
    return sendYybResult(res, await callFor(req, apiBase, "/proxy-profiles/test", apiKey, {
      method: "POST",
      body: JSON.stringify({ proxy_profile_id: Number(req.params.id) }),
    }));
  }));

  app.get("/api/yyb/account-proxy", requireAdminToken, run(async (req, res) => {
    const { apiBase, apiKey, ref } = credentialsFor(req, req.query);
    if (!ref) return res.status(400).json({ ok: false, error: "缺少账号标识" });
    if (!ownsIdentity(req, ref)) return res.status(403).json({ ok: false, error: '无权访问此账号' });
    return sendYybResult(res, await callFor(req, apiBase, `/accounts/proxy?ref=${encodeURIComponent(ref)}`, apiKey, { method: "GET" }));
  }));

  app.put("/api/yyb/account-proxy", requireAdminToken, run(async (req, res) => {
    const { apiBase, apiKey, ref, mode, proxyProfileId } = credentialsFor(req, req.body);
    if (!ref) return res.status(400).json({ ok: false, error: "缺少账号标识" });
    if (!ownsIdentity(req, ref)) return res.status(403).json({ ok: false, error: '无权访问此账号' });
    return sendYybResult(res, await callFor(req, apiBase, "/accounts/proxy", apiKey, {
      method: "PUT",
      body: JSON.stringify({ ref, mode, proxy_profile_id: mode === "static" ? Number(proxyProfileId) : null }),
    }));
  }));

  // 拉应用宝账号列表
  app.post("/api/yyb/accounts", requireAdminToken, run(async (req, res) => {
    const { apiBase, apiKey } = credentialsFor(req, req.body);
    const result = await callFor(req, apiBase, "/accounts", apiKey, { method: "GET" });
    if (!result.ok) {
      return sendYybResult(res, result);
    }
    const accounts = filterYybAccountsForUser(result.data, req, getAccountsForUser);
    res.json({ ok: true, data: accounts });
  }));

  // 用 openid 换 code
  app.post("/api/yyb/getcode", requireAdminToken, run(async (req, res) => {
    const { apiBase, apiKey, openid, appId } = credentialsFor(req, req.body);
    if (!openid) {
      return res.status(400).json({ ok: false, error: "缺少 openid" });
    }
    const finalAppId = appId || DEFAULT_APP_ID;
    if (!ownsIdentity(req, openid, true)) return res.status(403).json({ ok: false, error: '无权访问此账号' });
    const result = await callFor(req, apiBase, "/wxapp/getCode", apiKey, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: openid, app_id: finalAppId }),
    });
    if (!result.ok) {
      return sendYybResult(res, result);
    }
    // data 结构：{ openid, result: { code, errMsg } }
    const data = result.data || {};
    const code = data.result && data.result.code;
    if (!code) {
      return res.status(500).json({ ok: false, error: "应用宝接口未返回 code" });
    }
    res.json({ ok: true, data: { code, openid: data.openid || openid } });
  }));

  // 第三方 YYB：用 openid + APITOKEN 向第三方接口换 code（第三方登录 tab 用）
  // 返回的 code 与内置 yyb-go 同协议、可刷新，喂给现有 worker 登录流程即可。
  app.post("/api/yyb/thirdparty-code", requireAdminToken, run(async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const { apiBase, apiToken, openid, name } = body;
    const result = await runFor(req, signal => getThirdpartyYybCode({ apiBase, apiToken, openid, forceRefresh: Boolean(body.forceRefresh), signal }));
    if (!result.ok) {
      return res.status(result.status === 401 ? 401 : 400).json({ ok: false, error: result.error });
    }
    res.json({
      ok: true,
      data: {
        code: result.code,
        openid: result.openid || openid,
        name: typeof name === "string" ? name.trim() : "",
      },
    });
  }));

  // ==================== 应用宝扫码登录 ====================
  // 应用宝 QR 接口：创建会话 → 长轮询状态 → 确认授权 → 账号入库

  // 创建扫码会话（返回 base64 二维码）
  app.post("/api/yyb/qr/create", requireAdminToken, run(async (req, res) => {
    const { apiBase, apiKey, proxyMode, proxyProfileId } = credentialsFor(req, req.body);
    const result = await callFor(req, apiBase, "/qr?as_base64=true", apiKey, {
      method: "POST",
      body: JSON.stringify({
        proxy_mode: proxyMode || "direct",
        proxy_profile_id: proxyMode === "static" ? Number(proxyProfileId) : null,
      }),
    });
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error, yybCode: result.yybCode });
    }
    // data: { session_id, status, image_base64, image_url }
    res.json({ ok: true, data: result.data });
  }));

  // 长轮询扫码状态（前端需设较长 timeout，如 30s；后端给 65s 保护避免无限 hold）
  app.post("/api/yyb/qr/poll", requireAdminToken, run(async (req, res) => {
    const { apiBase, apiKey, sessionId } = credentialsFor(req, req.body);
    if (!sessionId) {
      return res.status(400).json({ ok: false, error: "缺少 sessionId" });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 65000);
    try {
      const result = await callFor(req, apiBase, `/qr/${encodeURIComponent(sessionId)}/poll`, apiKey, {
        method: "GET",
        signal: controller.signal,
      });
      if (!result.ok) {
        return res.status(result.retryable ? 502 : 400).json({ ok: false, error: result.error, yybCode: result.yybCode });
      }
      // data: { status: pending|scanned|authorized|confirmed|expired|cancelled, errcode? }
      res.json({ ok: true, data: result.data });
    } finally {
      clearTimeout(timeout);
    }
  }));

  // 确认授权（status=authorized 后调用，把账号保存到应用宝服务端）
  app.post("/api/yyb/qr/confirm", requireAdminToken, run(async (req, res) => {
    const { apiBase, apiKey, sessionId } = credentialsFor(req, req.body);
    if (!sessionId) {
      return res.status(400).json({ ok: false, error: "缺少 sessionId" });
    }
    const result = await callFor(req, apiBase, `/qr/${encodeURIComponent(sessionId)}/confirm`, apiKey, { method: "POST" });
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error, yybCode: result.yybCode });
    }
    const openid = String(result.data?.openid || '').trim();
    if (openid && req.currentUser?.id) {
      for (const [key, expiresAt] of confirmedIdentities) {
        if (expiresAt <= Date.now()) confirmedIdentities.delete(key);
      }
      if (confirmedIdentities.size >= 1000) confirmedIdentities.delete(confirmedIdentities.keys().next().value);
      confirmedIdentities.set(JSON.stringify([req.currentUser.id, openid]), Date.now() + 10 * 60 * 1000);
    }
    // confirm 成功后 data 里通常包含新账号信息（openid 等）
    res.json({ ok: true, data: result.data });
  }));
  return {
    async suspendUserState(userId) {
      suspendedUsers.add(userId);
      for (const key of confirmedIdentities.keys()) if (JSON.parse(key)[0] === userId) confirmedIdentities.delete(key);
      const pending = [...pendingCalls.values()].filter(item => item.userId === userId);
      pending.forEach(item => item.controller.abort());
      await Promise.allSettled(pending.map(item => item.operation));
    },
    resumeUserState(userId) { suspendedUsers.delete(userId); },
    async purgeUserState(userId) {
      retiredUsers.add(userId);
      for (const key of confirmedIdentities.keys()) if (JSON.parse(key)[0] === userId) confirmedIdentities.delete(key);
      const pending = [...pendingCalls.values()].filter(item => item.userId === userId);
      pending.forEach(item => item.controller.abort());
      await Promise.allSettled(pending.map(item => item.operation));
    },
  };

}

module.exports = { registerAdminYybRoutes, callYybApi, resolveYybCreds };
