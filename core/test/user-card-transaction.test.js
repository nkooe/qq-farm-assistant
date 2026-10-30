const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const userStore = require('../src/models/user-store');
const { getDataFile } = require('../src/config/runtime-paths');
const { setAccessPolicy } = require('../src/models/access-policy');

function failRename(t, filename, action) {
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.basename(to) === filename) throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' });
    return rename(from, to);
  });
  try { assert.throws(action, /失败|fixture disk failure/); }
  finally { mock.mock.restore(); }
}

test('failed registration does not consume a card or skip a user ID', t => {
  setAccessPolicy({ cardVerificationEnabled: true });
  const card = userStore.createCard('registration fault fixture', 7);
  const before = JSON.parse(fs.readFileSync(getDataFile('users.json')));
  failRename(t, 'users.json', () => userStore.registerUser('fault_register', 'Fixture-Test-123', card.code));
  assert.equal(userStore.getAllCards().find(item => item.code === card.code).usedBy, null);
  assert.equal(userStore.getUserByUsername('fault_register'), null);
  const after = JSON.parse(fs.readFileSync(getDataFile('users.json')));
  assert.equal(after.nextUserId, before.nextUserId);
  assert.equal(userStore.registerUser('fault_register', 'Fixture-Test-123', card.code).ok, true);
});

test('failed renewal cannot grant quota twice when the same card is retried', t => {
  setAccessPolicy({ cardVerificationEnabled: false });
  const user = userStore.registerUser('fault_renew', 'Fixture-Test-123').user;
  const card = userStore.createCard('quota fault fixture', 3, 'quota', { value: 3 });
  failRename(t, 'cards.json', () => userStore.renewUser(user.id, card.code));
  assert.equal(userStore.getUser(user.id).accountLimit, 2);
  assert.equal(userStore.getAllCards().find(item => item.code === card.code).usedBy, null);
  assert.equal(userStore.renewUser(user.id, card.code).ok, true);
  assert.equal(userStore.getUser(user.id).accountLimit, 5);
  assert.equal(userStore.renewUser(user.id, card.code).ok, false);
});

test('a failed claim never publishes or reserves half a card transaction', t => {
  userStore.createCard('claim failure fixture', 7);
  userStore.setCardClaimStatus(true);
  const beforeCards = fs.readFileSync(getDataFile('cards.json'), 'utf8');
  const beforeClaims = fs.readFileSync(getDataFile('card-claim.json'), 'utf8');
  failRename(t, 'card-claim.json', () => userStore.claimCard('fault-claim-browser', '192.0.2.55'));
  assert.equal(fs.readFileSync(getDataFile('cards.json'), 'utf8'), beforeCards);
  assert.equal(fs.readFileSync(getDataFile('card-claim.json'), 'utf8'), beforeClaims);
  assert.equal(userStore.claimCard('fault-claim-browser', '192.0.2.55').ok, true);
});

test('an interrupted registration is rolled back before any identity data is served', () => {
  const { spawnSync } = require('node:child_process');
  setAccessPolicy({ cardVerificationEnabled: true });
  const card = userStore.createCard('crash fixture', 7);
  const files = ['users.json', 'cards.json', 'card-claim.json'];
  const before = files.map(name => fs.readFileSync(getDataFile(name), 'utf8'));
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    const store = require('./src/models/user-store');
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      rename(from, to);
      if (path.basename(to) === 'users.json') process.exit(86);
    };
    store.registerUser('crashed_register', 'Fixture-Test-123', process.env.FIXTURE_CARD);
  `], { cwd: path.join(__dirname, '..'), env: { ...process.env, FIXTURE_CARD: card.code }, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 86, child.stderr);
  assert.equal(fs.existsSync(getDataFile('.identity-transaction.json')), true);
  assert.equal(userStore.getUserByUsername('crashed_register'), null);
  files.forEach((name, i) => assert.equal(fs.readFileSync(getDataFile(name), 'utf8'), before[i]));
  assert.equal(fs.existsSync(getDataFile('.identity-transaction.json')), false);
  assert.equal(userStore.registerUser('crashed_register', 'Fixture-Test-123', card.code).ok, true);
});

test('rollback failures keep the journal and block reads until recovery succeeds', t => {
  setAccessPolicy({ cardVerificationEnabled: false });
  const user = userStore.registerUser('rollback_fixture', 'Fixture-Test-123').user;
  const card = userStore.createCard('rollback quota', 3, 'quota', { value: 3 });
  const rename = fs.renameSync;
  let userWrites = 0;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.basename(to) === 'cards.json' || (path.basename(to) === 'users.json' && ++userWrites > 1)) {
      throw new Error('fixture rollback disk failure');
    }
    return rename(from, to);
  });
  try {
    assert.throws(() => userStore.renewUser(user.id, card.code), /恢复失败/);
    assert.equal(fs.existsSync(getDataFile('.identity-transaction.json')), true);
    assert.throws(() => userStore.getUser(user.id), /fixture rollback disk failure/);
  } finally { mock.mock.restore(); }
  assert.equal(userStore.getUser(user.id).accountLimit, 2);
  assert.equal(fs.existsSync(getDataFile('.identity-transaction.json')), false);
  assert.equal(userStore.renewUser(user.id, card.code).ok, true);
});
