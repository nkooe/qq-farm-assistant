const test = require('node:test');
const assert = require('node:assert/strict');
const userStore = require('../src/models/user-store');

test('an unredeemed card is reserved after claim and never issued to a second client', () => {
  userStore.createCard('single fixture', 7);
  userStore.setCardClaimStatus(true);
  const first = userStore.claimCard('fixture-browser-a', '192.0.2.1');
  assert.equal(first.ok, true);
  const second = userStore.claimCard('fixture-browser-b', '192.0.2.2');
  assert.equal(second.ok, false);
  assert.equal(userStore.getAvailableTimeCardCount(), 0);
});

test('changing browser headers cannot claim more cards from the same source address', () => {
  userStore.createCardsBatch('rate fixture', 1, 3);
  const first = userStore.claimCard('fixture-browser-c', '192.0.2.3');
  assert.equal(first.ok, true);
  const second = userStore.claimCard('fixture-browser-d', '192.0.2.3');
  assert.equal(second.ok, false);
  assert.ok(second.remainingMs > 0);
});

test('claims use the most recent record rather than the first historical one', () => {
  userStore.createCardsBatch('history fixture', 1, 3);
  const fs = require('node:fs');
  const { getDataFile } = require('../src/config/runtime-paths');
  const file = getDataFile('card-claim.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const hash = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
  data.records.push({ uaHash: hash('fixture-history'), ipHash: hash('192.0.2.9'), claimTime: Date.now() - 2 * 86400000, cardCode: 'old-fixture', userId: null });
  fs.writeFileSync(file, JSON.stringify(data));
  assert.equal(userStore.claimCard('fixture-history', '192.0.2.9').ok, true);
  assert.equal(userStore.claimCard('fixture-history', '192.0.2.9').ok, false);
});

test('different source addresses using the same browser version have independent claim allowances', () => {
  userStore.createCardsBatch('same browser fixture', 1, 2);
  assert.equal(userStore.claimCard('common-browser-version', '192.0.2.70').ok, true);
  assert.equal(userStore.claimCard('common-browser-version', '192.0.2.71').ok, true);
});

test('claimed credentials stay reserved after thirty days and bind to the registering user', () => {
  const { setAccessPolicy } = require('../src/models/access-policy');
  const fs = require('node:fs');
  const { getDataFile } = require('../src/config/runtime-paths');
  userStore.createCard('retained claim fixture', 1);
  const claim = userStore.claimCard('fixture-old-claim', '192.0.2.25');
  assert.equal(claim.ok, true);
  const file = getDataFile('card-claim.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.records.find(record => record.cardCode === claim.cardCode).claimTime = Date.now() - 31 * 86400000;
  fs.writeFileSync(file, JSON.stringify(data));
  userStore.clearExpiredClaimRecords();
  assert.ok(userStore.getCardClaimRecords().some(record => record.cardCode === claim.cardCode));
  assert.ok(userStore.getAllCards().find(card => card.code === claim.cardCode).claimedAt);
  setAccessPolicy({ cardVerificationEnabled: true });
  const user = userStore.registerUser('bound_claim_fixture', 'Fixture-Test-123', claim.cardCode).user;
  assert.equal(userStore.getCardClaimRecords().find(record => record.cardCode === claim.cardCode).userId, user.id);
});

test('claim switches and request sources use strict types', () => {
  assert.throws(() => userStore.setCardClaimStatus('false'), /布尔/);
  assert.equal(userStore.claimCard({}, '192.0.2.31').ok, false);
  assert.equal(userStore.claimCard('browser', 'unknown').ok, false);
});
