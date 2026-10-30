const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const userStore = require('../src/models/user-store');
const { registerAdminCardRoutes } = require('../src/controllers/admin-card-routes');

test('public card claims use the socket source and cannot bypass the limit using forwarded headers', async t => {
  const app = express();
  app.use(express.json());
  registerAdminCardRoutes({ app, userStore,
    requireAdminToken: (req, res, next) => next(), requireAdminRole: (req, res, next) => next(),
    requireDangerConfirmation: () => true, adminLogger: { info() {}, warn() {} },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body, headers = {}) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  userStore.createCardsBatch('route fixture', 1, 3);
  userStore.setCardClaimStatus(true);
  assert.equal((await request('/api/admin/card-claim/status', { enabled: 'false' })).status, 400);
  const first = await request('/api/card-claim/claim', {}, { 'user-agent': 'browser-a', 'x-forwarded-for': '192.0.2.1' });
  assert.equal(first.status, 200);
  const claimed = await first.json();
  const second = await request('/api/card-claim/claim', {}, { 'user-agent': 'browser-b', 'x-forwarded-for': '192.0.2.2' });
  assert.equal(second.status, 400);
  assert.ok((await second.json()).remainingMs > 0);
  assert.equal(userStore.getAvailableTimeCardCount(), 2);
  const record = userStore.getCardClaimRecords().find(record => record.cardCode === claimed.cardCode);
  assert.match(record.ipHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(record).includes('127.0.0.1'), false);
});
