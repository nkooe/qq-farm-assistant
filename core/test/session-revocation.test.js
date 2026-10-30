const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const userStore = require('../src/models/user-store');
const { createAdminSessionManager, SESSION_TTL_MS, MAX_USER_SESSIONS } = require('../src/controllers/admin-session-manager');
const { createAdminRouteHelpers } = require('../src/controllers/admin-route-helpers');
const { registerAdminAuthRoutes } = require('../src/controllers/admin-auth-routes');
const { registerAdminUserRoutes } = require('../src/controllers/admin-user-routes');
const { setAccessPolicy } = require('../src/models/access-policy');
const logger = { info() {}, warn() {}, error() {} };

for (const entry of ['change', 'recover', 'admin']) {
  test(`${entry} password change revokes all own HTTP and socket sessions and preserves another user`, async t => {
    setAccessPolicy({ cardVerificationEnabled: true });
    const card = userStore.createCard('fixture', 7);
    const user = userStore.registerUser(`reset_${entry}`, 'Fixture-Before-123', card.code).user;
    const otherCard = userStore.createCard('other fixture', 7);
    const other = userStore.registerUser(`other_${entry}`, 'Other-Fixture-123', otherCard.code).user;
    const sockets = new Map();
    const sessions = createAdminSessionManager({ logger, getUser: userStore.getUser, getIo: () => ({ sockets: { sockets } }) });
    const tokens = [sessions.createAdminSession(user), sessions.createAdminSession(user)];
    for (const token of tokens) sockets.set(token, { data: { adminToken: token }, disconnected: false, disconnect() { this.disconnected = true; } });
    const otherToken = sessions.createAdminSession(other);
    const adminToken = sessions.createAdminSession(userStore.getUser(1000));
    const app = express(); app.use(express.json());
    registerAdminAuthRoutes({ app, userStore, logger, ...sessions });
    app.use('/api', sessions.requireAdminToken);
    registerAdminUserRoutes({ app, userStore, adminLogger: logger, ...sessions, ...createAdminRouteHelpers({ userStore }) });
    app.get('/api/probe', (_req, res) => res.json({ ok: true }));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (url, token, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-token': token }, body: JSON.stringify(body) });
    if (entry === 'change') {
      const failed = await post('/api/user/change-password', tokens[0], { oldPassword: 'wrong', newPassword: 'Fixture-After-123' });
      assert.equal((await failed.json()).ok, false); assert.equal(sessions.hasToken(tokens[0]), true);
    }
    const response = entry === 'change'
      ? await post('/api/user/change-password', tokens[0], { oldPassword: 'Fixture-Before-123', newPassword: 'Fixture-After-123' })
      : entry === 'recover'
        ? await post('/api/public/reset-password/confirm', '', { username: user.username, cardCode: card.code, newPassword: 'Fixture-After-123' })
        : await post(`/api/admin/users/${user.id}/edit`, adminToken, { password: 'Fixture-After-123', confirmed: true });
    assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
    for (const token of tokens) {
      assert.equal(sessions.hasToken(token), false); assert.equal(sockets.get(token).disconnected, true);
      assert.equal((await fetch(base + '/api/probe', { headers: { 'x-admin-token': token } })).status, 401);
    }
    assert.equal(sessions.hasToken(otherToken), true); assert.equal(sessions.hasToken(adminToken), true);
    assert.equal(userStore.validateUser(user.username, 'Fixture-After-123', `fixture-${entry}`).id, user.id);
  });
}

test('session lifetime and per-user limit revoke live sockets without affecting another user', () => {
  let now = 1000;
  const a = { id: 1001, role: 'user' }, b = { id: 1002, role: 'user' };
  const users = new Map([[a.id, a], [b.id, b]]); const sockets = new Map();
  const sessions = createAdminSessionManager({ logger, getUser: id => users.get(id), now: () => now, getIo: () => ({ sockets: { sockets } }) });
  const first = sessions.createAdminSession(a);
  const socket = { data: { adminToken: first }, disconnected: false, disconnect() { this.disconnected = true; } }; sockets.set(first, socket);
  const other = sessions.createAdminSession(b);
  for (let i = 0; i < MAX_USER_SESSIONS; i++) sessions.createAdminSession(a);
  assert.equal(sessions.hasToken(first), false); assert.equal(socket.disconnected, true); assert.equal(sessions.hasToken(other), true);
  now += SESSION_TTL_MS - 1; assert.equal(sessions.hasToken(other), true);
  now++; assert.equal(sessions.getSession(other), null); assert.equal(sessions.hasToken(other), false);
});
