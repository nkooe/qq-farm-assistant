const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    OFFICIAL_SHA256,
    OFFICIAL_VERSION,
    TSDK_BUILDS,
    TsdkRuntime,
} = require('../src/utils/tsdk-runtime');

function createRuntime(name) {
    return new TsdkRuntime({
        accountId: name,
        dataDir: fs.mkdtempSync(path.join(os.tmpdir(), `qq-farm-${name}-`)),
    });
}

test('loads and validates the matching official WASM', async (t) => {
    const runtime = createRuntime('load');
    t.after(() => runtime.destroy());
    await runtime.init();
    const status = runtime.getStatus();
    assert.equal(status.ready, true);
    assert.equal(status.version, OFFICIAL_VERSION);
    assert.equal(status.wasmSha256, OFFICIAL_SHA256);
    assert.equal(status.wasmPath, path.resolve(runtime.wasmPath));
    assert.equal(runtime.gameId, 3167);
    assert.equal(runtime.appKey, '0');
    assert.equal(runtime.getResult().length, 64);
});

test('encrypt/decrypt roundtrip and token generation', async (t) => {
    const runtime = createRuntime('crypto');
    t.after(() => runtime.destroy());
    await runtime.init();

    const plain = Buffer.from('qq-farm-tsdk-offline-roundtrip');
    const encrypted = runtime.encrypt(plain);
    assert.notDeepEqual(encrypted, plain);
    assert.deepEqual(runtime.decrypt(encrypted), plain);

    const first = runtime.generateToken(Buffer.from('request-sequence-1'));
    const second = runtime.generateToken(Buffer.from('request-sequence-2'));
    assert.ok(first.token.length > 0);
    assert.ok(second.token.length > 0);
    assert.notEqual(first.token, second.token);
});

test('heartbeat produces typed ACE data and instances remain isolated', async (t) => {
    const first = createRuntime('isolation-a');
    const second = createRuntime('isolation-b');
    t.after(() => {
        first.destroy();
        second.destroy();
    });
    await Promise.all([first.init(), second.init()]);

    first.heartbeatTick();
    const data = first.getDataToServer();
    assert.ok(Buffer.isBuffer(data));
    assert.ok(data.length > 0);
    assert.equal(first.getStatus().heartbeatTicks, 1);
    assert.equal(second.getStatus().heartbeatTicks, 0);
});

test('official wrapper lifecycle hooks update runtime metrics', async (t) => {
    const runtime = createRuntime('lifecycle');
    t.after(() => runtime.destroy());
    await runtime.init();

    runtime.processReceivedData();
    runtime.sendStatus();
    runtime.detectSpeedHack(30000);
    runtime.checkFunctionArray([runtime.getDataToServer], 0);
    assert.equal(runtime.bindUser('test-open-id'), true);
    assert.match(runtime.getEncryptedInitInfo(), /^[a-z0-9+/]+=*$/i);

    const status = runtime.getStatus();
    assert.equal(status.processTicks, 1);
    assert.equal(status.statusReports, 1);
    assert.equal(status.functionChecks, 1);
    assert.equal(status.userBound, true);
});

test('rejects wrong WASM versions and use after destroy', async () => {
    const wrong = new TsdkRuntime({
        accountId: 'bad-wasm',
        wasmPath: path.join(__dirname, '../src/utils/tsdk-legacy.wasm'),
        dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-bad-wasm-')),
    });
    await assert.rejects(wrong.init(), /checksum mismatch/);

    const runtime = createRuntime('destroy');
    await runtime.init();
    runtime.destroy();
    assert.throws(() => runtime.generateToken(Buffer.from('x')), /not ready/);
});

test('WeChat uses its own verified WASM and preserves account isolation', async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-wx-tsdk-'));
    const runtime = new TsdkRuntime({ platform: 'wechat', accountId: 'wx-offline', dataDir });
    t.after(() => { runtime.destroy(); fs.rmSync(dataDir, { recursive: true, force: true }); });
    await runtime.init();
    assert.equal(runtime.appId, 'wx5306c5978fdb76e4');
    assert.equal(runtime.getStatus().version, TSDK_BUILDS.wx.version);
    assert.equal(runtime.getStatus().wasmSha256, TSDK_BUILDS.wx.sha256);
    const plain = Buffer.from('wechat-platform-roundtrip');
    assert.deepEqual(runtime.decrypt(runtime.encrypt(plain)), plain);
    runtime.bindUser('offline-wx-open-id');
    assert.ok(runtime.getEncryptedInitInfo().length > 0);
    runtime.heartbeatTick();
    assert.ok(Buffer.isBuffer(runtime.getDataToServer()));
    assert.throws(() => runtime.resolveDataPath('../outside'), /escaped/);
});
