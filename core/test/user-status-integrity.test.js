const test = require('node:test');
const assert = require('node:assert/strict');
const userStore = require('../src/models/user-store');
const { getUserAccessRejection, setAccessPolicy } = require('../src/models/access-policy');

test('setting an expiry on a permanent user actually revokes permanent access', () => {
  setAccessPolicy({ cardVerificationEnabled: true });
  const card = userStore.createCard('permanent fixture', -1);
  const user = userStore.registerUser('permanent_fixture', 'Fixture-Test-123', card.code).user;
  userStore.updateUser(user.id, { expiresAt: Date.now() - 1 });
  assert.equal(getUserAccessRejection(userStore.getUser(user.id))?.reason, 'expired');
});

test('editing a user rejects invalid quota and expiry without persisting any part of the edit', () => {
  setAccessPolicy({ cardVerificationEnabled: false });
  const user = userStore.registerUser('invalid_edit_fixture', 'Fixture-Test-123').user;
  const before = userStore.getUser(user.id);
  const fs = require('node:fs');
  const file = require('../src/config/runtime-paths').getDataFile('users.json');
  const originalFile = fs.readFileSync(file, 'utf8');
  for (const patch of [{ accountLimit: -1 }, { accountLimit: '5junk' }, { accountLimit: 0 }, { accountLimit: 1.5 }, { expiresAt: 'not-a-date' }, { isPermanent: 'false' }, { enabled: 'false' }, { expiresAt: 8.64e15 + 1 }]) {
    const result = userStore.editUser(user.id, { password: 'New-Fixture-123', ...patch });
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.deepEqual(userStore.getUser(user.id), before);
    assert.equal(fs.readFileSync(file, 'utf8'), originalFile);
  }
});

test('expiry cancellation clears all permanent flags and invalid credentials return validation errors', () => {
  setAccessPolicy({ cardVerificationEnabled: true });
  const card = userStore.createCard('cancel permanent fixture', -1);
  const user = userStore.registerUser('cancel_permanent', 'Fixture-Test-123', card.code).user;
  userStore.updateUser(user.id, { expiresAt: null });
  assert.equal(getUserAccessRejection(userStore.getUser(user.id)).reason, 'card_required');
  assert.throws(() => userStore.updateUser(user.id, { enabled: 'false' }), /布尔/);
  assert.equal(userStore.editUser(user.id, { password: {} }).ok, false);
  assert.equal(userStore.registerUser(['object_user'], 'Fixture-Test-123', card.code).ok, false);
  assert.equal(userStore.registerUser('object_password', {}, card.code).ok, false);
});

test('administrator user lists expose registration time and authoritative access status', () => {
  const fs = require('node:fs');
  const file = require('../src/config/runtime-paths').getDataFile('users.json');
  setAccessPolicy({ cardVerificationEnabled: false });
  const user = userStore.registerUser('list_status_fixture', 'Fixture-Test-123').user;
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8')).users.find(item => item.id === user.id);
  let listed = userStore.getUser(user.id);
  assert.equal(listed.createdAt, persisted.createdAt);
  assert.equal(listed.accessStatus, 'normal');
  assert.equal('password' in listed, false);
  setAccessPolicy({ cardVerificationEnabled: true });
  assert.equal(userStore.getUser(user.id).accessStatus, 'card_required');
  userStore.updateUser(user.id, { expiresAt: 1 });
  assert.equal(userStore.getUser(user.id).accessStatus, 'expired');
  userStore.updateUser(user.id, { enabled: false });
  assert.equal(userStore.getUser(user.id).accessStatus, 'banned');
  userStore.beginUserDeletion(user.id);
  assert.equal(userStore.getUser(user.id).accessStatus, 'deleting');
  assert.equal(userStore.getUser(1000).accessStatus, 'normal');
});
