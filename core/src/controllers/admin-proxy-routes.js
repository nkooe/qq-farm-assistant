const fetch = require("node-fetch");

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function buildPublicApiRequest(apiUrl, action, payload, appId) {
  const base = trimTrailingSlash(apiUrl);
  if (action === "getqr") {
    return {
      url: `${base  }/Login/LoginGetQRCar`,
      body: {},
    };
  }
  if (action === "checkqr") {
    const uuid = encodeURIComponent(String(payload.uuid || ""));
    return {
      url: `${base  }/Login/LoginCheckQR?uuid=${  uuid}`,
      body: {},
    };
  }
  if (action === "jslogin") {
    return {
      url: `${base  }/Wxapp/JSLogin`,
      body: {
        Wxid: payload.Wxid || payload.wxid || "",
        Appid: payload.Appid || payload.appid || appId || "wx5306c5978fdb76e4",
      },
    };
  }
  return {
    url: `${base  }?action=${  encodeURIComponent(action)}`,
    body: payload,
  };
}

function registerAdminProxyRoutes({ app, logger }) {
  app.post("/api/proxy", async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const { action, ...payload } = body;
    if (!action) {
      return res.status(400).json({ code: -1, msg: "缺少 action 参数" });
    }

    const apiUrl =
      req.headers["x-proxy-api-url"] ||
      process.env.WX_PROXY_API_URL ||
      "https://code.z74d.top/api";
    const apiKey =
      req.headers["x-proxy-api-key"] || process.env.WX_PROXY_API_KEY || "";
    const appId =
      req.headers["x-proxy-app-id"] ||
      process.env.WX_PROXY_APP_ID ||
      "wx5306c5978fdb76e4";

    try {
      let targetUrl = "";
      let requestBody = { ...payload };
      if (apiKey) {
        const params = new URLSearchParams();
        params.set("api_key", apiKey);
        params.set("action", action);
        targetUrl = `${trimTrailingSlash(apiUrl)  }?${  params.toString()}`;
        if (action === "jslogin") {
          requestBody = {
            ...payload,
            wxid: payload.wxid || payload.Wxid || "",
            appid: appId,
          };
        }
      }
      else {
        const request = buildPublicApiRequest(apiUrl, action, payload, appId);
        targetUrl = request.url;
        requestBody = request.body;
      }

      logger.info("proxy request", { action, apiUrl, hasApiKey: !!apiKey });
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const data = await response.json();
      res.json(data);
    } catch (error) {
      logger.error("proxy error", { error: error.message, action });
      res.status(500).json({
        code: -1,
        msg: `代理请求失败: ${  error.message}`,
      });
    }
  });
}

module.exports = { registerAdminProxyRoutes };
