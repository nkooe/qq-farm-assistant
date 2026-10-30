/**
 * 第三方应用宝（YYB）接口 client
 *
 * 第三方自建的 {apiBase}/api/open/v1/farm/code 接口，与内置 yyb-go 生成的是
 * 同一个协议（code 一致、可刷新）。本模块供两处共用：
 *   1) 前端「第三方 YYB 登录」tab —— 首次拿 code 添加账号；
 *   2) worker-manager.refreshYybCodeIfNeeded —— 重连前刷新 code。
 *
 * 第三方请求契约：
 *   POST {apiBase}/api/open/v1/farm/code
 *   Authorization: Bearer <apiToken>
 *   body: { openid, forceRefresh, debug }
 *   成功响应：{ success: true, data: { code, openid } }
 *   失败响应：{ success: false, error: "..." }，无效 token 返回 401
 */
const DEFAULT_TIMEOUT_MS = 10000

/**
 * 规范化第三方 apiBase：去尾部斜杠与用户误带的路径后缀。
 */
function normalizeApiBase(value) {
    let base = String(value || '').trim().replace(/\/+$/, '');
    base = base.replace(/\/api\/open\/v1\/farm\/code$/i, '');
    base = base.replace(/\/api\/open\/v1$/i, '');
    base = base.replace(/\/api\/open$/i, '');
    return base;
}

function isValidHttpUrl(base) {
    return /^https?:\/\//i.test(base);
}

function extractCode(data) {
    if (data?.success !== true || typeof data.data?.code !== 'string' || !data.data.code.trim()) return null;
    return data.data.code.trim();
}
function extractOpenid(data) {
    return typeof data?.data?.openid === 'string' ? data.data.openid : undefined;
}

/**
 * 用 openid 向第三方接口换取登录 code
 * @param {{apiBase?:string, apiToken?:string, openid?:string, forceRefresh?:boolean}} params
 * @returns {Promise<{ok:boolean, code?:string, openid?:string, error?:string, status?:number}>} 取码结果与错误分类。
 */
async function getThirdpartyYybCode({ apiBase, apiToken, openid, forceRefresh = false, debug = false, signal } = {}) {
    const base = normalizeApiBase(apiBase);
    if (!base) return { ok: false, kind: 'configuration', error: '第三方接口地址未配置' };
    if (!isValidHttpUrl(base)) return { ok: false, kind: 'configuration', error: '第三方接口地址必须为 http/https' };
    if (!apiToken) return { ok: false, kind: 'configuration', error: '第三方 API Token 未配置' };
    if (!openid) return { ok: false, kind: 'configuration', error: '缺少 openid' };

    const url = `${base}/api/open/v1/farm/code`;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
        if (controller.signal.aborted) return { ok: false, kind: 'cancelled', error: '取码已取消' };
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiToken}`,
            },
            body: JSON.stringify({ openid, forceRefresh, debug }),
            signal: controller.signal,
        });

        if (!resp.ok) {
            const kind = resp.status === 401 || resp.status === 403 ? 'configuration' : resp.status === 409 ? 'rescan' : resp.status === 429 ? 'busy' : 'temporary';
            return { ok: false, status: resp.status, kind, error: `第三方接口返回 HTTP ${resp.status}` };
        }

        let data = null;
        try {
            data = await resp.json();
        } catch {
            return { ok: false, error: '第三方接口返回非 JSON' };
        }

        const code = extractCode(data);
        if (code && extractOpenid(data) === openid) {
            return { ok: true, code, openid };
        }
        return { ok: false, error: '第三方接口未返回有效 Code' };
    } catch (e) {
        if (e && e.name === 'AbortError') {
            return { ok: false, kind: signal?.aborted ? 'cancelled' : 'timeout', error: signal?.aborted ? '取码已取消' : `第三方接口请求超时（>${DEFAULT_TIMEOUT_MS}ms）` };
        }
        return { ok: false, kind: 'temporary', error: '第三方接口连接失败，请检查网络与接口配置' };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
}

module.exports = { getThirdpartyYybCode, normalizeApiBase };
