const test = require('node:test');
const assert = require('node:assert/strict');
const userStore = require('../src/models/user-store');
const { setAccessPolicy } = require('../src/models/access-policy');

test('a publicly supplied renewal card never becomes a password recovery credential', () => {
  setAccessPolicy({ cardVerificationEnabled: true });
  const registration = userStore.createCard('registration fixture', 7);
  const user = userStore.registerUser('card_victim', 'Original-Password-123', registration.code).user;
  const renewal = userStore.createCard('untrusted renewal fixture', 7);
  assert.equal(userStore.renewUser(user.id, renewal.code).ok, true);
  assert.equal(userStore.verifyCardOwnership(user.username, renewal.code).ok, false);
  assert.equal(userStore.resetPasswordByCard(user.username, renewal.code, 'Replacement-Password-123').ok, false);
  assert.equal(userStore.validateUser(user.username, 'Original-Password-123', 'binding-fixture').id, user.id);
  assert.equal(userStore.resetPasswordByCard(user.username, registration.code, 'Legitimate-Password-123').ok, true);
});

test('an administrator or a user registered without a card cannot acquire card-based recovery through renewal', () => {
  setAccessPolicy({ cardVerificationEnabled: false });
  const free = userStore.registerUser('no_recovery_card', 'Original-Password-123').user;
  for (const user of [userStore.getUser(1000), free]) {
    const card = userStore.createCard('later renewal fixture', 7);
    assert.equal(userStore.renewUser(user.id, card.code).ok, true);
    assert.equal(userStore.resetPasswordByCard(user.username, card.code, 'Replacement-Password-123').ok, false);
  }
});

test('public renewal requires the owner password, works while expired and never exposes the registration credential', async t => {
  const express = require('express');
  const { once } = require('node:events');
  const { registerAdminAuthRoutes } = require('../src/controllers/admin-auth-routes');
  const { createAdminSessionManager } = require('../src/controllers/admin-session-manager');
  setAccessPolicy({ cardVerificationEnabled: true });
  const registration = userStore.createCard('original private card', 7);
  const user = userStore.registerUser('public_renew_fixture', 'Original-Password-123', registration.code).user;
  userStore.updateUser(user.id, { expiresAt: 1 });
  const renewal = userStore.createCard('renewal card', 7);
  const logger = { info() {}, warn() {}, error() {} };
  const sessions = createAdminSessionManager({ logger, getUser: userStore.getUser });
  const app = express(); app.use(express.json());
  registerAdminAuthRoutes({ app, userStore, logger, ...sessions });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const body = { username: user.username, cardCode: renewal.code };
  assert.equal((await post('/api/public/renew', body)).status, 400);
  assert.equal((await post('/api/public/renew', { ...body, password: 'wrong' })).status, 401);
  assert.equal(userStore.getAllCards().find(card => card.code === renewal.code).usedBy, null);
  const response = await post('/api/public/renew', { ...body, password: 'Original-Password-123' });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true); assert.ok(result.data.card.expiresAt > Date.now());
  assert.doesNotMatch(JSON.stringify(result), new RegExp(registration.code));
  assert.equal('code' in result.data.card, false);
  assert.equal((await post('/api/public/reset-password/confirm', { ...body, newPassword: 'Untrusted-Password-123' })).status, 400);
});
