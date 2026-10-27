const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { createConfigStorage } = require('../src/models/store/config-storage');
const { readJsonFileStrict } = require('../src/services/json-db');

function fixture(t, initial) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-config-storage-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'store.json');
    if (initial !== undefined) fs.writeFileSync(file, JSON.stringify(initial));
    return { dir, file, storage: createConfigStorage(file) };
}

function run(dir, source, extraEnv = {}) {
    return execFileSync(process.execPath, ['-e', source], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8',
        env: { ...process.env, FARM_DATA_DIR: dir, FARM_ACCOUNT_ID: '', ...extraEnv },
    });
}

test('retired login settings are removed from disk while account and notification settings survive', t => {
    const { dir, file } = fixture(t, {
        marker: { untouched: true },
        captureConfig: { enabled: true, apiToken: 'retired-fixture-token' },
        accountConfigs: { 1: { preferredSeedId: 42 } },
        offlineReminder: { enabled: true, channel: 'webhook', endpoint: 'https://example.test', reloginUrlMode: 'qq_link' },
        userOfflineReminders: { alice: { channel: 'smtp', smtpHost: 'smtp.test', reloginUrlMode: 'qr_link' } },
    });
    run(dir, `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const store = require('./src/models/store');
        const migrated = JSON.parse(fs.readFileSync(process.env.FARM_DATA_DIR + '/store.json', 'utf8'));
        assert.deepEqual(migrated.marker, { untouched: true });
        assert.equal(migrated.captureConfig, undefined);
        const global = store.getOfflineReminder();
        const user = store.getOfflineReminder('alice');
        assert.equal(global.endpoint, 'https://example.test');
        assert.equal(global.reloginUrlMode, undefined);
        assert.equal(user.smtpHost, 'smtp.test');
        assert.equal(user.reloginUrlMode, undefined);
        assert.equal(store.getConfigSnapshot('1').preferredSeedId, 42);
        store.setOfflineReminder({ title: '新标题', reloginUrlMode: 'qq_link' });
        assert.equal(store.getOfflineReminder().title, '新标题');
        assert.equal(store.getOfflineReminder().reloginUrlMode, undefined);
    `);
    const persisted = readJsonFileStrict(file);
    assert.equal(persisted.captureConfig, undefined);
    assert.equal(persisted.offlineReminder.reloginUrlMode, undefined);
    assert.equal(persisted.userOfflineReminders.alice.reloginUrlMode, undefined);
});

test('migration backs up the original and preserves per-account and global fields across restart', t => {
    const initial = { marker: { untouched: true }, ui: { theme: 'light' }, accountConfigs: {
        1: { automation: { milk_tea: false }, preferredSeedId: 42 },
        2: { plantingStrategy: 'max_profit' },
    } };
    const { dir, file, storage } = fixture(t, initial);
    const before = fs.readFileSync(file, 'utf8');
    assert.deepEqual({ ...storage.load().accountConfigs }, initial.accountConfigs);
    const global = readJsonFileStrict(file);
    assert.equal(global.accountConfigs, undefined);
    assert.equal(global.accountConfigStorageVersion, 1);
    assert.deepEqual(global.marker, initial.marker);
    const backups = fs.readdirSync(dir).filter(name => name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), before);
    assert.deepEqual({ ...createConfigStorage(file).load().accountConfigs }, initial.accountConfigs);
    assert.equal(fs.readdirSync(dir).filter(name => name.endsWith('.bak')).length, 1);
});

test('one account save touches only that document and unchanged values skip disk writes', t => {
    const { dir, file, storage } = fixture(t, { accountConfigs: { 1: { seed: 1 }, 2: { seed: 2 } } });
    storage.load();
    const oldWrite = fs.writeFileSync;
    const writes = [];
    fs.writeFileSync = (target, ...args) => { writes.push(String(target)); return oldWrite(target, ...args); };
    try {
        storage.saveAccount('1', { seed: 3 });
        assert.equal(writes.length, 1);
        assert.ok(writes[0].startsWith(path.join(dir, 'account-configs', '1.json')));
        storage.saveAccount('1', { seed: 3 });
        assert.equal(writes.length, 1);
        const global = readJsonFileStrict(file);
        storage.saveGlobal(global);
        assert.equal(writes.length, 1);
        storage.saveGlobal({ ...global, theme: 'light' });
        assert.equal(writes.length, 2);
        assert.deepEqual(readJsonFileStrict(path.join(dir, 'account-configs', '2.json')), { seed: 2 });
    } finally { fs.writeFileSync = oldWrite; }
});

test('legacy IDs use reversible unique filenames without escaping the account directory', t => {
    const configs = Object.fromEntries(['1', '../escape', 'CON', 'A', 'a', '中文', '__proto__'].map(id => [id, { id }]));
    const { dir, file, storage } = fixture(t, { accountConfigs: configs });
    storage.load();
    assert.equal(fs.readdirSync(path.join(dir, 'account-configs')).length, 8);
    assert.deepEqual({ ...createConfigStorage(file).load().accountConfigs }, configs);
    assert.equal(fs.existsSync(path.join(dir, 'escape.json')), false);
});

test('workers read legacy data without migration, defaults writeback, or version writeback', t => {
    const initial = { captureConfig: { enabled: true }, offlineReminder: { reloginUrlMode: 'qr_link' }, systemConfig: { clientVersion: '1.15.0.2_20261001' }, accountConfigs: { 1: { preferredSeedId: 42 } } };
    const { dir, file } = fixture(t, initial);
    const before = fs.readFileSync(file, 'utf8');
    run(dir, `const s = require('./src/models/store'); s.applyConfigSnapshot({ preferredSeedId: 43, ui: { theme: 'light' } }, { accountId: '1', persist: false });`, { FARM_ACCOUNT_ID: '1' });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(dir), ['store.json']);
});

test('damaged configuration and missing split markers fail without overwriting the original', t => {
    const { dir, file, storage } = fixture(t);
    for (const raw of ['', '{broken', '[]', 'null']) {
        fs.writeFileSync(file, raw);
        assert.throws(() => storage.load(), { code: 'STORAGE_READ_FAILED' });
        assert.equal(fs.readFileSync(file, 'utf8'), raw);
    }
    fs.writeFileSync(file, JSON.stringify({ accountConfigStorageVersion: 1 }));
    assert.throws(() => storage.load(), { code: 'STORAGE_READ_FAILED' });
    fs.mkdirSync(path.join(dir, 'account-configs'));
    assert.throws(() => storage.load(), { code: 'STORAGE_READ_FAILED' });
});

test('a failed migration preserves the legacy source and a later attempt can recover', t => {
    const { file, storage } = fixture(t, { accountConfigs: { 1: { seed: 9 } } });
    const before = fs.readFileSync(file, 'utf8');
    const oldRename = fs.renameSync;
    fs.renameSync = (source, target) => {
        if (String(target).endsWith('account-configs')) throw Object.assign(new Error('disk failure'), { code: 'EIO' });
        return oldRename(source, target);
    };
    try { assert.throws(() => storage.load(), { code: 'STORAGE_MIGRATION_FAILED' }); }
    finally { fs.renameSync = oldRename; }
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(storage.load().accountConfigs['1'], { seed: 9 });
});

test('published account files win over stale aggregate data, which is backed up before cleanup', t => {
    const { dir, file, storage } = fixture(t, { accountConfigs: { 1: { seed: 1 } } });
    storage.load();
    storage.saveAccount('1', { seed: 2 });
    const stale = { ...readJsonFileStrict(file), accountConfigs: { 1: { seed: 0 } } };
    fs.writeFileSync(file, JSON.stringify(stale));
    assert.equal(createConfigStorage(file).load().accountConfigs['1'].seed, 2);
    assert.equal(readJsonFileStrict(file).accountConfigs, undefined);
    assert.equal(fs.readdirSync(dir).filter(name => name.endsWith('.bak')).length, 2);
});

test('stray copies are skipped, but a damaged recognized account document stops loading', t => {
    const { dir, file, storage } = fixture(t, { accountConfigs: { 1: { seed: 1 } } });
    storage.load();
    fs.writeFileSync(path.join(dir, 'account-configs', '1 - copy.json'), '{bad');
    assert.equal(createConfigStorage(file).load().accountConfigs['1'].seed, 1);
    fs.writeFileSync(path.join(dir, 'account-configs', '1.json'), '{bad');
    assert.throws(() => createConfigStorage(file).load(), { code: 'STORAGE_READ_FAILED' });
});

test('fresh stores create account files only when a config is saved and deletion survives restart', t => {
    const { dir, file, storage } = fixture(t);
    storage.load();
    assert.deepEqual(fs.readdirSync(dir), []);
    storage.saveGlobal({ ui: { theme: 'light' } });
    assert.equal(fs.existsSync(path.join(dir, 'account-configs')), false);
    storage.saveAccount('1', { seed: 3 });
    assert.equal(readJsonFileStrict(file).accountConfigStorageVersion, 1);
    storage.removeAccount('1');
    assert.equal(Object.keys(createConfigStorage(file).load().accountConfigs).length, 0);
});

test('failed account/global saves preserve memory, disk, revision, and worker broadcasts', t => {
    const { dir } = fixture(t);
    run(dir, `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const store = require('./src/models/store');
        const { createDataProvider } = require('./src/runtime/data-provider');
        (async () => {
            store.addOrUpdateAccount({ name: 'fixture', code: 'fixture', autoStart: false });
            store.setSystemConfig({ clientVersion: 'custom-qq', wxClientVersion: 'custom-wx' });
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
                assert.throws(() => store.setSystemConfig({ clientVersion: 'changed' }), { code: 'STORAGE_WRITE_FAILED' });
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
        const result = store.addOrUpdateAccount({ name: 'original', loginType: 'yyb', provider: 'thirdparty', thirdparty: { apiBase: 'https://fixture.invalid', apiToken: 'secret', openid: 'fixture' } });
        result.accounts[0].name = 'mutated';
        const snapshot = store.getAccounts(); snapshot.accounts[0].thirdparty.apiToken = 'mutated';
        assert.equal(store.getAccounts().accounts[0].name, 'original');
        assert.equal(store.getAccounts().accounts[0].thirdparty.apiToken, 'secret');
        const oldRead = fs.readFileSync; let reads = 0;
        fs.readFileSync = (...args) => { reads++; return oldRead(...args); };
        try { store.getAccounts(); store.getAccountsByUser('any'); assert.equal(reads, 0); }
        finally { fs.readFileSync = oldRead; }
        const oldRename = fs.renameSync;
        fs.renameSync = () => { throw Object.assign(new Error('disk failure'), { code: 'EIO' }); };
        try { assert.throws(() => store.addOrUpdateAccount({ id: '1', name: 'changed' }), { code: 'STORAGE_WRITE_FAILED' }); }
        finally { fs.renameSync = oldRename; }
        assert.equal(store.getAccounts().accounts[0].name, 'original');
        fs.writeFileSync(process.env.FARM_DATA_DIR + '/accounts.json', JSON.stringify({ accounts: [{ id: '2', name: 'external' }] }));
        assert.equal(store.getAccounts().accounts[0].name, 'original');
        assert.equal(store.loadAccounts().accounts[0].name, 'external');
    `);
});

test('malformed account lists fail explicitly and remain intact', t => {
    const { dir } = fixture(t);
    run(dir, `
        const assert = require('node:assert/strict'); const fs = require('node:fs');
        const store = require('./src/models/store'); const file = process.env.FARM_DATA_DIR + '/accounts.json';
        for (const raw of ['{broken', '[]', 'null', '{"accounts":{}}']) {
            fs.writeFileSync(file, raw);
            assert.throws(() => store.loadAccounts(), { code: 'STORAGE_READ_FAILED' });
            assert.equal(fs.readFileSync(file, 'utf8'), raw);
        }
    `);
});
