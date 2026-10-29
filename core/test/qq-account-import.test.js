const test = require('node:test');
const assert = require('node:assert/strict');
const { createQqAccountImporter } = require('../src/services/qq-account-import');
const { QqScanError } = require('../src/services/qq-login-service');

function harness(options = {}) {
  const accounts = options.accounts || [];
  const calls = [];
  let active = true;
  const item = { id: 'scan', uin: '12345678', code: 'fixture_FIRST_CODE_12345678', proxyMode: 'static', proxyProfileId: 7, proxyURL: 'http://fixture:8080' };
  const importer = createQqAccountImporter({
    qqLogin: {
      owned(owner, id) { if (!active || owner !== 'alice:panel-a' || id !== item.id) throw new QqScanError('missing', 404); return item; },
      async refreshCode() { calls.push(['refresh']); return 'fixture_FRESH_CODE_12345678'; },
      stopChild() { calls.push(['release']); },
      async saveProfile(item, username) { if (options.saveProfile) return options.saveProfile(item, username); return '12345678-1234-4234-8234-123456789abc'; },
      discardProfile() {},
    },
    provider: {
      getAccounts: () => ({ accounts }),
      isAccountRunning: () => options.running !== false,
      startAccount: id => calls.push(['start', id]),
      restartAccount: id => calls.push(['restart', id]),
    },
    addOrUpdateAccount(account) {
      calls.push(['save', account]);
      if (account.id) Object.assign(accounts.find(a => a.id === account.id), account);
      else accounts.push({ ...account, id: String(accounts.length + 10) });
      return { accounts };
    },
    userStore: { DEFAULT_ACCOUNT_LIMIT: 2 },
    probe: options.probe || (async (code, proxy) => { calls.push(['probe', code, proxy]); return { gid: '4242', openId: 'fixture-farm-id' }; }),
  });
  const req = { params: { id: 'scan' }, currentUser: { username: 'alice', role: 'user', accountLimit: options.limit || 2 }, adminToken: 'panel-a', body: {} };
  return { accounts, calls, item, req, save: () => importer(req), importer, cancel() { active = false; } };
}

test('same native identity with a new Code updates its record even at quota, preserving name and configuration', async () => {
  const h = harness({ limit: 1, accounts: [{ id: '4', username: 'alice', platform: 'qq', uin: '12345678', code: 'old', name: 'Original', config: { farm: false } }] });
  const result = await h.save();
  assert.equal(result.accountId, '4'); assert.equal(result.updated, true);
  assert.equal(h.accounts.length, 1); assert.equal(h.accounts[0].name, 'Original');
  assert.deepEqual(h.accounts[0].config, { farm: false });
  assert.equal(h.accounts[0].code, h.item.code); assert.equal(h.accounts[0].proxyProfileId, 7);
  assert.deepEqual(h.calls.filter(c => ['probe', 'refresh'].includes(c[0])), []);
  assert.deepEqual(h.calls.at(-1), ['restart', '4']);
});

test('legacy farm gid/openId is matched before quota and a fresh Code starts its stopped original record', async () => {
  const h = harness({ limit: 1, running: false, accounts: [{ id: '10', username: 'alice', platform: 'qq', gid: '4242', openId: 'fixture-farm-id', name: 'Legacy' }] });
  const result = await h.save();
  assert.equal(result.accountId, '10'); assert.equal(result.updated, true);
  assert.equal(h.accounts.length, 1); assert.equal(h.accounts[0].uin, '12345678');
  assert.equal(h.accounts[0].code, 'fixture_FRESH_CODE_12345678');
  assert.deepEqual(h.calls[0], ['probe', 'fixture_FIRST_CODE_12345678', 'http://fixture:8080']);
  assert.deepEqual(h.calls.at(-1), ['start', '10']);
});

test('different identity adds an account and never trusts browser-supplied identity or Code', async () => {
  const h = harness({ accounts: [{ id: '1', username: 'alice', platform: 'qq', gid: '999' }] });
  h.req.body = { gid: '999', uin: 'malicious', code: 'client-code', id: '1', name: 'New' };
  const result = await h.save();
  assert.equal(result.updated, false); assert.equal(h.accounts.length, 2);
  assert.equal(h.accounts[0].gid, '999'); assert.equal(h.accounts[1].uin, '12345678');
  assert.equal(h.accounts[1].code, 'fixture_FRESH_CODE_12345678');
});

test('parallel import retries save and start exactly once', async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.save(), h.save()]);
  assert.deepEqual(a, b); assert.equal(h.accounts.length, 1);
  await h.save();
  assert.equal(h.calls.filter(c => c[0] === 'save').length, 1);
  assert.equal(h.calls.filter(c => c[0] === 'start').length, 1);
});

test('same identity owned by another user is never updated, including for panel administrators', async () => {
  const h = harness({ accounts: [{ id: '1', username: 'bob', platform: 'qq', uin: '12345678' }] });
  h.req.currentUser.role = 'admin';
  const result = await h.save();
  assert.equal(result.updated, false); assert.equal(h.accounts.length, 2);
  assert.equal(h.accounts[0].code, undefined); assert.equal(h.accounts[1].username, 'alice');
  await assert.rejects(h.importer({ ...h.req, adminToken: 'wrong' }), { status: 404 });
});

test('unmatched account at quota and failed identity checks do not save or start accounts', async () => {
  const h = harness({ limit: 1, accounts: [{ id: '1', username: 'alice', platform: 'qq', gid: '999' }] });
  await assert.rejects(h.save(), { status: 403 });
  assert.equal(h.calls.filter(c => c[0] === 'save').length, 0);
  const failed = harness({ accounts: h.accounts, probe: async () => { throw new QqScanError('probe failed'); } });
  await assert.rejects(failed.save()); assert.deepEqual(failed.calls, []);
});

test('cancel during legacy identity lookup prevents an eventual account write', async () => {
  let finish;
  const h = harness({ accounts: [{ id: '1', username: 'alice', platform: 'qq', gid: '4242' }], probe: () => new Promise(resolve => { finish = resolve; }) });
  const saving = h.save(); await new Promise(resolve => setImmediate(resolve));
  h.cancel(); finish({ gid: '4242', openId: 'fixture-farm-id' });
  await assert.rejects(saving, { status: 404 });
  assert.equal(h.calls.filter(c => c[0] === 'save').length, 0);
});

test('bound update preserves the selected account and ignores a replacement name at quota', async () => {
  const h = harness({ limit: 1, accounts: [{ id: '4', username: 'alice', platform: 'qq', uin: '12345678', name: 'Original', config: { farm: false } }] });
  h.item.targetAccountId = '4';
  h.req.body = { targetAccountId: '4', name: 'Replacement' };
  const result = await h.save();
  assert.equal(result.updated, true); assert.equal(result.accountId, '4');
  assert.equal(h.accounts.length, 1); assert.equal(h.accounts[0].name, 'Original');
  assert.deepEqual(h.accounts[0].config, { farm: false });
});

test('bound update rejects a different native QQ identity before probing and never adds it', async () => {
  const h = harness({ accounts: [{ id: '4', username: 'alice', platform: 'qq', uin: '87654321', code: 'old' }] });
  h.item.targetAccountId = '4';
  await assert.rejects(h.save(), { status: 409 });
  assert.equal(h.accounts.length, 1); assert.equal(h.accounts[0].code, 'old'); assert.deepEqual(h.calls, []);
});

test('bound legacy update matches the selected farm identity and refreshes its consumed Code', async () => {
  const h = harness({ accounts: [{ id: '4', username: 'alice', platform: 'qq', gid: '4242' }] });
  h.item.targetAccountId = '4';
  assert.equal((await h.save()).accountId, '4');
  assert.equal(h.accounts.length, 1); assert.equal(h.accounts[0].code, 'fixture_FRESH_CODE_12345678');
});

test('bound legacy update rejects a scan matching another record instead of updating or adding', async () => {
  const h = harness({ accounts: [{ id: '4', username: 'alice', platform: 'qq', gid: '999', code: 'old' }, { id: '5', username: 'alice', platform: 'qq', gid: '4242', code: 'other' }] });
  h.item.targetAccountId = '4';
  await assert.rejects(h.save(), { status: 409 });
  assert.deepEqual(h.accounts.map(a => a.code), ['old', 'other']);
  assert.equal(h.calls.filter(c => c[0] === 'save').length, 0);
});

test('bound update rejects inaccessible, non-QQ, YYB, and unverifiable targets', async () => {
  for (const account of [
    { username: 'bob', platform: 'qq', uin: '12345678' },
    { username: 'alice', platform: 'wx', uin: '12345678' },
    { username: 'alice', platform: 'qq', yybOpenid: 'yyb-id', uin: '12345678' },
    { username: 'alice', platform: 'qq' },
  ]) {
    const h = harness({ accounts: [{ id: '4', code: 'old', ...account }] });
    h.item.targetAccountId = '4';
    await assert.rejects(h.save());
    assert.equal(h.accounts[0].code, 'old'); assert.deepEqual(h.calls, []);
  }
});

test('bound import cannot switch the target or retarget a completed import', async () => {
  const h = harness({ accounts: [{ id: '4', username: 'alice', platform: 'qq', uin: '12345678' }] });
  h.item.targetAccountId = '4'; h.req.body.targetAccountId = '5';
  await assert.rejects(h.save(), { status: 409 });
  h.req.body.targetAccountId = '4'; await h.save();
  h.req.body.targetAccountId = '5'; await assert.rejects(h.save(), { status: 409 });
  assert.equal(h.calls.filter(c => c[0] === 'save').length, 1);
});

test('deleting the target during legacy verification prevents any write', async () => {
  let finish;
  const h = harness({ accounts: [{ id: '4', username: 'alice', platform: 'qq', gid: '4242' }], probe: () => new Promise(resolve => { finish = resolve; }) });
  h.item.targetAccountId = '4';
  const operation = h.save(); await new Promise(resolve => setImmediate(resolve));
  h.accounts.splice(0); finish({ gid: '4242' });
  await assert.rejects(operation, { status: 404 });
  assert.equal(h.calls.filter(c => c[0] === 'save').length, 0);
});

test('cancelling while credentials are being saved prevents account persistence', async () => {
  let finish;
  const h = harness({ saveProfile: () => new Promise(resolve => { finish = resolve; }) });
  const operation = h.save(); await new Promise(resolve => setImmediate(resolve));
  h.cancel(); finish('12345678-1234-4234-8234-123456789abc');
  await assert.rejects(operation, { status: 404 });
  assert.equal(h.calls.filter(c => c[0] === 'save').length, 0);
});
