const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { DEFAULT_CLIENT_VERSION, DEFAULT_WX_CLIENT_VERSION, getDefaultSystemConfig } = require('../src/config/config');

test('complete current system settings survive restart and missing fields are rejected', t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-version-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const options = { cwd: path.join(__dirname, '..'), env: { ...process.env, FARM_DATA_DIR: dataDir }, encoding: 'utf8' };
    execFileSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const store = require('./src/models/store');
      const config = { ...store.getSystemConfig(), clientVersion: 'custom-qq', wxClientVersion: 'custom-wx' };
      store.setSystemConfig(config);
      assert.throws(() => store.setSystemConfig({ ...config, wxClientVersion: undefined }), /完整/);
      assert.deepEqual(store.getSystemConfig(), config);
    `], options);
    const saved = JSON.parse(execFileSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require('./src/models/store').getSystemConfig()));`], options));
    assert.equal(saved.clientVersion, 'custom-qq'); assert.equal(saved.wxClientVersion, 'custom-wx');
    assert.equal(getDefaultSystemConfig().clientVersion, DEFAULT_CLIENT_VERSION);
    assert.equal(getDefaultSystemConfig().wxClientVersion, DEFAULT_WX_CLIENT_VERSION);
});

test('public version reports the agreed application number with a valid package version', () => {
    const packages = ['../../package.json', '../package.json', '../../web/package.json'].map(file => require(file));
    for (const pkg of packages) {
        assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
        assert.equal(pkg.appVersion, '1.15.02.016');
    }
    const routes = new Map();
    require('../src/controllers/admin-public-info-routes').registerAdminPublicInfoRoutes({ app: { get: (url, handler) => routes.set(url, handler) } });
    let result;
    routes.get('/api/ping')({}, { json(value) { result = value; } });
    assert.equal(result.data.version, '1.15.02.016');
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
