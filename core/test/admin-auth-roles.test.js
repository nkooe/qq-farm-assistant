const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-auth-roles-'));
process.env.FARM_DATA_DIR = dataDir;

const userStore = require('../src/models/user-store');
const { createAdminSessionManager } = require('../src/controllers/admin-session-manager');
const { createAdminRouteHelpers } = require('../src/controllers/admin-route-helpers');
const { createAdminAccountAccess } = require('../src/controllers/admin-account-access');
const { registerAdminAuthRoutes } = require('../src/controllers/admin-auth-routes');
const { registerAdminCurrentUserRoutes } = require('../src/controllers/admin-current-user-routes');
const { registerAdminAccountRoutes } = require('../src/controllers/admin-account-routes');
const { registerAdminCardRoutes } = require('../src/controllers/admin-card-routes');
const { registerAdminUserRoutes } = require('../src/controllers/admin-user-routes');
const { registerAdminSystemRoutes } = require('../src/controllers/admin-system-routes');
const { getAccessPolicy, setAccessPolicy, getUserAccessRejection } = require('../src/models/access-policy');
const logger = { info() {}, warn() {}, error() {} };
const accounts = [
  { id: '1', username: 'alice', name: 'Alice farm' },
  { id: '2', username: 'bob', name: 'Bob farm' },
];
const provider = { getAccounts: () => ({ accounts }) };
const store = require('../src/models/store');
const sessions = createAdminSessionManager({ logger });
const helpers = createAdminRouteHelpers({ userStore });
const access = createAdminAccountAccess({ store, getProvider: () => provider });
let server;
let baseUrl;

test.before(async () => {
  const app = express();
  app.use(express.json());
  registerAdminAuthRoutes({ app, logger, userStore, ...sessions });
  app.use('/api', sessions.requireAdminToken);
  registerAdminCurrentUserRoutes({ app, store, userStore, ...sessions, ...helpers });
  registerAdminAccountRoutes({ app, provider, userStore, ...access, ...helpers });
  registerAdminCardRoutes({ app, userStore, adminLogger: logger, ...sessions, ...helpers });
  registerAdminUserRoutes({ app, userStore, adminLogger: logger, ...sessions, ...helpers });
  registerAdminSystemRoutes({ app, store, logger, ...sessions, ...helpers });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function request(route, { token, body } = {}) {
  return fetch(`${baseUrl}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-admin-token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

async function login(username, password) {
  const res = await request('/api/login', { body: { username, password } });
  assert.equal(res.status, 200);
  return (await res.json()).data;
}

test('initial administrator uses the same login and ordinary account APIs with admin permissions', async () => {
  const user = await login('admin', 'admin');
  assert.equal(user.role, 'admin');
  assert.equal(user.card, null);
  const me = await request('/api/user/me', { token: user.token });
  assert.equal((await me.json()).data.role, 'admin');
  const farms = await request('/api/accounts', { token: user.token });
  assert.deepEqual((await farms.json()).data.accounts.map(a => a.id), ['1', '2']);
  const cards = await request('/api/admin/cards', { token: user.token });
  assert.equal(cards.status, 200);
  assert.equal((await cards.json()).ok, true);
  const users = await request('/api/admin/users', { token: user.token });
  const listed = (await users.json()).data;
  assert.equal(listed.find(u => u.username === 'admin').role, 'admin');
  assert.ok(listed.every(u => !('password' in u)));
});

test('first registered user stays ordinary and cannot call administrator APIs', async () => {
  const card = userStore.createCard('Registration test', 1, 'time');
  const register = await request('/api/register', {
    body: { username: 'alice', password: 'Alice-Test-123', cardCode: card.code, role: 'admin' },
  });
  assert.equal(register.status, 200);
  assert.equal((await register.json()).data.role, 'user');
  const user = await login('alice', 'Alice-Test-123');
  assert.equal(user.role, 'user');
  const farms = await request('/api/accounts', { token: user.token });
  assert.deepEqual((await farms.json()).data.accounts.map(a => a.id), ['1']);
  const cards = await request('/api/admin/cards', { token: user.token });
  assert.equal(cards.status, 403);
  const users = await request('/api/admin/users', { token: user.token });
  assert.equal(users.status, 403);
});

test('authentication requires a stored user with an explicitly supported role', () => {
  assert.equal(userStore.validateUser('not_in_database', 'Unknown-Test-123', 'test-missing').error, 'invalid_credentials');
  const file = path.join(dataDir, 'users.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const admin = data.users.find(u => u.username === 'admin');
  data.users.push({ ...admin, username: 'legacy_owner', role: 'super_admin' });
  fs.writeFileSync(file, JSON.stringify(data));
  assert.equal(userStore.validateUser('legacy_owner', 'admin', 'test-legacy').error, 'invalid_credentials');
  assert.ok(userStore.getAllUsers().some(u => u.username === 'legacy_owner'));
});

test('removed privileged routes have no handlers even for a normal administrator', async () => {
  const { token } = await login('admin', 'admin');
  for (const [route, body] of [
    ['/api/admin/users-with-password'],
    ['/api/super-admin/clear-data', { confirmed: true }],
    ['/api/super-admin/anti-resale-config'],
    ['/api/super-admin/check-account-limit', {}],
    ['/api/super-admin/announcement', {}],
    ['/api/super-admin-announcement'],
    ['/api/super-admin-announcement/verify', {}],
  ]) {
    const res = await request(route, { token, body });
    assert.equal(res.status, 404, route);
    await res.text();
  }
});

function responseStub() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('unsupported roles cannot create a session or receive administrator privileges', () => {
  for (const role of ['super_admin', 'owner', undefined]) {
    assert.throws(() => sessions.createAdminSession({ username: 'legacy', role }), /无效的用户角色/);
    const res = responseStub();
    helpers.requireAdminRole({ currentUser: { username: 'legacy', role } }, res, () => assert.fail('role admitted'));
    assert.equal(res.statusCode, 403);
    assert.equal(access.canAccessAccount({ currentUser: { username: 'legacy', role } }, '2'), false);
  }
});

test('invalidated roles lose HTTP sessions and connected sockets', () => {
  let disconnected = 0;
  const socket = { data: {}, disconnect: () => { disconnected++; } };
  const manager = createAdminSessionManager({
    logger,
    getIo: () => ({ sockets: { sockets: new Map([['socket', socket]]) } }),
  });
  const user = { username: 'legacy', role: 'user' };
  const token = manager.createAdminSession(user);
  socket.data.adminToken = token;
  user.role = 'super_admin';
  const res = responseStub();
  manager.requireAdminToken({ headers: { 'x-admin-token': token } }, res, () => assert.fail('session admitted'));
  assert.equal(res.statusCode, 403);
  assert.equal(manager.hasToken(token), false);
  assert.equal(disconnected, 1);
});

test('session cleanup preserves admins and revokes expired, disabled and unsupported users', () => {
  const manager = createAdminSessionManager({ logger });
  const adminToken = manager.createAdminSession({ username: 'admin', role: 'admin', card: { enabled: false, expiresAt: 1 } });
  const expiredToken = manager.createAdminSession({ username: 'expired', role: 'user', card: { enabled: true, expiresAt: 1 } });
  const bannedToken = manager.createAdminSession({ username: 'banned', role: 'user', card: { enabled: false } });
  const legacy = { username: 'legacy', role: 'user' };
  const legacyToken = manager.createAdminSession(legacy);
  legacy.role = 'super_admin';
  manager.cleanupInvalidAdminSessions();
  assert.equal(manager.hasToken(adminToken), true);
  assert.equal(manager.hasToken(expiredToken), false);
  assert.equal(manager.hasToken(bannedToken), false);
  assert.equal(manager.hasToken(legacyToken), false);
});

test('card verification defaults to enabled and only admins can change it after confirmation', async () => {
  assert.deepEqual(getAccessPolicy(), { cardVerificationEnabled: true });
  const publicConfig = await request('/api/public/access-policy');
  assert.equal(publicConfig.status, 200);
  assert.equal((await publicConfig.json()).data.cardVerificationEnabled, true);
  const { token: admin } = await login('admin', 'admin');
  const { token: alice } = await login('alice', 'Alice-Test-123');
  assert.equal((await request('/api/admin/access-policy', { token: alice, body: { cardVerificationEnabled: false, confirmed: true } })).status, 403);
  assert.equal((await request('/api/admin/access-policy', { token: admin, body: { cardVerificationEnabled: false } })).status, 400);
  assert.equal((await request('/api/admin/access-policy', { token: admin, body: { cardVerificationEnabled: 'false', confirmed: true } })).status, 400);
  assert.equal(getAccessPolicy().cardVerificationEnabled, true);
  const register = await request('/api/register', { body: { username: 'no_card', password: 'Test-Password-123' } });
  assert.equal(register.status, 400);
});

test('disabled verification permits free registration, retains quotas and bans, and re-enabling revokes unactivated sessions', async (t) => {
  t.after(() => {
    setAccessPolicy({ cardVerificationEnabled: true });
    userStore.updateUser('alice', { enabled: true, expiresAt: Date.now() + 86400000 });
  });
  const { token: admin } = await login('admin', 'admin');
  const spareCard = userStore.createCard('Keep unused', 3);
  const disabled = await request('/api/admin/access-policy', { token: admin, body: { cardVerificationEnabled: false, confirmed: true } });
  assert.equal(disabled.status, 200);
  assert.equal(getAccessPolicy().cardVerificationEnabled, false);
  const register = await request('/api/register', { body: { username: 'free_user', password: 'Test-Password-123', cardCode: spareCard.code } });
  assert.equal(register.status, 200);
  const freeUser = (await register.json()).data;
  assert.equal(freeUser.card, null);
  assert.equal(freeUser.accountLimit, 2);
  assert.equal(userStore.getAllCards().find(c => c.code === spareCard.code).usedBy, null);
  const { token: freeToken } = await login('free_user', 'Test-Password-123');
  assert.equal((await request('/api/user/me', { token: freeToken })).status, 200);
  userStore.updateUser('alice', { expiresAt: 1 });
  assert.equal((await login('alice', 'Alice-Test-123')).cardVerificationEnabled, false);
  assert.equal(userStore.clearExpiredUsers().ok, false);
  userStore.updateUser('alice', { enabled: false });
  const banned = await request('/api/login', { body: { username: 'alice', password: 'Alice-Test-123' } });
  assert.equal(banned.status, 403);
  assert.equal((await banned.json()).errorType, 'banned');
  // Toggling a ban on an unactivated user must not manufacture a permanent entitlement.
  userStore.updateUser('free_user', { enabled: false });
  userStore.updateUser('free_user', { enabled: true });
  const enabled = await request('/api/admin/access-policy', { token: admin, body: { cardVerificationEnabled: true, confirmed: true } });
  assert.equal(enabled.status, 200);
  assert.equal(sessions.hasToken(freeToken), false);
  const rejected = await request('/api/login', { body: { username: 'free_user', password: 'Test-Password-123' } });
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json()).errorType, 'card_required');
  assert.equal(getUserAccessRejection({ role: 'user', card: { enabled: true } }).reason, 'card_required');
  assert.equal(getUserAccessRejection({ role: 'user', card: { enabled: true, isPermanent: true } }), null);
  const renewed = await request('/api/public/renew', { body: { username: 'free_user', cardCode: spareCard.code } });
  assert.equal(renewed.status, 200);
  assert.equal((await login('free_user', 'Test-Password-123')).role, 'user');
  assert.equal((await request('/api/admin/cards', { token: admin })).status, 200);
});

test('damaged access policy fails closed and saved policy is read after module reload', () => {
  const file = path.join(dataDir, 'access-policy.json');
  fs.writeFileSync(file, '{invalid');
  assert.equal(getAccessPolicy().cardVerificationEnabled, true);
  setAccessPolicy({ cardVerificationEnabled: false });
  delete require.cache[require.resolve('../src/models/access-policy')];
  assert.equal(require('../src/models/access-policy').getAccessPolicy().cardVerificationEnabled, false);
  setAccessPolicy({ cardVerificationEnabled: true });
});

test('announcements default off, require admin configuration and track reads by exact published revision', async () => {
  assert.equal(store.getAnnouncement().enabled, false);
  const { token: admin } = await login('admin', 'admin');
  const { token: alice } = await login('alice', 'Alice-Test-123');
  const body = { enabled: true, title: '维护通知', content: '第一行\n第二行 <script>literal</script>', showOnce: true, confirmed: true };
  assert.equal((await request('/api/admin/announcement', { token: alice, body })).status, 403);
  assert.equal((await request('/api/admin/announcement', { token: admin, body: { ...body, content: '' } })).status, 400);
  const publish = await request('/api/admin/announcement', { token: admin, body });
  assert.equal(publish.status, 200);
  const first = (await publish.json()).data;
  assert.equal(first.enabled, true);
  const read = await request('/api/announcement', { token: alice });
  assert.equal((await read.json()).data.shouldShow, true);
  await request('/api/announcement/read', { token: alice, body: { updatedAt: first.updatedAt } });
  assert.equal(store.shouldShowAnnouncement('alice'), false);
  const samePublish = await request('/api/admin/announcement', { token: admin, body });
  assert.equal((await samePublish.json()).data.updatedAt, first.updatedAt);
  const update = await request('/api/admin/announcement', { token: admin, body: { ...body, content: '新版内容' } });
  const second = (await update.json()).data;
  assert.ok(second.updatedAt > first.updatedAt);
  await request('/api/announcement/read', { token: alice, body: { updatedAt: first.updatedAt } });
  assert.equal(store.shouldShowAnnouncement('alice'), true);
  await request('/api/admin/announcement', { token: admin, body: { ...body, enabled: false } });
  assert.equal(store.shouldShowAnnouncement('alice'), false);
  assert.equal(store.getAnnouncement().content, body.content);
  await request('/api/admin/announcement', { token: admin, body: { ...body, showOnce: false } });
  store.markAnnouncementRead('alice');
  assert.equal(store.shouldShowAnnouncement('alice'), true);
  delete require.cache[require.resolve('../src/models/store')];
  const reloadedStore = require('../src/models/store');
  assert.equal(reloadedStore.getAnnouncement().enabled, true);
  assert.equal(reloadedStore.getAnnouncement().content, body.content);
});
