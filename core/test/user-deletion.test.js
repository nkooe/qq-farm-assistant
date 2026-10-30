const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const userStore = require('../src/models/user-store');
const store = require('../src/models/store');
const { createUserDeletion } = require('../src/services/user-deletion');
const { createAdminSessionManager } = require('../src/controllers/admin-session-manager');
const { getUserAccessRejection } = require('../src/models/access-policy');
const { createModuleLogger } = require('../src/services/logger');
const directory = process.env.FARM_DATA_DIR;
const logger = { info() {}, warn() {}, error() {} };
const ids = new Map();
function register(username) {
  const card = userStore.createCard('fixture', 1);
  const result = userStore.registerUser(username, 'Fixture-Test-123', card.code);
  assert.equal(result.ok, true); ids.set(username, result.user.id);
  return result.user.id;
}

test('duplicate names include case variants, remain reserved after deletion, and cannot be renamed', async () => {
  register('duplicate');
  for (const username of ['duplicate', 'DUPLICATE']) assert.equal(userStore.registerUser(username, 'Fixture-Test-123').ok, false);
  assert.equal(userStore.editUser(ids.get('duplicate'), { newUsername: 'another' }).ok, false);
  const remove = createUserDeletion({ userStore, store, provider: { async removeUserData() {} }, qqLogin: { async purgeUser() {} },
    invalidateSessions() {}, async purgeRefreshJobs() {}, async purgeYyb() {} });
  await remove(ids.get('duplicate'));
  for (const username of ['duplicate', 'DUPLICATE']) assert.match(userStore.registerUser(username, 'Fixture-Test-123').error, /永久停用/);
  delete require.cache[require.resolve('../src/models/user-store')];
  const reloaded = require('../src/models/user-store');
  assert.match(reloaded.registerUser('Duplicate', 'Fixture-Test-123').error, /永久停用/);
});

test('deletion revokes identity first, waits for tasks, clears all owned records and files, and preserves the other user', async () => {
  register('alice'); register('bob');
  const a = store.addOrUpdateAccount({ userId: ids.get('alice'), name: 'Alice farm', code: 'fixture', autoStart: false }).accounts.at(-1);
  const b = store.addOrUpdateAccount({ userId: ids.get('bob'), name: 'Bob farm', code: 'fixture', autoStart: false }).accounts.at(-1);
  for (const account of [a, b]) {
    store.applyConfigSnapshot({ preferredSeedId: 42 }, { accountId: account.id });
    store.setOfflineReminder({ recipientEmail: `${account.userId}@example.test` }, account.userId);
    store.setUserDefaultAccountPlan(account.userId, { preferredSeedId: 42 });
    store.setKnownFriendGids(account.id, [9]); store.writeFriendListCache(account.id, [{ gid: 9 }]);
    require('../src/services/friend-pet-cache').record(9, 90021, account.id);
    const digest = crypto.createHash('sha256').update(account.id).digest('hex');
    fs.mkdirSync(path.join(directory, 'stats'), { recursive: true });
    fs.writeFileSync(path.join(directory, `stats/${account.id}.json`), '{}');
    fs.writeFileSync(path.join(directory, `activity-center-state-${digest}.json`), '{}');
    userStore.addLoginLog('success', userStore.getUser(account.userId).username, null, '192.0.2.1', 'fixture');
    createModuleLogger('deletion-fixture').info('owned log', { userId: account.userId, accountId: account.id });
  }
  const sessions = createAdminSessionManager({ logger, getUser: userStore.getUser });
  const tokenA = sessions.createAdminSession(userStore.getUser(ids.get('alice')));
  const tokenB = sessions.createAdminSession(userStore.getUser(ids.get('bob')));
  let finish, stopped = false, nativePurged = false;
  const pending = new Promise(resolve => { finish = resolve; });
  const remove = createUserDeletion({ userStore, store, invalidateSessions: sessions.invalidateAdminSessions,
    purgeRefreshJobs: async () => pending,
    provider: { async removeUserData(username) { assert.equal(username, ids.get('alice')); assert.equal(userStore.getUser(username).deleting, true); await pending; stopped = true; } },
    qqLogin: { async purgeUser() { assert.equal(stopped, true); nativePurged = true; } },
    async purgeYyb() { assert.equal(nativePurged, true); },
  });
  const deleting = remove(ids.get('alice')); assert.equal(remove(ids.get('alice')), deleting);
  assert.equal(sessions.hasToken(tokenA), false); assert.equal(sessions.hasToken(tokenB), true);
  assert.equal(getUserAccessRejection(userStore.getUser(ids.get('alice'))).reason, 'banned');
  assert.equal(store.getAccountsByUser(ids.get('alice')).accounts.length, 1);
  finish(); await deleting;
  assert.equal(userStore.getUser(ids.get('alice')), null); assert.ok(userStore.getUser(ids.get('bob')));
  assert.equal(store.getAccountsByUser(ids.get('alice')).accounts.length, 0);
  assert.equal(store.getAccountsByUser(ids.get('bob')).accounts.length, 1);
  assert.deepEqual(userStore.getLoginLogs().logs.map(log => log.username), ['bob']);
  assert.equal(userStore.getAllCards().some(card => card.usedBy === ids.get('alice')), false);
  assert.equal(userStore.getCardClaimRecords().some(record => record.userId === ids.get('alice')), false);
  for (const file of fs.readdirSync(directory, { recursive: true })) {
    const target = path.join(directory, file); if (!fs.statSync(target).isFile()) continue;
    if (file === 'users.json') continue; // Only the name reservation survives.
    const text = fs.readFileSync(target, 'utf8'); assert.doesNotMatch(text, /alice|Alice farm/);
  }
  for (const subdir of ['account-configs', 'stats', 'known_friend_gids', 'friend_list_cache']) {
    assert.equal(fs.existsSync(path.join(directory, subdir, `${a.id}.json`)), false);
    assert.equal(fs.existsSync(path.join(directory, subdir, `${b.id}.json`)), true);
  }
  const logs = fs.readdirSync(process.env.FARM_LOG_DIR).filter(file => file.endsWith('.log')).map(file => fs.readFileSync(path.join(process.env.FARM_LOG_DIR, file), 'utf8')).join('');
  assert.doesNotMatch(logs, /alice/); assert.match(logs, new RegExp(String(ids.get('bob'))));
  assert.equal(store.getUserDefaultAccountPlan(ids.get('alice')).exists, false);
  assert.equal(store.getUserDefaultAccountPlan(ids.get('bob')).exists, true);
  const next = store.addOrUpdateAccount({ userId: ids.get('bob'), code: 'fixture' }).accounts.at(-1);
  assert.ok(Number(next.id) > Number(b.id));
});

test('failed cleanup leaves the user disabled, rejects registration and retries the same deletion', async () => {
  register('retry_user'); let fail = true;
  const remove = createUserDeletion({ userStore, store, invalidateSessions() {}, async purgeRefreshJobs() {},
    provider: { async removeUserData() {} }, qqLogin: { async purgeUser() {} },
    async purgeYyb() { if (fail) throw new Error('fixture cleanup failure'); },
  });
  await assert.rejects(remove(ids.get('retry_user')), /fixture cleanup failure/);
  assert.equal(userStore.getUser(ids.get('retry_user')).deleting, true);
  assert.equal(getUserAccessRejection(userStore.getUser(ids.get('retry_user'))).reason, 'banned');
  assert.equal(userStore.registerUser('retry_user', 'Fixture-Test-123').ok, false);
  fail = false; await remove(ids.get('retry_user')); assert.equal(userStore.getUser(ids.get('retry_user')), null);
});

test('single and expired-user HTTP deletion routes await complete cleanup and preserve active users', async t => {
  const express = require('express');
  const { once } = require('node:events');
  const { registerAdminUserRoutes } = require('../src/controllers/admin-user-routes');
  const { createAdminRouteHelpers } = require('../src/controllers/admin-route-helpers');
  for (const username of ['route_single', 'route_expired', 'route_active']) {
    register(username);
    store.addOrUpdateAccount({ userId: ids.get(username), name: username, autoStart: false });
  }
  const removed = [];
  const sessions = createAdminSessionManager({ logger, getUser: userStore.getUser });
  const token = sessions.createAdminSession(userStore.getUser(1000));
  const remove = createUserDeletion({ userStore, store, invalidateSessions: sessions.invalidateAdminSessions,
    async purgeRefreshJobs() {}, provider: { async removeUserData() {} }, qqLogin: { async purgeUser() {} },
    async purgeYyb(username) { await new Promise(resolve => setImmediate(resolve)); removed.push(username); },
  });
  const app = express(); app.use(express.json());
  registerAdminUserRoutes({ app, userStore: { ...userStore, getExpiredUserIds: () => [ids.get('route_expired')] }, adminLogger: logger,
    ...sessions, ...createAdminRouteHelpers({ userStore }), deleteUserData: remove });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [method, url] of [['DELETE', `/api/admin/users/${ids.get('route_single')}`], ['POST', '/api/admin/users/clear-expired']]) {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'x-admin-token': token }, body: JSON.stringify({ confirmed: true }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
  }
  assert.deepEqual(removed, [ids.get('route_single'), ids.get('route_expired')]);
  for (const username of removed) {
    assert.equal(userStore.getUser(username), null);
    assert.equal(store.getAccountsByUser(username).accounts.length, 0);
  }
  assert.ok(userStore.getUser(ids.get('route_active')));
  assert.equal(store.getAccountsByUser(ids.get('route_active')).accounts.length, 1);
});
