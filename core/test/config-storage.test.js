const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createConfigStorage, FORMAT_VERSION } = require('../src/models/store/config-storage');
const { readJsonFileStrict } = require('../src/services/json-db');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-config-storage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'store.json');
  return { dir, file, storage: createConfigStorage(file) };
}
function run(dir, source, extraEnv = {}) {
  return execFileSync(process.execPath, ['-e', source], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8',
    env: { ...process.env, FARM_DATA_DIR: dir, FARM_ACCOUNT_ID: '', ...extraEnv },
  });
}

test('fresh storage persists only the current split format and reopens without migration', t => {
  const { dir, file, storage } = fixture(t);
  storage.load(); storage.saveGlobal({ userUis: { 1000: { theme: 'light' } } });
  storage.saveAccount('1', { preferredSeedId: 42 }); storage.saveAccount('2', { seed: 7 });
  const loaded = createConfigStorage(file).load();
  assert.equal(loaded.accountConfigStorageVersion, FORMAT_VERSION);
  assert.equal(loaded.accountConfigs['1'].preferredSeedId, 42);
  assert.equal(loaded.userUis[1000].theme, 'light');
  assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.bak')), false);
  assert.equal(readJsonFileStrict(file).accountConfigs, undefined);
  storage.removeAccount('1');
  assert.equal(createConfigStorage(file).load().accountConfigs['1'], undefined);
});

test('legacy formats and retired settings are rejected without rewriting the source', t => {
  const { file, storage } = fixture(t); storage.load();
  for (const document of [
    { accountConfigs: {} }, { accountConfigStorageVersion: 1 },
    { accountConfigStorageVersion: FORMAT_VERSION, captureConfig: {} },
    { accountConfigStorageVersion: FORMAT_VERSION, userOfflineReminders: { 1000: { reloginUrlMode: 'qr' } } },
    ...['ui', 'offlineReminder', 'globalWxConfig', 'deviceProtocol', 'adminPasswordHash'].map(field => ({ accountConfigStorageVersion: FORMAT_VERSION, [field]: {} })),
  ]) {
    const original = JSON.stringify(document); fs.writeFileSync(file, original);
    assert.throws(() => createConfigStorage(file).load(), { code: 'STORAGE_READ_FAILED' });
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
});

test('damaged documents and missing format marker fail explicitly', t => {
  const { dir, file, storage } = fixture(t); storage.load();
  const original = fs.readFileSync(file, 'utf8');
  for (const raw of ['', '{broken', '[]', 'null']) {
    fs.writeFileSync(file, raw);
    assert.throws(() => storage.load(), { code: 'STORAGE_READ_FAILED' });
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  }
  fs.writeFileSync(file, original);
  fs.unlinkSync(path.join(dir, 'account-configs', '.format.json'));
  assert.throws(() => storage.load(), { code: 'STORAGE_READ_FAILED' });
});

test('one account write leaves other accounts untouched and unchanged documents skip writes', t => {
  const { dir, file, storage } = fixture(t); storage.load();
  storage.saveAccount('1', { seed: 1 }); storage.saveAccount('2', { seed: 2 });
  const oldWrite = fs.writeFileSync, writes = [];
  fs.writeFileSync = (target, ...args) => { writes.push(String(target)); return oldWrite(target, ...args); };
  try {
    storage.saveAccount('1', { seed: 3 }); storage.saveAccount('1', { seed: 3 });
    storage.saveGlobal(readJsonFileStrict(file));
    assert.equal(writes.length, 1);
    assert.deepEqual(readJsonFileStrict(path.join(dir, 'account-configs', '2.json')), { seed: 2 });
  } finally { fs.writeFileSync = oldWrite; }
});

test('account filenames are reversible, case-distinct and stay inside their directory', t => {
  const { dir, file, storage } = fixture(t); storage.load();
  for (const id of ['1', '../escape', 'CON', 'A', 'a', '中文', '__proto__']) storage.saveAccount(id, { id });
  const loaded = createConfigStorage(file).load().accountConfigs;
  for (const id of Object.keys(loaded)) assert.equal(loaded[id].id, id);
  assert.equal(Object.keys(loaded).length, 7);
  assert.equal(fs.existsSync(path.join(dir, 'escape.json')), false);
});

test('unrecognized files and corrupt account data are errors rather than skipped records', t => {
  const { dir, file, storage } = fixture(t); storage.load();
  const stray = path.join(dir, 'account-configs', '1 - copy.json'); fs.writeFileSync(stray, '{}');
  assert.throws(() => storage.load(), { code: 'STORAGE_READ_FAILED' }); fs.unlinkSync(stray);
  fs.writeFileSync(path.join(dir, 'account-configs', '1.json'), '{broken');
  assert.throws(() => createConfigStorage(file).load(), { code: 'STORAGE_READ_FAILED' });
});

test('failed account/global saves preserve memory, disk, revision, and worker broadcasts', t => {
    const { dir } = fixture(t);
    run(dir, `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const store = require('./src/models/store');
        const { createDataProvider } = require('./src/runtime/data-provider');
        (async () => {
            store.addOrUpdateAccount({ userId: 1000, name: 'fixture', code: 'fixture', autoStart: false });
            store.setSystemConfig({ ...store.getSystemConfig(), clientVersion: 'custom-qq', wxClientVersion: 'custom-wx' });
            const before = store.getConfigSnapshot('1');
            const system = store.getSystemConfig();
            const originalRename = fs.renameSync;
            let revisions = 0, broadcasts = 0;
            const provider = createDataProvider({ store, getAccounts: store.getAccounts,
                nextConfigRevision: () => ++revisions, broadcastConfigToWorkers: () => ++broadcasts });
            fs.renameSync = () => { throw Object.assign(new Error('disk failure'), { code: 'EIO' }); };
            try {
                await assert.rejects(provider.saveSettings('1', { plantingStrategy: 'max_profit' }), { code: 'STORAGE_WRITE_FAILED' });
                assert.deepEqual(store.getConfigSnapshot('1'), before);
                assert.throws(() => store.setSystemConfig({ ...system, clientVersion: 'changed' }), { code: 'STORAGE_WRITE_FAILED' });
                assert.deepEqual(store.getSystemConfig(), system);
                assert.equal(revisions, 0); assert.equal(broadcasts, 0);
            } finally { fs.renameSync = originalRename; }
        })().catch(error => { console.error(error); process.exitCode = 1; });
    `);
});

test('accounts cache returns isolated snapshots and updates only after a successful save', t => {
    const { dir } = fixture(t);
    run(dir, `
        const assert = require('node:assert/strict'); const fs = require('node:fs');
        const store = require('./src/models/store');
        const result = store.addOrUpdateAccount({ userId: 1000, name: 'original', loginType: 'yyb', provider: 'thirdparty', thirdparty: { apiBase: 'https://fixture.invalid', apiToken: 'secret', openid: 'fixture' } });
        result.accounts[0].name = 'mutated';
        const snapshot = store.getAccounts(); snapshot.accounts[0].thirdparty.apiToken = 'mutated';
        assert.equal(store.getAccounts().accounts[0].name, 'original');
        assert.equal(store.getAccounts().accounts[0].thirdparty.apiToken, 'secret');
        const oldRead = fs.readFileSync; let reads = 0;
        fs.readFileSync = (...args) => { reads++; return oldRead(...args); };
        try { store.getAccounts(); store.getAccountsByUser(1001); assert.equal(reads, 0); }
        finally { fs.readFileSync = oldRead; }
        const oldRename = fs.renameSync;
        fs.renameSync = () => { throw Object.assign(new Error('disk failure'), { code: 'EIO' }); };
        try { assert.throws(() => store.addOrUpdateAccount({ id: '1', name: 'changed' }), { code: 'STORAGE_WRITE_FAILED' }); }
        finally { fs.renameSync = oldRename; }
        assert.equal(store.getAccounts().accounts[0].name, 'original');
        fs.writeFileSync(process.env.FARM_DATA_DIR + '/accounts.json', JSON.stringify({ schemaVersion: 3, nextId: 3, accounts: [{ id: '2', userId: 1000, autoStart: false, name: 'external' }] }));
        assert.equal(store.getAccounts().accounts[0].name, 'original');
        assert.equal(store.loadAccounts().accounts[0].name, 'external');
    `);
});

test('malformed account lists fail explicitly and remain intact', t => {
    const { dir } = fixture(t);
    run(dir, `
        const assert = require('node:assert/strict'); const fs = require('node:fs');
        const store = require('./src/models/store'); const file = process.env.FARM_DATA_DIR + '/accounts.json';
        for (const raw of ['{broken', '[]', 'null', '{"accounts":{}}', '{"accounts":[],"nextId":1}', '{"schemaVersion":2,"accounts":[{"id":"1","autoStart":true}],"nextId":2}']) {
            fs.writeFileSync(file, raw);
            assert.throws(() => store.loadAccounts(), { code: 'STORAGE_READ_FAILED' });
            assert.equal(fs.readFileSync(file, 'utf8'), raw);
        }
    `);
});
