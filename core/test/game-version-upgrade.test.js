const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { DEFAULT_CLIENT_VERSION, DEFAULT_WX_CLIENT_VERSION, getDefaultSystemConfig } = require('../src/config/config');

test('upgrade migrates persisted legacy versions without changing accounts or custom overrides', (t) => {
    for (const version of ['1.13.0.4_20260723', '1.12.5.29_20260721', '1.15.0.1_20261001', '1.15.0.2_20261001', '', '1.16.0.1_custom']) {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-version-'));
        t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
        const original = {
            systemConfig: { serverUrl: 'wss://custom.invalid/ws', clientVersion: version, platform: 'wx', os: 'Windows' },
            marker: { untouched: true },
        };
        fs.writeFileSync(path.join(dataDir, 'store.json'), JSON.stringify(original));
        const accounts = JSON.stringify({ accounts: [{ id: 'account-A', code: 'offline-fixture' }] });
        fs.writeFileSync(path.join(dataDir, 'accounts.json'), accounts);
        const output = execFileSync(process.execPath, ['-e', `
            const store = require('./src/models/store');
            const config = require('./src/config/config');
            config.updateRuntimeConfig(store.getSystemConfig());
            process.stdout.write(JSON.stringify(config.getRuntimeConfig()));
        `], { cwd: path.join(__dirname, '..'), env: { ...process.env, FARM_DATA_DIR: dataDir }, encoding: 'utf8' });
        const expectedVersion = version.endsWith('_custom') ? version : DEFAULT_CLIENT_VERSION;
        assert.equal(JSON.parse(output).clientVersion, expectedVersion);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'))), {
            ...original, systemConfig: { ...original.systemConfig, clientVersion: expectedVersion, wxClientVersion: DEFAULT_WX_CLIENT_VERSION },
        });
        assert.equal(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'), accounts);
    }
    assert.equal(getDefaultSystemConfig().clientVersion, '1.15.1.4_20261001');
});

test('WeChat overrides survive old-panel saves and process restarts independently of QQ', t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-wx-version-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const options = { cwd: path.join(__dirname, '..'), env: { ...process.env, FARM_DATA_DIR: dataDir }, encoding: 'utf8' };
    execFileSync(process.execPath, ['-e', `
        const store = require('./src/models/store');
        store.setSystemConfig({ serverUrl: 'wss://custom.invalid', clientVersion: '1.14.0_qq', wxClientVersion: '1.16.0_wx' });
        store.setSystemConfig({ ...store.getSystemConfig(), clientVersion: '1.15.0_qq', wxClientVersion: undefined });
    `], options);
    const output = execFileSync(process.execPath, ['-e', `
        process.stdout.write(JSON.stringify(require('./src/models/store').getSystemConfig()));
    `], options);
    assert.equal(JSON.parse(output).clientVersion, '1.15.0_qq');
    assert.equal(JSON.parse(output).wxClientVersion, '1.16.0_wx');
});

test('public version reports the agreed application number with a valid package version', () => {
    const packages = ['../../package.json', '../package.json', '../../web/package.json'].map(file => require(file));
    for (const pkg of packages) {
        assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
        assert.equal(pkg.appVersion, '1.15.02.014');
    }
    const routes = new Map();
    require('../src/controllers/admin-public-info-routes').registerAdminPublicInfoRoutes({ app: { get: (url, handler) => routes.set(url, handler) } });
    let result;
    routes.get('/api/ping')({}, { json(value) { result = value; } });
    assert.equal(result.data.version, '1.15.02.014');
});

test('legacy farming configuration includes the new crops, items and mutations', () => {
    for (const [file, minimum] of [['Plant', 296], ['ItemInfo', 965], ['MutantEffect', 17]]) {
        const legacy = require(`../src/gameConfig/${file}.json`);
        const modern = require(`../src/modern/gameConfig/${file}.json`);
        assert.ok(legacy.length >= minimum);
        const ids = new Set(legacy.map(row => row.id));
        for (const row of modern) assert.ok(ids.has(row.id), `${file} missing ${row.id}`);
        assert.equal(ids.size, legacy.length);
    }
});
