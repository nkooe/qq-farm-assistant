const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-default-plan-'));
process.env.FARM_DATA_DIR = dataDir;

const store = require('../src/models/store');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('offline reminders preserve legacy delivery and persist explicit disabling', () => {
  store.setOfflineReminder({ smtpHost: 'smtp.fixture', smtpUser: 'fixture', smtpPass: 'fixture', recipientEmail: 'fixture@example.test' }, 1010);
  assert.equal(store.getOfflineReminder(1010).enabled, true);
  store.setOfflineReminder({ enabled: false }, 1010);
  assert.equal(store.getOfflineReminder(1010).enabled, false);
  assert.equal(store.getOfflineReminder(1010).smtpHost, 'smtp.fixture');
});

test('default plans keep only strategy and automation fields', () => {
  const plan = store.setUserDefaultAccountPlan(1001, {
    plantingStrategy: 'max_profit',
    automation: { farm: true, friend: true },
    intervals: { farmMin: 7, farmMax: 9 },
    friendBlacklist: [10001],
    knownFriendGids: [10002],
    goldenBugKeepCount: 5,
    goldenBugRoundLimit: 12,
    offlineReminder: { smtpPass: 'secret' },
  });

  assert.equal(plan.exists, true);
  assert.equal(plan.enabled, true);
  assert.equal(plan.config.plantingStrategy, 'max_profit');
  assert.equal(plan.config.automation.farm, true);
  assert.equal(plan.config.intervals.farmMin, 7);
  assert.equal(plan.config.goldenBugKeepCount, 5);
  assert.equal(plan.config.goldenBugRoundLimit, 12);
  assert.equal('friendBlacklist' in plan.config, false);
  assert.equal('knownFriendGids' in plan.config, false);
  assert.equal('offlineReminder' in plan.config, false);
});

test('new accounts inherit an enabled user default plan', () => {
  const accounts = store.addOrUpdateAccount({
    name: 'Alice farm',
    userId: 1001,
    code: 'code-1',
  });
  const created = accounts.accounts.at(-1);
  const config = store.getConfigSnapshot(created.id);

  assert.equal(config.plantingStrategy, 'max_profit');
  assert.equal(config.automation.farm, true);
  assert.equal(config.intervals.farmMin, 7);
  assert.equal(config.goldenBugKeepCount, 5);
  assert.equal(config.goldenBugRoundLimit, 12);
});

test('disabled plans do not change new account defaults', () => {
  store.setUserDefaultAccountPlan(1002, {
    plantingStrategy: 'max_profit',
    automation: { farm: true },
  }, { enabled: false });

  const accounts = store.addOrUpdateAccount({
    name: 'Bob farm',
    userId: 1002,
    code: 'code-2',
  });
  const created = accounts.accounts.at(-1);
  const config = store.getConfigSnapshot(created.id);
  const defaults = store.getDefaultAccountConfig();

  assert.equal(config.plantingStrategy, defaults.plantingStrategy);
  assert.equal(config.automation.farm, defaults.automation.farm);
});

test('a saved plan can be applied to an existing account', () => {
  store.setUserDefaultAccountPlan(1002, {
    plantingStrategy: 'level',
    automation: { task: true },
  });
  const account = store.getAccountsByUser(1002).accounts[0];
  const config = store.applyUserDefaultAccountPlan(1002, account.id);

  assert.equal(config.plantingStrategy, 'level');
  assert.equal(config.automation.task, true);
});
