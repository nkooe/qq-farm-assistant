/**
 * Admin Panel Controller
 * QQ Farm Automation Bot - 管理面板服务器
 *
 * 提供 Express + Socket.IO 管理面板后端：
 * - 用户认证（登录/注册/密码修改/密码重置）
 * - 卡密管理（创建/查询/续费/领取记录）
 * - 账号管理（增删改查/启动停止/备注）
 * - 农场操作（种植/施肥/铲除/收获）
 * - 好友管理（列表/操作/拉黑）
 * - 商店/图鉴/活动/背包
 * - 系统设置/公告/代理/二维码登录
 * - 实时状态推送（WebSocket）
 */
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { Server: SocketIOServer } = require("socket.io");
const {
  CONFIG,
  updateRuntimeConfig,
  getRuntimeConfig,
  getDefaultSystemConfig,
} = require("../config/config");
const { getDataFile, getResourcePath } = require("../config/runtime-paths");
const store = require("../models/store");
const { addOrUpdateAccount } = store;
const { findAccountByRef } = require("../services/account-resolver");

const { createModuleLogger } = require("../services/logger");
const { registerAdminActivityRoutes } = require("./admin-activity-routes");
const {
  registerAdminAccountRuntimeRoutes,
} = require("./admin-account-runtime-routes");
const { registerAdminAccountRoutes } = require("./admin-account-routes");
const { createRefreshJobStore } = require('../models/refresh-job-store');
const { registerAdminFriendRoutes } = require("./admin-friend-routes");
const { registerAdminDogRoutes } = require("./admin-dog-routes");
const { registerAdminCareerRoutes } = require("./admin-career-routes");
const { registerAdminAnalyticsRoutes } = require("./admin-analytics-routes");
const { createAdminAccountAccess } = require("./admin-account-access");
const { registerAdminAuthRoutes } = require("./admin-auth-routes");
const { registerAdminBagRoutes } = require("./admin-bag-routes");
const { registerAdminCardRoutes } = require("./admin-card-routes");
const { registerAdminCurrentUserRoutes } = require("./admin-current-user-routes");
const { registerAdminYybRoutes } = require("./admin-yyb-routes");
const { registerAdminQqLoginRoutes } = require("./admin-qq-login-routes");
const { getQqLoginService } = require("../services/qq-login-service");
const {
  registerAdminFarmOperationRoutes,
} = require("./admin-farm-operation-routes");
const {
  registerAdminFarmResourceRoutes,
} = require("./admin-farm-resource-routes");
const { registerAdminIllustratedRoutes } = require("./admin-illustrated-routes");
const { registerAdminLoginLogRoutes } = require("./admin-login-log-routes");
const {
  registerAdminPlantBlacklistRoutes,
} = require("./admin-plant-blacklist-routes");
const { registerAdminPublicInfoRoutes } = require("./admin-public-info-routes");
const { createAdminRouteHelpers } = require("./admin-route-helpers");
const { registerAdminSettingsRoutes } = require("./admin-settings-routes");
const { registerAdminShopRoutes } = require("./admin-shop-routes");
const { createAdminSessionManager } = require("./admin-session-manager");
const { registerAdminSystemRoutes } = require("./admin-system-routes");
const { registerAdminUserRoutes } = require("./admin-user-routes");
const userStore = require("../models/user-store");

const adminLogger = createModuleLogger("admin");
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
];
const PUBLIC_API_PATHS = new Set([
  "/login",
  "/card-claim/status",
  "/card-claim/claim",
  "/game-version",
  "/public/login-links",
  "/public/access-policy",
  "/user-count",
  "/changelog",
  "/public/renew",
  "/public/reset-password/verify",
  "/public/reset-password/confirm",
  "/health",
]);
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const HTTP_REQUEST_TIMEOUT_MS = 120 * 1000;
const HTTP_HEADERS_TIMEOUT_MS = 16 * 1000;
const HTTP_KEEP_ALIVE_TIMEOUT_MS = 5 * 1000;
const HTTP_CONNECTION_IDLE_TIMEOUT_MS = 30 * 1000;
const HTTP_CLOSE_WAIT_SWEEP_MS = 5000;

let app = null;
let server = null;
let provider = null;
let io = null;
let realtime = null;
const { createAdminRealtime } = require("./admin-realtime");

function emitRealtimeStatus(accountId, status) {
  if (!io) return;
  accountId = String(accountId || "").trim();
  if (!accountId) return;
  realtime.emit(accountId, "status:update", { accountId, status });
}

function emitRealtimeLog(logEntry) {
  if (!io) return;
  const accountId = String(logEntry.accountId || '');
  if (accountId) realtime.emit(accountId, 'log:new', logEntry);
}

function emitRealtimeAccountLog(logEntry) {
  if (!io) return;
  const accountId = String(logEntry.accountId || '');
  if (accountId) realtime.emit(accountId, 'account-log:new', logEntry);
}

function configureCorsMiddleware(expressApp) {
  expressApp.use((req, res, next) => {
    const allowedOrigins = CONFIG.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS;
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.header("Access-Control-Allow-Origin", origin);
    } else if (!origin) {
      res.header("Access-Control-Allow-Origin", "*");
    }
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS, PUT");
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, x-account-id, x-admin-token, x-proxy-api-key, x-proxy-api-url, x-proxy-app-id",
    );
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    return next();
  });
}

function configureStaticAssets(expressApp, webDist) {
  if (!fs.existsSync(path.join(webDist, 'index.html'))) throw new Error('前端构建缺失，请先执行 pnpm -C web build');
  expressApp.use(express.static(webDist));
}

function registerAuthGate(expressApp, requireAdminToken) {
  expressApp.use("/api", (req, res, next) => {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    return requireAdminToken(req, res, next);
  });
}

function registerLogoutRoute(expressApp, invalidateAdminSessionAndDisconnect) {
  expressApp.post("/api/logout", (req, res) => {
    const token = req.adminToken;
    if (token) invalidateAdminSessionAndDisconnect(token);
    res.json({ ok: true });
  });
}

function registerHealthRoute(expressApp) {
  expressApp.get("/api/health", (req, res) => {
    res.json({
      ok: true,
      status: "ok",
      uptime: process.uptime(),
      timestamp: Date.now(),
    });
  });
}

function registerRequestTimeoutGuard(expressApp) {
  expressApp.use((req, res, next) => {
    if (req.path === "/api/health") return next();

    const timeout = setTimeout(() => {
      if (res.headersSent || res.writableEnded || res.destroyed) return;
      res.locals.requestTimedOut = true;
      res.status(503).json({
        ok: false,
        error: "Request Timeout",
      });
    }, HTTP_REQUEST_TIMEOUT_MS);

    res.on("finish", () => clearTimeout(timeout));
    res.on("close", () => clearTimeout(timeout));
    return next();
  });
}

function registerSpaFallback(expressApp, webDist) {
  expressApp.get("*", (req, res) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/game-config")) {
      return res.status(404).json({
        ok: false,
        error: "Not Found",
      });
    }
    return res.sendFile(path.join(webDist, "index.html"));
  });
}

function configureHttpServerTimeouts(httpServer) {
  httpServer.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  httpServer.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  httpServer.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  httpServer.timeout = HTTP_CONNECTION_IDLE_TIMEOUT_MS;
  httpServer.setTimeout(HTTP_CONNECTION_IDLE_TIMEOUT_MS, (socket) => {
    socket.destroy();
  });
}

function trackHttpConnections(httpServer) {
  const sockets = new Set();
  const sweepTimer = setInterval(() => {
    for (const socket of sockets) {
      if (socket.destroyed) {
        sockets.delete(socket);
        continue;
      }
      if (socket.readableEnded || socket.writableEnded) {
        socket.destroy();
        sockets.delete(socket);
      }
    }
  }, HTTP_CLOSE_WAIT_SWEEP_MS);
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();

  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.setKeepAlive(false);
    socket.setTimeout(HTTP_CONNECTION_IDLE_TIMEOUT_MS);
    socket.on("end", () => {
      socket.destroy();
      sockets.delete(socket);
    });
    socket.on("timeout", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });
  httpServer.on("close", () => {
    clearInterval(sweepTimer);
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();
  });
}

function getSocketHandshakeToken(socket) {
  const authToken =
    socket.handshake.auth && socket.handshake.auth.token
      ? String(socket.handshake.auth.token)
      : "";
  const headerToken =
    socket.handshake.headers && socket.handshake.headers["x-admin-token"]
      ? String(socket.handshake.headers["x-admin-token"])
      : "";
  return authToken || headerToken;
}

function startAdminServer(dataProvider) {
  if (app) return;
  provider = dataProvider;
  app = express();
  app.set("trust proxy", false);
  app.use(express.json({ limit: "256kb" }));

  const adminSessionManager = createAdminSessionManager({
    logger: adminLogger,
    getUser: userStore.getUser,
    getIo: () => io,
  });
  const {
    cleanupInvalidAdminSessions,
    createAdminSession,
    getSession: getAdminSession,
    hasToken: hasAdminToken,
    invalidateAdminSessionAndDisconnect,
    invalidateAdminSessions,
    requireAdminToken,
    updateAdminSessions,
  } = adminSessionManager;

  const adminAccountAccess = createAdminAccountAccess({
    store,
    getProvider: () => provider,
  });
  const {
    canAccessAccount,
    getAccessibleAccountIdsForUser,
    getAccessibleAccountIdsFromRequest,
    getAccountIdFromRequest,
    getAccountsForUser,
    resolveAccountReference,
  } = adminAccountAccess;

  const adminRouteHelpers = createAdminRouteHelpers({
    userStore,
  });
  const {
    getAdminUserMutationError,
    requireAdminRole,
    requireDangerConfirmation,
    sendProviderError,
  } = adminRouteHelpers;

  const webDist = path.join(__dirname, "../../../web/dist");
  configureCorsMiddleware(app);
  configureStaticAssets(app, webDist);
  app.use("/game-config", express.static(getResourcePath("modern", "gameConfig")));
  app.use("/game-config", express.static(getResourcePath("gameConfig")));

  // 游戏 CDN 代理
  const CDN_BASE = 'https://cdn-resource.nqf.qq.com';
  const manifestPath = path.join(getResourcePath('gameConfig'), 'manifest.csv');
  const seedCdnMap = new Map();
  try {
    if (fs.existsSync(manifestPath)) {
      const lines = fs.readFileSync(manifestPath, 'utf-8').split('\n');
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].trim().split(',');
        if (cols.length >= 5) {
          const spriteName = cols[4];
          const source = cols[1];
          const match = spriteName && spriteName.match(/^Crop_(\d+)_Seed$/);
          if (match && source) {
            seedCdnMap.set(Number(match[1]), source);
          }
        }
      }
    }
  } catch (e) { /* ignore */ }

  app.get("/api/game-asset", async (req, res) => {
    const seedId = Number(req.query.seedId || 0);
    if (!seedId || !seedCdnMap.has(seedId)) return res.status(404).end();
    const sourcePath = seedCdnMap.get(seedId);
    try {
      const url = `${CDN_BASE}/${sourcePath}`;
      const response = await fetch(url);
      if (!response.ok) return res.status(404).end();
      const buffer = Buffer.from(await response.arrayBuffer());
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=86400');
      res.end(buffer);
    } catch { res.status(502).end(); }
  });

  // 游戏资源代理（从 CDN 拉取 seed_images / activity 等素材）
  const loginAssetsDir = getDataFile("login-assets");
  fs.mkdirSync(loginAssetsDir, { recursive: true });
  app.use(
    "/login-assets",
    express.static(loginAssetsDir, {
      dotfiles: "deny",
      setHeaders(res, filePath) {
        res.setHeader("X-Content-Type-Options", "nosniff");
        if (path.extname(filePath).toLowerCase() === ".svg") {
          res.setHeader(
            "Content-Security-Policy",
            "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
          );
        }
      },
    }),
  );
  app.use("/login-assets", (req, res) => res.sendStatus(404));
  setInterval(cleanupInvalidAdminSessions, FIVE_MINUTES_MS);

  registerAdminAuthRoutes({
    app,
    logger: adminLogger,
    userStore,
    requireAdminToken,
    createAdminSession,
    updateAdminSessions,
    invalidateAdminSessions,
  });
  registerHealthRoute(app);
  registerAuthGate(app, requireAdminToken);
  registerRequestTimeoutGuard(app);
  registerAdminPublicInfoRoutes({
    app,
    provider,
    userStore,
    requireAdminRole,
    getAccountIdFromRequest,
    canAccessAccount,
    sendProviderError,
  });
  registerLogoutRoute(app, invalidateAdminSessionAndDisconnect);

  registerAdminFarmResourceRoutes({
    app,
    provider,
    getAccountIdFromRequest,
    canAccessAccount,
    sendProviderError,
  });
  registerAdminPlantBlacklistRoutes({
    app,
    provider,
    store,
    requireAdminToken,
    getAccountIdFromRequest,
    canAccessAccount,
    sendProviderError,
  });
  registerAdminShopRoutes({
    app,
    provider,
    adminLogger,
    getAccountIdFromRequest,
    canAccessAccount,
    sendProviderError,
  });
  registerAdminActivityRoutes({
    app,
    provider,
    getAccountIdFromRequest,
    canAccessAccount,
    sendProviderError,
  });
  registerAdminIllustratedRoutes({
    app,
    provider,
    adminLogger,
    getAccountIdFromRequest,
    canAccessAccount,
    sendProviderError,
  });
  registerAdminBagRoutes({
    app,
    provider,
    emitRealtimeLog,
    getAccountIdFromRequest,
    canAccessAccount,
    sendProviderError,
  });
  registerAdminAccountRuntimeRoutes({
    app,
    provider,
    resolveAccountReference,
    canAccessAccount,
  });
  registerAdminFarmOperationRoutes({
    app,
    provider,
    getAccountIdFromRequest,
    canAccessAccount,
    sendProviderError,
  });
  registerAdminAnalyticsRoutes({ app });
  registerAdminSettingsRoutes({
    app,
    provider,
    store,
    logger: adminLogger,
    getAccountIdFromRequest,
    canAccessAccount,
    requireDangerConfirmation,
  });
  registerAdminSystemRoutes({
    app,
    store,
    logger: adminLogger,
    requireAdminToken,
    requireAdminRole,
    cleanupInvalidAdminSessions,
    requireDangerConfirmation,
    enforceUserAccess: () => userAccessMonitor.reconcile(),
    getDefaultSystemConfig,
    getRuntimeConfig,
    updateRuntimeConfig,
    // 保存/重置系统配置后广播 config_sync 到所有 Worker（clientVersion 秒级生效）
    broadcastConfig: provider.broadcastConfig,
  });
  registerAdminCardRoutes({
    app,
    requireAdminToken,
    requireAdminRole,
    requireDangerConfirmation,
    userStore,
    adminLogger,
  });
  const { createUserDeletion } = require("../services/user-deletion");
  const deleteUserData = createUserDeletion({ userStore, store, provider, qqLogin: getQqLoginService(),
    invalidateSessions: invalidateAdminSessions, purgeRefreshJobs: (userId, ids) => accountRoutes.purgeUserJobs(userId, ids),
    purgeYybState: userId => yybRoutes.purgeUserState(userId) });
  registerAdminUserRoutes({
    app,
    requireAdminToken,
    requireAdminRole,
    requireDangerConfirmation,
    getAdminUserMutationError,
    deleteUserData,
    enforceUserAccess: () => userAccessMonitor.reconcile(),
    userStore,
    adminLogger,
    invalidateAdminSessions,
    updateAdminSessions,
  });
  registerAdminCurrentUserRoutes({
    app,
    requireAdminToken,
    requireAdminRole,
    userStore,
    store,
  });
  const yybRoutes = registerAdminYybRoutes({
    app,
    requireAdminToken,
    sendProviderError,
    getAccountsForUser,
    canAccessAccount,
    onProxyProfileChanged: async (profileId, apiBase) => {
      const normalized = value => String(value || '').replace(/\/+$/, '');
      if (normalized(apiBase) !== normalized(process.env.YYB_API_URL)) return;
      await Promise.all([provider.reloadProxyProfile(profileId), qqLogin.invalidateProxyProfile(profileId)]);
    },
  });
  const qqLogin = getQqLoginService();
  qqLogin.start();
  registerAdminQqLoginRoutes({ app, requireAdminToken, qqLogin, provider, addOrUpdateAccount, userStore });
  const stopQqLogin = () => qqLogin.close();
  process.once('exit', stopQqLogin);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      stopQqLogin();
      setTimeout(() => process.exit(0), 1800).unref();
    });
  }
  const accountRoutes = registerAdminAccountRoutes({
    app,
    provider,
    refreshJobStore: createRefreshJobStore(),
    broadcastLogSnapshot: accountId => realtime.refreshLogs(accountId),
    addOrUpdateAccount,
    findAccountByRef,
    getAccountsForUser,
    getAccountIdFromRequest,
    resolveAccountReference,
    canAccessAccount,
    getAccessibleAccountIdsFromRequest,
    userStore,
    sendProviderError,
  });
  const { createUserAccessMonitor } = require('../services/user-access-monitor');
  const userAccessMonitor = createUserAccessMonitor({
    userStore, provider, qqLogin, yybRoutes,
    cancelUserJobs: (userId, ids) => accountRoutes.cancelUserJobs(userId, ids),
    cleanupSessions: cleanupInvalidAdminSessions, logger: adminLogger,
  });
  userAccessMonitor.start();
  process.once('exit', () => userAccessMonitor.close());
  registerAdminFriendRoutes({ app, provider, store, getAccountIdFromRequest, canAccessAccount, sendProviderError });
  registerAdminDogRoutes({ app, provider, getAccountIdFromRequest, canAccessAccount, sendProviderError });
  registerAdminCareerRoutes({ app, provider, getAccountIdFromRequest, canAccessAccount, sendProviderError });
  registerAdminLoginLogRoutes({
    app,
    userStore,
    logger: adminLogger,
    requireAdminToken,
    requireAdminRole,
    requireDangerConfirmation,
  });
  registerSpaFallback(app, webDist);

  realtime = createAdminRealtime({
    provider, getIo: () => io, getSession: getAdminSession,
    getSessionRejection: adminSessionManager.getAdminSessionRejection,
    getAccessibleAccountIdsForUser, resolveAccountReference,
  });

  // 默认端口 3900：Windows 系统端口排除区间（Hyper-V/WSL NAT 保留 3002-3101）会拒绝 3007 监听（EACCES）
  const adminPort = CONFIG.adminPort || 3900;
  const server = app.listen(adminPort, "0.0.0.0", () => {
    adminLogger.info("admin panel started", {
      url: `http://localhost:${adminPort}`,
      port: adminPort,
    });
  });
  // listen 失败（端口被占用 / 被系统排除区间保留 / 权限不足）时给出可操作的提示并优雅退出，
  // 否则会以 unhandled 'error' event 直接抛栈崩溃（node:events:486），日志里毫无可读信息。
  server.on("error", (err) => {
    if (err && (err.code === "EADDRINUSE" || err.code === "EACCES")) {
      console.error("");
      console.error(`[AdminPanel] 端口 ${adminPort} 无法监听: ${err.code} (${err.message})`);
      console.error(`  可能原因：1) 该端口已被占用  2) 落在 Windows 端口排除区间（运行`);
      console.error(`  'netsh interface ipv4 show excludedportrange protocol=tcp' 可查看保留区间）`);
      console.error(`  解决办法：换一个端口后重试，例如：`);
      console.error(`    Windows PowerShell: $env:ADMIN_PORT=\"3901\"; pnpm dev:core`);
      console.error(`    Linux/macOS:        ADMIN_PORT=3901 pnpm dev:core`);
      console.error("");
    } else {
      console.error(`[AdminPanel] 端口 ${adminPort} 监听失败:`, err);
    }
    process.exit(1);
  });
  configureHttpServerTimeouts(server);
  trackHttpConnections(server);

  io = new SocketIOServer(server, {
    path: "/socket.io",
    transports: ["websocket", "polling"],
    pingInterval: 20000,
    pingTimeout: 10000,
    connectTimeout: 10000,
    maxHttpBufferSize: 256 * 1024,
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
      allowedHeaders: ["x-admin-token", "x-account-id"],
    },
  });
  io.use((socket, next) => {
    const token = getSocketHandshakeToken(socket);
    if (!token || !hasAdminToken(token)) {
      return next(new Error("Unauthorized"));
    }
    socket.data.adminToken = token;
    socket.data.user = getAdminSession(token);
    return next();
  });
  io.on("connection", (socket) => {
    const initialAccountId =
      (socket.handshake.auth && socket.handshake.auth.accountId) ||
      (socket.handshake.query && socket.handshake.query.accountId) ||
      "";
    realtime.subscribe(socket, initialAccountId);
    socket.emit("ready", { ok: true, ts: Date.now() });
    socket.on("subscribe", (payload) => {
      const safePayload = payload && typeof payload === "object" ? payload : {};
      realtime.subscribe(socket, safePayload.accountId || "");
    });
  });
}

module.exports = {
  startAdminServer,
  emitRealtimeStatus,
  emitRealtimeLog,
  emitRealtimeAccountLog,
};
