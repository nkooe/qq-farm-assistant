const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAdminAccountRoutes } = require('../src/controllers/admin-account-routes');

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function setup(accounts, refreshAccountCode, extra = {}) {
  const routes = { get: new Map(), post: new Map() };
  registerAdminAccountRoutes({
    app: {
      get(path, handler) { routes.get.set(path, handler); },
      delete() {},
      post(path, handler) { routes.post.set(path, handler); },
    },
    provider: { refreshAccountCode },
    getAccountsForUser: () => accounts,
    ...extra,
  });
  return routes;
}

async function startRefresh(routes, user, requestId = 'request-1', retryJobId) {
  const res = response();
  await routes.post.get('/api/accounts/refresh-wx-codes')({
    currentUser: user,
    body: { requestId, retryJobId },
  }, res);
  return res;
}

function getRefreshJob(routes, user, jobId) {
  const res = response();
  routes.get.get('/api/accounts/refresh-wx-codes/:jobId')({
    currentUser: user,
    params: { jobId },
  }, res);
  return res;
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test('bulk refresh returns a job immediately and exposes per-account progress', async () => {
  const accounts = [
    { id: '1', name: 'YYB', loginType: 'yyb', yybOpenid: 'openid-a', username: 'admin' },
    { id: '2', name: 'Legacy', loginType: 'manual', wxid: 'wxid-a', username: 'admin' },
    { id: '3', name: 'QQ', platform: 'qq', username: 'admin' },
  ];
  const refreshed = [];
  let finishFirst;
  const firstRefresh = new Promise(resolve => { finishFirst = resolve; });
  const routes = setup(accounts, async (id) => {
    refreshed.push(id);
    if (id === '1') return firstRefresh;
    return { ok: true, source: 'wxid' };
  });

  const res = await startRefresh(routes, { username: 'admin', role: 'admin' });
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.data.state, 'queued');
  assert.equal(res.body.data.total, 2);
  assert.equal(res.body.data.skipped, 1);
  assert.ok(res.body.data.jobId);

  await waitFor(() => refreshed.length === 1, 'refresh worker did not start');
  const running = getRefreshJob(routes, { username: 'admin', role: 'admin' }, res.body.data.jobId);
  assert.equal(running.statusCode, 200);
  assert.equal(running.body.data.state, 'running');
  assert.equal(running.body.data.completed, 0);
  assert.deepEqual(running.body.data.currentAccount, { id: '1', name: 'YYB' });

  finishFirst({ ok: true, source: 'yyb' });
  await waitFor(() => {
    const job = getRefreshJob(routes, { username: 'admin', role: 'admin' }, res.body.data.jobId).body.data;
    return job.state === 'completed';
  }, 'refresh worker did not complete');

  const finished = getRefreshJob(routes, { username: 'admin', role: 'admin' }, res.body.data.jobId).body.data;
  assert.deepEqual(refreshed, ['1', '2']);
  assert.equal(finished.completed, 2);
  assert.equal(finished.success, 2);
  assert.equal(finished.failed, 0);
  assert.equal(finished.skipped, 1);
  assert.deepEqual(finished.results.map(result => result.source), ['yyb', 'wxid']);
});

test('one refresh failure does not prevent remaining accounts from refreshing', async () => {
  const accounts = [
    { id: '1', name: 'Expired YYB', loginType: 'yyb', yybOpenid: 'openid-a' },
    { id: '2', name: 'Healthy YYB', loginType: 'yyb', yybOpenid: 'openid-b' },
  ];
  const refreshed = [];
  const routes = setup(accounts, async (id) => {
    refreshed.push(id);
    return id === '1'
      ? { ok: false, source: 'yyb', error: '需要重新扫码' }
      : { ok: true, source: 'yyb' };
  });

  const res = await startRefresh(routes, { username: 'admin', role: 'admin' });
  await waitFor(() => {
    const job = getRefreshJob(routes, { username: 'admin', role: 'admin' }, res.body.data.jobId).body.data;
    return job.state === 'completed';
  }, 'refresh worker did not complete after a failure');

  const job = getRefreshJob(routes, { username: 'admin', role: 'admin' }, res.body.data.jobId).body.data;
  assert.deepEqual(refreshed, ['1', '2']);
  assert.equal(job.success, 1);
  assert.equal(job.failed, 1);
  assert.equal(job.results[0].error, '需要重新扫码');
  assert.equal(job.results[1].ok, true);
});

test('refresh jobs are isolated by username', async () => {
  const accounts = [
    { id: '1', name: 'Account', loginType: 'yyb', yybOpenid: 'openid-a', username: 'admin' },
  ];
  let finishRefresh;
  const refresh = new Promise(resolve => { finishRefresh = resolve; });
  const routes = setup(accounts, async () => refresh);

  const res = await startRefresh(routes, { username: 'admin', role: 'admin' });
  const denied = getRefreshJob(routes, { username: 'other-user', role: 'user' }, res.body.data.jobId);
  assert.equal(denied.statusCode, 404);
  assert.equal(denied.body.ok, false);

  finishRefresh({ ok: true, source: 'yyb' });
});

test('repeating a request id while a job is active does not start another refresh', async () => {
  const accounts = [
    { id: '1', name: 'Account', loginType: 'yyb', yybOpenid: 'openid-a' },
  ];
  let refreshCalls = 0;
  let finishRefresh;
  const refresh = new Promise(resolve => { finishRefresh = resolve; });
  const routes = setup(accounts, async () => {
    refreshCalls++;
    return refresh;
  });
  const user = { username: 'admin', role: 'admin' };

  const first = await startRefresh(routes, user, 'same-request');
  await waitFor(() => refreshCalls === 1, 'refresh worker did not start');
  const duplicate = await startRefresh(routes, user, 'same-request');
  assert.equal(duplicate.statusCode, 202);
  assert.equal(duplicate.body.data.jobId, first.body.data.jobId);
  assert.equal(refreshCalls, 1);

  finishRefresh({ ok: true, source: 'yyb' });
});

test('a retry returns its original completed job while another job is active', async () => {
  const accounts = [
    { id: '1', name: 'Account', loginType: 'yyb', yybOpenid: 'openid-a' },
  ];
  let refreshCalls = 0;
  let finishSecond;
  const secondRefresh = new Promise(resolve => { finishSecond = resolve; });
  const routes = setup(accounts, async () => {
    refreshCalls++;
    return refreshCalls === 1 ? { ok: true, source: 'yyb' } : secondRefresh;
  });
  const user = { username: 'admin', role: 'admin' };

  const first = await startRefresh(routes, user, 'first-request');
  await waitFor(() => {
    const job = getRefreshJob(routes, user, first.body.data.jobId).body.data;
    return job.state === 'completed';
  }, 'first refresh job did not complete');

  const second = await startRefresh(routes, user, 'second-request');
  await waitFor(() => refreshCalls === 2, 'second refresh job did not start');
  const retry = await startRefresh(routes, user, 'first-request');

  assert.equal(retry.statusCode, 202);
  assert.equal(retry.body.data.jobId, first.body.data.jobId);
  assert.equal(retry.body.data.state, 'completed');
  assert.equal(refreshCalls, 2);
  finishSecond({ ok: true, source: 'yyb' });
  assert.ok(second.body.data.jobId);
});

test('refresh endpoint rejects unauthenticated requests and reports no eligible accounts', async () => {
  const routes = setup([{ id: 'qq', name: 'QQ' }], async () => ({ ok: true }));
  const unauthorized = await startRefresh(routes, null);
  assert.equal(unauthorized.statusCode, 401);

  const empty = await startRefresh(routes, { username: 'admin', role: 'admin' });
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.body.ok, false);
  assert.equal(empty.body.error, '没有可刷新的微信账号');
});

test('retry refresh selects only failed accounts and checks current ownership', async () => {
  const accounts = ['1', '2', '3'].map(id => ({ id, wxid: `wx-${id}`, username: 'alice' }));
  const refreshed = [];
  const routes = setup(accounts, async (id) => {
    refreshed.push(id);
    return { ok: id === '1', error: '凭证失效' };
  });
  const user = { username: 'alice', role: 'user' };
  const first = await startRefresh(routes, user);
  await waitFor(() => getRefreshJob(routes, user, first.body.data.jobId).body.data.state === 'completed', 'job did not finish');
  accounts[2].username = 'bob';
  const retry = await startRefresh(routes, user, 'retry', first.body.data.jobId);
  await waitFor(() => getRefreshJob(routes, user, retry.body.data.jobId).body.data.state === 'completed', 'retry did not finish');
  assert.deepEqual(refreshed, ['1', '2', '3', '2']);
  assert.equal(retry.body.data.total, 1);
  const denied = await startRefresh(routes, { username: 'bob', role: 'user' }, 'steal', first.body.data.jobId);
  assert.equal(denied.statusCode, 404);
});

test('restarting preserves deduplication and excludes the uncertain account from retries', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createRefreshJobStore } = require('../src/models/refresh-job-store');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-refresh-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'jobs.json');
  const now = Date.now();
  createRefreshJobStore({ filePath }).save([{
    id: 'restart-job', username: 'alice', requestKey: 'alice:same-request', state: 'running',
    total: 4, completed: 2, success: 1, failed: 1, skipped: 0,
    targets: ['1', '2', '3', '4'].map(id => ({ id, name: id, code: 'private-code' })),
    currentAccount: { id: '3', name: '未确认' },
    results: [{ accountId: '1', name: '成功', ok: true }, { accountId: '2', name: '失败', ok: false }],
    createdAt: now, updatedAt: now,
    code: 'private-code', wxid: 'private-wxid', token: 'private-token',
  }]);
  assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), /private-/);
  const accounts = ['1', '2', '3', '4'].map(id => ({ id, wxid: `wx-${id}`, username: 'alice' }));
  const refreshed = [];
  const routes = setup(accounts, async (id) => {
    refreshed.push(id);
    return { ok: true };
  }, { refreshJobStore: createRefreshJobStore({ filePath }) });
  const user = { username: 'alice', role: 'user' };
  const recovered = getRefreshJob(routes, user, 'restart-job').body.data;
  assert.equal(recovered.state, 'interrupted');
  assert.equal(recovered.success, 1);
  assert.equal(recovered.uncertainAccount.id, '3');
  assert.deepEqual(recovered.retryableAccountIds, ['2', '4']);
  const duplicate = await startRefresh(routes, user, 'same-request');
  assert.equal(duplicate.body.data.jobId, 'restart-job');
  assert.deepEqual(refreshed, []);
  const retry = await startRefresh(routes, user, 'new-request', 'restart-job');
  await waitFor(() => getRefreshJob(routes, user, retry.body.data.jobId).body.data.state === 'completed', 'restart retry did not finish');
  assert.deepEqual(refreshed, ['2', '4']);
  const restartedAgain = setup(accounts, async () => assert.fail('completed job was replayed'), {
    refreshJobStore: createRefreshJobStore({ filePath }),
  });
  const repeated = await startRefresh(restartedAgain, user, 'new-request');
  assert.equal(repeated.body.data.state, 'completed');
  assert.equal(repeated.body.data.success, 2);
});

test('persistence failure prevents credential operations', async () => {
  let writes = 0;
  let refreshCalls = 0;
  const routes = setup([{ id: '1', wxid: 'wx' }], async () => { refreshCalls++; }, {
    refreshJobStore: { load: () => [], save() { if (++writes > 1) throw new Error('磁盘不可写'); } },
  });
  const res = await startRefresh(routes, { username: 'admin', role: 'admin' });
  assert.equal(res.statusCode, 500);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshCalls, 0);
});

test('a full history preserves request-id deduplication before making space for new jobs', async () => {
  const now = Date.now();
  const jobs = Array.from({ length: 100 }, (_, index) => ({
    id: `job-${index}`, username: 'admin', requestKey: `admin:request-${index}`,
    state: 'completed', total: 1, completed: 1, success: 1, failed: 0, skipped: 0,
    targets: [{ id: '1', name: 'Account' }], currentAccount: null,
    results: [{ accountId: '1', name: 'Account', ok: true }], createdAt: now, updatedAt: now,
  }));
  let refreshCalls = 0;
  const routes = setup([{ id: '1', wxid: 'wx' }], async () => { refreshCalls++; return { ok: true }; }, {
    refreshJobStore: { load: () => jobs, save() {} },
  });
  const user = { username: 'admin', role: 'admin' };
  const duplicate = await startRefresh(routes, user, 'request-0');
  assert.equal(duplicate.body.data.jobId, 'job-0');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshCalls, 0);
  const next = await startRefresh(routes, user, 'new-request');
  assert.equal(next.statusCode, 202);
  await waitFor(() => getRefreshJob(routes, user, next.body.data.jobId).body.data.state === 'completed', 'new job did not finish');
  assert.equal(refreshCalls, 1);
  assert.equal(getRefreshJob(routes, user, 'job-0').statusCode, 404);
});

test('refresh errors redact credentials before persistence and when returned to the browser', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createRefreshJobStore } = require('../src/models/refresh-job-store');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-refresh-redaction-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'jobs.json');
  const routes = setup([{ id: '1', wxid: 'wx', username: 'alice' }], async () => ({
    ok: false,
    error: 'request failed https://example.test/?api_key=secret-key&token=secret-token&wxid=private-wxid&code=private-code Bearer secret-bearer',
  }), { refreshJobStore: createRefreshJobStore({ filePath }) });
  const user = { username: 'alice', role: 'user' };
  const started = await startRefresh(routes, user);
  await waitFor(() => getRefreshJob(routes, user, started.body.data.jobId).body.data.state === 'completed', 'job did not finish');
  const finished = getRefreshJob(routes, user, started.body.data.jobId).body.data;
  const saved = fs.readFileSync(filePath, 'utf8');
  for (const secret of ['secret-key', 'secret-token', 'private-wxid', 'private-code', 'secret-bearer']) {
    assert.doesNotMatch(saved, new RegExp(secret));
    assert.doesNotMatch(finished.results[0].error, new RegExp(secret));
  }
  assert.match(finished.results[0].error, /api_key=\[已隐藏\]/);
});

test('native QQ accounts with a stale wxid never enter the WX batch refresh queue', async () => {
  let calls = 0;
  const routes = setup([{ id: 'qq-1', username: 'alice', platform: 'qq', wxid: 'old-wxid', loginType: 'manual' }], async () => { calls++; return { ok: true }; });
  const started = await startRefresh(routes, { username: 'alice', role: 'user' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.equal(started.body.data.total, 0);
});
