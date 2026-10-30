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
      owned(owner, id) { if (!active || owner !== '1001:panel-a' || id !== item.id) throw new QqScanError('missing', 404); return item; },
      async refreshCode() { calls.push(['refresh']); return 'fixture_FRESH_CODE_12345678'; },
      stopChild() { calls.push(['release']); },
      async saveProfile(item, userId) { if (options.saveProfile) return options.saveProfile(item, userId); return '12345678-1234-4234-8234-123456789abc'; },
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
    userStore: { DEFAULT_ACCOUNT_LIMIT: 2, getUser: id => ({ id, role: id === 1000 ? 'admin' : 'user', accountLimit: options.currentLimit?.() ?? options.limit ?? 2, deleting: options.deleting === true, card: { enabled: options.enabled !== false, isPermanent: true } }) },
    probe: options.probe || (async (code, proxy) => { calls.push(['probe', code, proxy]); return { gid: '4242', openId: 'fixture-farm-id' }; }),
  });
  const req = { params: { id: 'scan' }, currentUser: { id: 1001, role: 'user', accountLimit: options.limit || 2 }, adminToken: 'panel-a', body: {} };
  return { accounts, calls, item, req, save: () => importer(req), importer, cancel() { active = false; } };
}

test('same native identity with a new Code updates its record even at quota, preserving name and configuration', async () => {
  const h = harness({ limit: 1, accounts: [{ id: '4', userId: 1001, platform: 'qq', uin: '12345678', code: 'old', name: 'Original', config: { farm: false } }] });
  const result = await h.save();
  assert.equal(result.accountId, '4'); assert.equal(result.updated, true);
  assert.equal(h.accounts.length, 1); assert.equal(h.accounts[0].name, 'Original');
  assert.deepEqual(h.accounts[0].config, { farm: false });
  assert.equal(h.accounts[0].code, h.item.code); assert.equal(h.accounts[0].proxyProfileId, 7);
  assert.deepEqual(h.calls.filter(c => ['probe', 'refresh'].includes(c[0])), []);
  assert.deepEqual(h.calls.at(-1), ['restart', '4']);
});

test('QQ import rejects a pending account deletion before saving any new profile', async () => {
  let saved = false;
  const h = harness({ accounts: [{ id: '4', userId: 1001, platform: 'qq', uin: '12345678', deleting: true }],
    saveProfile: async () => { saved = true; return 'fixture-profile'; } });
  await assert.rejects(h.save(), error => error.status === 409 && /正在删除/.test(error.message));
  assert.equal(saved, false); assert.equal(h.calls.some(call => call[0] === 'save'), false);
});

test('a target without current native identity is rejected rather than probed or migrated', async () => {
  const h = harness({ accounts: [{ id: '10', userId: 1001, platform: 'qq', gid: '4242' }] });
  h.item.targetAccountId = '10';
  await assert.rejects(h.save(), { status: 409 });
  assert.deepEqual(h.calls, []);
});

test('different identity adds an account and never trusts browser-supplied identity or Code', async () => {
  const h = harness({ accounts: [{ id: '1', userId: 1001, platform: 'qq', gid: '999' }] });
  h.req.body = { gid: '999', uin: 'malicious', code: 'client-code', id: '1', name: 'New' };
  const result = await h.save();
  assert.equal(result.updated, false); assert.equal(h.accounts.length, 2);
  assert.equal(h.accounts[0].gid, '999'); assert.equal(h.accounts[1].uin, '12345678');
  assert.equal(h.accounts[1].code, h.item.code);
});

test('banned owner cannot import QQ credentials even through an already open scan', async () => {
  const h = harness({ enabled: false });
  await assert.rejects(h.save(), { status: 403 });
  assert.deepEqual(h.calls, []);
});

test('parallel import retries save and start exactly once', async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.save(), h.save()]);
  assert.deepEqual(a, b); assert.equal(h.accounts.length, 1);
  await h.save();
  assert.equal(h.calls.filter(c => c[0] === 'save').length, 1);
  assert.equal(h.calls.filter(c => c[0] === 'start').length, 1);
});

test('parallel imports isolate two QQ accounts for one user and the same QQ identity for another user', async () => {
  const accounts = [], starts = [];
  const items = new Map([
    ['alice-a', { id: 'alice-a', owner: '1001:token-a', uin: '12345678', code: 'fixture_ALICE_A_CODE' }],
    ['alice-b', { id: 'alice-b', owner: '1001:token-a', uin: '87654321', code: 'fixture_ALICE_B_CODE' }],
    ['bob-a', { id: 'bob-a', owner: '1002:token-b', uin: '12345678', code: 'fixture_BOB_A_CODE' }],
  ]);
  const importer = createQqAccountImporter({
    qqLogin: {
      owned(owner, id) { const item = items.get(id); if (item?.owner !== owner) throw new QqScanError('missing', 404); return item; },
      async saveProfile(item, userId) { return `${userId}-profile-${item.id}`; },
      stopChild() {}, discardProfile() {},
    },
    provider: { getAccounts: () => ({ accounts }), startAccount: id => starts.push(id) },
    addOrUpdateAccount(account) { accounts.push({ ...account, id: String(accounts.length + 1) }); return { accounts }; },
    userStore: { getUser: id => ({ id, role: 'user', card: { isPermanent: true } }), DEFAULT_ACCOUNT_LIMIT: 2 },
  });
  const requests = [...items.values()].map(item => {
    const [userId, adminToken] = item.owner.split(':');
    return { currentUser: { id: Number(userId), role: 'user', accountLimit: 2 }, adminToken, params: { id: item.id }, body: {} };
  });
  const results = await Promise.all(requests.map(importer));
  assert.equal(new Set(results.map(result => result.accountId)).size, 3);
  assert.equal(new Set(starts).size, 3);
  assert.equal(accounts.filter(account => account.userId === 1001).length, 2);
  assert.equal(accounts.filter(account => account.userId === 1002).length, 1);
  for (const [index, item] of [...items.values()].entries()) {
    const account = accounts.find(account => account.id === results[index].accountId);
    assert.equal(account.userId, requests[index].currentUser.id);
    assert.equal(account.uin, item.uin); assert.equal(account.code, item.code);
    assert.equal(account.qqLoginProfile, `${account.userId}-profile-${item.id}`);
  }
  await assert.rejects(importer({ ...requests[0], currentUser: { id: 1002, role: 'user' }, adminToken: 'token-b' }), { status: 404 });
});

test('same identity owned by another user is never updated, including for panel administrators', async () => {
  const h = harness({ accounts: [{ id: '1', userId: 1002, platform: 'qq', uin: '12345678' }] });
  h.req.currentUser.role = 'admin';
  const result = await h.save();
  assert.equal(result.updated, false); assert.equal(h.accounts.length, 2);
  assert.equal(h.accounts[0].code, undefined); assert.equal(h.accounts[1].userId, 1001);
  await assert.rejects(h.importer({ ...h.req, adminToken: 'wrong' }), { status: 404 });
});

test('unmatched account at quota and failed identity checks do not save or start accounts', async () => {
  const h = harness({ limit: 1, accounts: [{ id: '1', userId: 1001, platform: 'qq', gid: '999' }] });
  await assert.rejects(h.save(), { status: 403 });
  assert.equal(h.calls.filter(c => c[0] === 'save').length, 0);
  const disabled = harness({ deleting: true });
  await assert.rejects(disabled.save(), { status: 403 }); assert.deepEqual(disabled.calls, []);
});

test('an account added while native credentials are saving cannot bypass the user quota', async () => {
  const accounts = [];
  const h = harness({ accounts, limit: 1, saveProfile: async () => {
    accounts.push({ id: '99', userId: 1001, platform: 'wx' });
    return '12345678-1234-4234-8234-123456789abc';
  } });
  await assert.rejects(h.save(), { status: 403 });
  assert.equal(accounts.length, 1);
  assert.equal(h.calls.some(call => call[0] === 'save' || call[0] === 'start'), false);
  assert.equal(h.item.savedProfile, null);
});

test('quota reduced while a native profile is saving is enforced before account persistence', async () => {
  let limit = 2, finish;
  const h = harness({ accounts: [{ id: '1', userId: 1001, platform: 'wx' }], currentLimit: () => limit,
    saveProfile: () => new Promise(resolve => { finish = resolve; }),
  });
  const pending = h.save(); await new Promise(resolve => setImmediate(resolve));
  limit = 1; finish('12345678-1234-4234-8234-123456789abc');
  await assert.rejects(pending, { status: 403 });
  assert.equal(h.accounts.length, 1);
  assert.equal(h.calls.some(call => call[0] === 'save' || call[0] === 'start'), false);
  assert.equal(h.item.savedProfile, null);
});

test('an identity edited while native credentials are saving is never overwritten by the stale import', async () => {
  let finish;
  const h = harness({ accounts: [{ id: '4', userId: 1001, platform: 'qq', uin: '12345678', code: 'old' }],
    saveProfile: () => new Promise(resolve => { finish = resolve; }),
  });
  h.item.targetAccountId = '4';
  const pending = h.save(); await new Promise(resolve => setImmediate(resolve));
  h.accounts[0].code = 'newer-manual-code'; finish('12345678-1234-4234-8234-123456789abc');
  await assert.rejects(pending, { status: 409 });
  assert.equal(h.accounts[0].code, 'newer-manual-code');
  assert.equal(h.calls.some(call => call[0] === 'save' || call[0] === 'start' || call[0] === 'restart'), false);
  assert.equal(h.item.savedProfile, null);
});

test('an identical native identity added during credential saving does not create a duplicate account', async () => {
  let finish;
  const h = harness({ saveProfile: () => new Promise(resolve => { finish = resolve; }) });
  const pending = h.save(); await new Promise(resolve => setImmediate(resolve));
  h.accounts.push({ id: '99', userId: 1001, platform: 'qq', uin: '12345678', code: 'newer-account' });
  finish('12345678-1234-4234-8234-123456789abc');
  await assert.rejects(pending, { status: 409 });
  assert.equal(h.accounts.length, 1); assert.equal(h.accounts[0].code, 'newer-account');
  assert.equal(h.calls.some(call => call[0] === 'save' || call[0] === 'start'), false);
  assert.equal(h.item.savedProfile, null);
});

test('bound update preserves the selected account and ignores a replacement name at quota', async () => {
  const h = harness({ limit: 1, accounts: [{ id: '4', userId: 1001, platform: 'qq', uin: '12345678', name: 'Original', config: { farm: false } }] });
  h.item.targetAccountId = '4';
  h.req.body = { targetAccountId: '4', name: 'Replacement' };
  const result = await h.save();
  assert.equal(result.updated, true); assert.equal(result.accountId, '4');
  assert.equal(h.accounts.length, 1); assert.equal(h.accounts[0].name, 'Original');
  assert.deepEqual(h.accounts[0].config, { farm: false });
});

test('administrator explicitly updates another user account while retaining its owner and login profile identity', async () => {
  let profileOwner;
  const h = harness({ accounts: [{id:'4',userId:1002,platform:'qq',uin:'12345678',name:'Bob farm'}], saveProfile: async (_item, userId) => { profileOwner = userId; return 'fixture-profile'; } });
  h.req.currentUser.role = 'admin';
  h.item.targetAccountId = '4';
  const result = await h.save();
  assert.equal(result.accountId, '4');
  assert.equal(h.accounts.length, 1);
  assert.equal(h.accounts[0].userId, 1002);
  assert.equal(h.accounts[0].name, 'Bob farm');
  assert.equal(profileOwner, 1002);
  assert.equal(h.accounts[0].code, h.item.code);
});

test('bound update rejects a different native QQ identity before probing and never adds it', async () => {
  const h = harness({ accounts: [{ id: '4', userId: 1001, platform: 'qq', uin: '87654321', code: 'old' }] });
  h.item.targetAccountId = '4';
  await assert.rejects(h.save(), { status: 409 });
  assert.equal(h.accounts.length, 1); assert.equal(h.accounts[0].code, 'old'); assert.deepEqual(h.calls, []);
});

test('bound legacy update rejects a scan matching another record instead of updating or adding', async () => {
  const h = harness({ accounts: [{ id: '4', userId: 1001, platform: 'qq', gid: '999', code: 'old' }, { id: '5', userId: 1001, platform: 'qq', gid: '4242', code: 'other' }] });
  h.item.targetAccountId = '4';
  await assert.rejects(h.save(), { status: 409 });
  assert.deepEqual(h.accounts.map(a => a.code), ['old', 'other']);
  assert.equal(h.calls.filter(c => c[0] === 'save').length, 0);
});

test('bound update rejects inaccessible, non-QQ, YYB, and unverifiable targets', async () => {
  for (const account of [
    { userId: 1002, platform: 'qq', uin: '12345678' },
    { userId: 1001, platform: 'wx', uin: '12345678' },
    { userId: 1001, platform: 'qq', yybOpenid: 'yyb-id', uin: '12345678' },
    { userId: 1001, platform: 'qq' },
  ]) {
    const h = harness({ accounts: [{ id: '4', code: 'old', ...account }] });
    h.item.targetAccountId = '4';
    await assert.rejects(h.save());
    assert.equal(h.accounts[0].code, 'old'); assert.deepEqual(h.calls, []);
  }
});

test('bound import cannot switch the target or retarget a completed import', async () => {
  const h = harness({ accounts: [{ id: '4', userId: 1001, platform: 'qq', uin: '12345678' }] });
  h.item.targetAccountId = '4'; h.req.body.targetAccountId = '5';
  await assert.rejects(h.save(), { status: 409 });
  h.req.body.targetAccountId = '4'; await h.save();
  h.req.body.targetAccountId = '5'; await assert.rejects(h.save(), { status: 409 });
  assert.equal(h.calls.filter(c => c[0] === 'save').length, 1);
});

test('deleting the target while saving credentials prevents any account write', async () => {
  let finish;
  const h = harness({ accounts: [{ id: '4', userId: 1001, platform: 'qq', uin: '12345678' }], saveProfile: () => new Promise(resolve => { finish = resolve; }) });
  h.item.targetAccountId = '4';
  const operation = h.save(); await new Promise(resolve => setImmediate(resolve));
  h.accounts.splice(0); finish('12345678-1234-4234-8234-123456789abc');
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
