const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAdminAccountRoutes } = require('../src/controllers/admin-account-routes');

function harness() {
  const accounts = [{ id: '1', name: 'A', yybOpenid: 'wx-a', loginType: 'yyb' }];
  const calls = [];
  const routes = new Map();
  registerAdminAccountRoutes({
    app: { get() {}, post(path, handler) { routes.set(path, handler); }, delete() {} },
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
