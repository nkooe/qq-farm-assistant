const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

test('the complete admin server starts with new storage and enforces multi-user account boundaries', { timeout: 15000 }, async t => {
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const source = `
    const store = require('./src/models/store');
    const userStore = require('./src/models/user-store');
    require('./src/models/access-policy').setAccessPolicy({ cardVerificationEnabled: false });
    for (const username of ['alice', 'bob']) userStore.registerUser(username, 'Fixture-Test-123');
    for (const [username, uin] of [['alice', '3'], ['alice', '77778888'], ['bob', '77778888']]) {
      store.addOrUpdateAccount({ userId: userStore.getUserByUsername(username).id, platform: 'qq', uin, name: username + '-farm-' + uin, autoStart: false });
    }
    require('./src/controllers/admin').startAdminServer({
      getAccounts: store.getAccounts,
      getStatus: accountId => ({ accountId }),
      getLogs: () => [], getAccountLogs: () => [],
      getSchedulerStatus: async () => ({ runtime: ['private-runtime'] }),
    });
    process.send('started');
  `;
  const child = spawn(process.execPath, ['-e', source], {
    cwd: path.join(__dirname, '..'), windowsHide: true,
    env: { ...process.env, ADMIN_PORT: String(port), QQ_LOGIN_ENABLED: '0', YYB_API_URL: 'http://127.0.0.1:1', YYB_API_KEY: 'fixture-service-key' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await exited; });
  await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(`admin startup failed: ${output}`); })]);
  const request = (route, token, options = {}) => fetch(`http://127.0.0.1:${port}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-admin-token': token } : {}), ...options.headers },
    signal: AbortSignal.timeout(3000),
  });
  const tokens = {};
  for (const username of ['admin', 'alice', 'bob']) {
    const response = await request('/api/login', '', { method: 'POST', body: JSON.stringify({ username, password: username === 'admin' ? 'admin' : 'Fixture-Test-123' }) });
    assert.equal(response.status, 200);
    tokens[username] = (await response.json()).data.token;
  }
  for (const [username, count] of [['alice', 2], ['bob', 1], ['admin', 3]]) {
    const response = await request('/api/accounts', tokens[username]);
    assert.equal(response.status, 200);
    const data = (await response.json()).data;
    assert.equal(data.accounts.length, count);
    assert.deepEqual(Object.keys(data), ['accounts']);
    if (username !== 'admin') assert.ok(data.accounts.every(account => account.userId === (username === 'alice' ? 1001 : 1002)));
  }
  assert.equal((await request('/api/user/me', tokens.alice)).status, 200);
  assert.equal((await request('/api/status', tokens.alice, { headers: { 'x-account-id': '3' } })).status, 403);
  assert.equal((await request('/api/status', tokens.bob, { headers: { 'x-account-id': '3' } })).status, 200);
  assert.equal((await request('/api/status', tokens.alice, { headers: { 'x-account-id': '77778888' } })).status, 403);
  assert.equal((await request('/api/scheduler', tokens.alice)).status, 403);
  assert.equal((await request('/api/scheduler', tokens.admin)).status, 200);
  assert.equal((await request('/api/admin/users', tokens.alice)).status, 403);
  assert.equal((await request('/api/admin/users', tokens.admin)).status, 200);
  const duplicate = await request('/api/register', '', { method: 'POST', body: JSON.stringify({ username: 'ALICE', password: 'Fixture-Test-123' }) });
  assert.equal(duplicate.status, 400);
  for (const route of ['/api/auto-login', '/api/proxy']) {
    assert.equal((await request(route, '', { method: 'POST', body: '{}', headers: { 'x-forwarded-for': '127.0.0.1', 'cf-connecting-ip': '192.168.1.2' } })).status, 401);
    assert.equal((await request(route, tokens.alice, { method: 'POST', body: '{}' })).status, 404);
  }
});
