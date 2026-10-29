const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAdminAccountRoutes } = require('../src/controllers/admin-account-routes');

function harness() {
  const accounts = [{ id: '1', name: 'A', yybOpenid: 'wx-a', loginType: 'yyb' }];
  const calls = [];
  const routes = new Map();
  registerAdminAccountRoutes({
    app: { get(path, handler) { routes.set('GET ' + path, handler); }, post(path, handler) { routes.set(path, handler); }, delete() {} },
    provider: {
      getAccounts: () => ({ accounts }),
      isAccountRunning: () => true,
      startAccount: id => calls.push(['start', id]),
      restartAccount: id => calls.push(['restart', id]),
    },
    resolveAccountReference: id => String(id),
    addOrUpdateAccount: account => {
      calls.push(['save', account]);
      if (account.id) Object.assign(accounts.find(a => a.id === account.id), account);
      else accounts.push({ ...account, id: String(accounts.length + 1) });
      return { accounts };
    },
  });
  return {
    accounts, calls,
    read() {
      const res = { json(value) { this.body = value; return this; }, status() { return this; } };
      routes.get('GET /api/accounts')({ currentUser: { role: 'admin', username: 'admin' } }, res);
      return res;
    },
    save(body) {
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
      routes.get('/api/accounts')({ body, currentUser: { role: 'admin', username: 'admin' } }, res);
      return res;
    },
  };
}

test('stale editor cannot overwrite a different saved YYB identity', () => {
  const h = harness();
  const res = h.save({ id: '1', yybOpenid: 'wx-b', loginType: 'yyb', code: 'new-b' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.ok, false);
  assert.equal(h.accounts[0].yybOpenid, 'wx-a');
  assert.deepEqual(h.calls, []);
});

test('matching identity updates only its own record', () => {
  const h = harness();
  assert.equal(h.save({ id: '1', yybOpenid: 'wx-a', code: 'new-a' }).body.ok, true);
  assert.equal(h.accounts.length, 1);
  assert.equal(h.accounts[0].code, 'new-a');
  assert.deepEqual(h.calls[1], ['restart', '1']);
});

test('another YYB account is added and started separately', () => {
  const h = harness();
  assert.equal(h.save({ yybOpenid: 'wx-b', loginType: 'yyb', name: 'B', code: 'new-b' }).body.ok, true);
  assert.equal(h.accounts.length, 2);
  assert.equal(h.accounts[0].yybOpenid, 'wx-a');
  assert.equal(h.accounts[1].yybOpenid, 'wx-b');
  assert.deepEqual(h.calls[1], ['start', '2']);
});

test('same YYB identity cannot be added twice', () => {
  const h = harness();
  const res = h.save({ yybOpenid: 'wx-a', loginType: 'yyb', provider: 'builtin', code: 'duplicate' });
  assert.equal(res.statusCode, 409);
  assert.equal(h.accounts.length, 1);
  assert.deepEqual(h.calls, []);
});

test('cached QQ clients cannot bypass trusted session import by posting a Code', () => {
  const h = harness();
  const payload = { platform: 'qq', loginType: 'manual', name: 'QQ scan', code: 'fixture_QQ_CODE_12345678', qqScanSessionId: 'scan-a' };
  assert.equal(h.save({ ...payload }).statusCode, 409);
  assert.equal(h.accounts.length, 1);
  assert.equal(h.calls.length, 0);
});

test('cached QQ imports leave other panel users untouched', () => {
  const h = harness();
  h.accounts.push({ id: '2', platform: 'qq', username: 'someone-else', code: 'fixture_OTHER_CODE_12345678' });
  const payload = { platform: 'qq', code: 'fixture_OTHER_CODE_12345678', qqScanSessionId: 'scan-b' };
  assert.equal(h.save({ ...payload }).statusCode, 409);
  assert.equal(h.accounts.length, 2);
  assert.equal(h.accounts[1].username, 'someone-else');
});

test('account save hides native profile references and rejects browser-provided replacements', () => {
  const h = harness();
  h.accounts[0].qqLoginProfile = 'private-server-profile';
  const response = h.save({ id: '1', name: 'Renamed', qqLoginProfile: 'injected-profile' });
  assert.equal(response.body.ok, true);
  assert.equal(h.accounts[0].qqLoginProfile, 'private-server-profile');
  assert.equal(response.body.data.accounts[0].qqAutoCodeAvailable, true);
  assert.equal('qqLoginProfile' in response.body.data.accounts[0], false);
  assert.equal(h.read().body.data.accounts[0].qqAutoCodeAvailable, true);
  assert.equal('qqLoginProfile' in h.read().body.data.accounts[0], false);
});
