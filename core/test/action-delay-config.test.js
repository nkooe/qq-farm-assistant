const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const store = require('../src/models/store');
const { getDataFile } = require('../src/config/runtime-paths');
const { createDataProvider } = require('../src/runtime/data-provider');

test('zero action delays and email hours survive snapshots, persistence and account isolation', () => {
  const a = store.addOrUpdateAccount({ userId: 1001, platform: 'qq' }).accounts.at(-1);
  const b = store.addOrUpdateAccount({ userId: 1002, platform: 'wx' }).accounts.at(-1);
  store.applyConfigSnapshot({ stealDelaySeconds: 0, plantDelaySeconds: 0, emailClaimHour: 0 }, { accountId: a.id });
  store.applyConfigSnapshot({ stealDelaySeconds: 5, plantDelaySeconds: 9, emailClaimHour: 23 }, { accountId: b.id });
  assert.equal(store.getStealDelaySeconds(a.id), 0);
  assert.equal(store.getPlantDelaySeconds(a.id), 0);
  assert.equal(store.getConfigSnapshot(a.id).emailClaimHour, 0);
  assert.equal(store.getConfigSnapshot(b.id).emailClaimHour, 23);
  assert.equal(store.getPlantDelaySeconds(b.id), 9);
  const saved = store.getConfigSnapshot(a.id);
  for (const value of [-1, 24, 1.5, '10x', '', null, true, [], {}]) {
    assert.throws(() => store.applyConfigSnapshot({ emailClaimHour: value, knownFriendGids: [1], plantDelaySeconds: 7 }, { accountId: a.id }), { code: 'INVALID_CONFIG' });
    assert.deepEqual(store.getConfigSnapshot(a.id), saved);
  }
  store.setUserDefaultAccountPlan(1001, { emailClaimHour: 0, plantDelaySeconds: 0 });
  assert.equal(store.getUserDefaultAccountPlan(1001).config.emailClaimHour, 0);
  const state = id => getDataFile(`email-claim-${crypto.createHash('sha256').update(id).digest('hex')}.json`);
  fs.writeFileSync(state(a.id), '{}'); fs.writeFileSync(state(b.id), '{}');
  store.deleteAccount(a.id);
  assert.equal(fs.existsSync(state(a.id)), false);
  assert.equal(fs.existsSync(state(b.id)), true);
});

test('HTTP settings provider forwards email hour and broadcasts only after a valid save', async () => {
  const a = store.addOrUpdateAccount({ userId: 1001, platform: 'qq' }).accounts.at(-1);
  const events = [];
  const provider = createDataProvider({ store, workers: {}, getAccounts: store.getAccounts,
    nextConfigRevision: () => 1, broadcastConfigToWorkers: id => events.push(id) });
  const saved = await provider.saveSettings(a.id, { emailClaimHour: 0 });
  assert.equal(saved.emailClaimHour, 0);
  assert.equal(store.getConfigSnapshot(a.id).emailClaimHour, 0);
  await assert.rejects(provider.saveSettings(a.id, { emailClaimHour: 24 }), { code: 'INVALID_CONFIG' });
  assert.deepEqual(events, [a.id]);
});
