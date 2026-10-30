const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isUserIdentity, parseUserId } = require('../src/models/user-id');
const { setAccessPolicy } = require('../src/models/access-policy');
let users = require('../src/models/user-store');
const store = require('../src/models/store');

test('1000 is the only admin; allocation survives reload and never reuses deleted IDs', () => {
  setAccessPolicy({ cardVerificationEnabled: false });
  assert.equal(users.getUser(1000).username, 'admin');
  assert.equal(users.getUser(1000).role, 'admin');
  const first = users.registerUser('id_first', 'Fixture-Test-123').user;
  const second = users.registerUser('id_second', 'Fixture-Test-123').user;
  assert.deepEqual([first.id, second.id], [1001, 1002]);
  assert.equal(users.validateUser('id_first', 'Fixture-Test-123', 'fixture').id, 1001);
  assert.equal(users.beginUserDeletion(1000).ok, false);
  assert.equal(users.deleteUser(1000, true).ok, false);
  assert.equal(users.beginUserDeletion(first.id).ok, true);
  assert.equal(users.deleteUser(first.id).ok, true);
  delete require.cache[require.resolve('../src/models/user-store')];
  users = require('../src/models/user-store');
  assert.equal(users.registerUser('id_third', 'Fixture-Test-123').user.id, 1003);
  assert.equal(users.registerUser('ID_FIRST', 'Fixture-Test-123').ok, false);
  assert.throws(() => users.getUser('id_second'));
  assert.throws(() => users.getUser('1002'));
});

test('identity parsing rejects role forgery and malformed ID aliases', () => {
  for (const value of [999, -1000, 1000.5, NaN, Infinity, '1000', null]) {
    assert.equal(isUserIdentity({ id: value, role: 'admin' }), false);
  }
  assert.equal(isUserIdentity({ id: 1000, role: 'user' }), false);
  assert.equal(isUserIdentity({ id: 1001, role: 'admin' }), false);
  assert.equal(isUserIdentity({ id: 1001, role: 'user' }), true);
  for (const value of ['01000', '1000x', '+1000', '1e3', ' 1000', '999', '9007199254740992']) assert.throws(() => parseUserId(value));
  assert.equal(parseUserId('1000'), 1000);
});

test('all user settings and farm ownership remain independent and delete by ID', () => {
  const a = 1002, b = 1003;
  for (const id of [a, b]) {
    store.setUITheme(id === a ? 'dark' : 'light', id);
    store.setOfflineReminder({ smtpPass: `fixture-${id}` }, id);
    store.setUserDeviceProtocol({ enabled: true, deviceId: `fixture-${id}` }, id);
    store.setUserWxConfig({ apiKey: `fixture-${id}`, apiBase: 'https://fixture.invalid' }, id);
    store.setUserDefaultAccountPlan(id, { preferredSeedId: id });
  }
  assert.deepEqual(store.getUI(a), { theme: 'dark' });
  assert.deepEqual(store.getUI(b), { theme: 'light' });
  assert.equal(store.getOfflineReminder(a).smtpPass, `fixture-${a}`);
  assert.equal(store.getUserDeviceProtocol(b).deviceId, `fixture-${b}`);
  assert.equal(store.getUserWxConfig(a).apiKey, `fixture-${a}`);
  const account = store.addOrUpdateAccount({ userId: a, autoStart: false }).accounts.at(-1);
  assert.throws(() => store.addOrUpdateAccount({ id: account.id, userId: b }));
  assert.throws(() => store.applyUserDefaultAccountPlan(b, account.id));
  assert.throws(() => store.addOrUpdateAccount({ username: 'id_second' }));
  assert.throws(() => store.getOfflineReminder());
  assert.throws(() => store.setUITheme('dark', '1002'));
  store.deleteUserConfig(a);
  assert.equal(store.getOfflineReminder(a).smtpPass, '');
  assert.equal(store.getUserWxConfig(a).apiKey, '');
  assert.equal(store.getUserDeviceProtocol(a).deviceId, '');
  assert.equal(store.getUserDefaultAccountPlan(a).exists, false);
  assert.equal(store.getUserWxConfig(b).apiKey, `fixture-${b}`);
});

test('user login settings retain runtime fields and discard unsupported options on save and reload', () => {
  const expected = store.setUserWxConfig({
    enabled: true, apiBase: 'https://fixture.invalid', apiKey: 'fixture-private',
    proxyApiUrl: 'https://proxy.invalid', appId: 'fixture-app',
    autoReconnect: false, reconnectDelayMin: 7, reconnectMaxAttempts: 2,
    autoAddAccount: false,
  }, 1003);
  assert.equal(Object.hasOwn(expected, 'autoAddAccount'), false);
  assert.equal(expected.apiKey, 'fixture-private');
  assert.equal(expected.autoReconnect, false);
  assert.equal(expected.reconnectDelayMin, 7);
  assert.equal(expected.reconnectMaxAttempts, 2);
  const filename = path.join(process.env.FARM_DATA_DIR, 'store.json');
  const persisted = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.deepEqual(persisted.userWxConfigs['1003'], expected);
  persisted.userWxConfigs['1003'].autoAddAccount = false;
  fs.writeFileSync(filename, JSON.stringify(persisted));
  delete require.cache[require.resolve('../src/models/store')];
  const reloaded = require('../src/models/store');
  assert.deepEqual(reloaded.getUserWxConfig(1003), expected);
  reloaded.setUITheme('dark', 1003);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(filename, 'utf8')).userWxConfigs['1003'], 'autoAddAccount'), false);
});

test('old username-based user storage is rejected without migration or rewriting', () => {
  const file = path.join(process.env.FARM_DATA_DIR, 'users.json');
  const original = fs.readFileSync(file);
  const old = JSON.stringify({ schemaVersion: 2, users: [], retiredUsernames: [] });
  fs.writeFileSync(file, old);
  try {
    assert.throws(() => users.getAllUsers(), error => error.code === 'STORAGE_READ_FAILED' && /Unsupported user schema/.test(error.cause?.message));
    assert.equal(fs.readFileSync(file, 'utf8'), old);
  } finally { fs.writeFileSync(file, original); }
});
