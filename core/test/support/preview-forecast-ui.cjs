// Isolated visual fixture: no game connections, user database or production services.
const express = require('express');
const path = require('node:path');
const app = express();
app.use(express.json());
const accounts = [
    { id: 'forecast-A', name: '作物预测', connected: true },
    { id: 'forecast-B', name: '离线账号', connected: false },
    { id: 'forecast-C', name: '历史混合预测', connected: true },
    { id: 'forecast-D', name: '暂停自动农场', connected: true },
].map(a => ({ ...a, running: a.connected, platform: 'wx', runtimeState: a.connected ? 'online' : 'stopped' }));
app.post('/api/auto-login', (_req, res) => res.json({ ok: true, data: { token: 'forecast-visual-fixture' } }));
app.get('/api/auth/validate', (_req, res) => res.json({ ok: true }));
app.get('/api/ping', (_req, res) => res.json({ ok: true, data: { version: require('../../../package.json').appVersion } }));
app.get('/api/user/me', (_req, res) => res.json({ ok: true, data: { username: '界面验证', role: 'admin', accountLimit: 4 } }));
app.get('/api/accounts', (_req, res) => res.json({ ok: true, data: { accounts } }));
app.get('/api/status', (req, res) => {
    const account = accounts.find(a => a.id === req.get('x-account-id')) || accounts[0];
    const generatedAt = Date.now();
    res.json({ ok: true, data: { connection: { connected: account.connected },
        status: { name: account.name, level: 35, gold: 123456, coupon: 100, goldBean: 456, exp: 32000, platform: 'wx' },
        uptime: 7200, sessionElapsedSeconds: 3600, sessionExpGained: 1800, operations: { harvest: 12, helpWater: 8 },
        levelProgress: { current: 1000, needed: 3000 }, automation: { farm: account.id !== 'forecast-D', friend: true },
        nextChecks: { farmRemainSec: 20, helpRemainSec: 30, stealRemainSec: 40 },
        levelForecast: { generatedAt, estimatedAt: generatedAt + 48 * 60000, remainingExp: 2000,
            scheduledExp: 2400, plotCount: 12, source: account.id === 'forecast-C' ? 'mixed' : 'planted', automatic: account.id !== 'forecast-D' } } });
});
app.get('/api/settings', (_req, res) => res.json({ ok: true, data: { automation: { farm: true, friend: true }, intervals: {}, ui: {} } }));
app.get(['/api/logs', '/api/account-logs', '/api/bag', '/api/daily-gifts'], (_req, res) => res.json({ ok: true, data: [] }));
app.use('/api', (_req, res) => res.json({ ok: false, error: '此验证页面不执行真实操作' }));
app.use(express.static(path.resolve(__dirname, '../../../web/dist')));
app.get('*', (_req, res) => res.sendFile(path.resolve(__dirname, '../../../web/dist/index.html')));
const server = app.listen(4191, '127.0.0.1', () => console.log('Forecast fixture: http://127.0.0.1:4191/'));
process.on('SIGTERM', () => server.close());
