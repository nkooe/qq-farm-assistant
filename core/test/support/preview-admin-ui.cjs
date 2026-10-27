// Disposable admin UI fixture. Uses real auth/config routes, never starts game workers.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-admin-preview-'));
process.env.FARM_DATA_DIR = dataDir;

const store = require('../../src/models/store');
const userStore = require('../../src/models/user-store');
const { createAdminSessionManager } = require('../../src/controllers/admin-session-manager');
const { createAdminRouteHelpers } = require('../../src/controllers/admin-route-helpers');
const { registerAdminAuthRoutes } = require('../../src/controllers/admin-auth-routes');
const { registerAdminCurrentUserRoutes } = require('../../src/controllers/admin-current-user-routes');
const { registerAdminSystemRoutes } = require('../../src/controllers/admin-system-routes');
const { registerAdminCardRoutes } = require('../../src/controllers/admin-card-routes');
const { registerAdminUserRoutes } = require('../../src/controllers/admin-user-routes');
const { registerAdminLoginLogRoutes } = require('../../src/controllers/admin-login-log-routes');
const app = express();
app.use(express.json());
// Keep the login page accessible for both admin and ordinary-user verification.
app.post('/api/auto-login', (_req, res) => res.status(403).json({ ok: false }));
const logger = { info() {}, warn() {}, error() {} };
const sessions = createAdminSessionManager({ logger });
const helpers = createAdminRouteHelpers({ userStore });
const config = { serverUrl: 'wss://example.invalid/ws', clientVersion: '1.15.0.2_20261001', platform: 'qq', os: 'iOS' };
const card = userStore.createCard('Disposable preview', 7, 'time');
userStore.registerUser('preview_user', 'Preview-Test-123', card.code);
registerAdminAuthRoutes({ app, logger, userStore, ...sessions });
registerAdminSystemRoutes({ app, store, logger, ...sessions, ...helpers,
    getDefaultSystemConfig: () => config, getRuntimeConfig: () => config,
    updateRuntimeConfig: () => {}, broadcastConfig: () => {} });
app.use('/api', sessions.requireAdminToken);
registerAdminCurrentUserRoutes({ app, store, userStore, ...sessions, ...helpers });
registerAdminCardRoutes({ app, userStore, adminLogger: logger, ...sessions, ...helpers });
registerAdminUserRoutes({ app, userStore, adminLogger: logger, ...sessions, ...helpers });
registerAdminLoginLogRoutes({ app, userStore, logger, ...sessions, ...helpers });
app.get('/api/auth/validate', (_req, res) => res.json({ ok: true }));
app.get('/api/ping', (_req, res) => res.json({ ok: true, data: { version: require('../../../package.json').appVersion } }));
app.get('/api/accounts', (_req, res) => res.json({ ok: true, data: { accounts: [] } }));
app.get('/api/settings', (_req, res) => res.json({ ok: true, data: { automation: {}, intervals: {}, ui: {} } }));
app.get(['/api/logs', '/api/account-logs'], (_req, res) => res.json({ ok: true, data: [] }));
app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: '此验证页面不执行真实游戏操作' }));
app.use(express.static(path.resolve(__dirname, '../../../web/dist')));
app.get('*', (_req, res) => res.sendFile(path.resolve(__dirname, '../../../web/dist/index.html')));
const server = app.listen(4192, '127.0.0.1', () => console.log('Disposable admin preview: http://127.0.0.1:4192/'));
let stopping = false;
function stop() {
    if (stopping) return;
    stopping = true;
    server.close(() => {
        fs.rmSync(dataDir, { recursive: true, force: true });
        process.exit(0);
    });
    server.closeAllConnections();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.setEncoding('utf8');
process.stdin.on('data', value => { if (value.trim() === 'stop') stop(); });
