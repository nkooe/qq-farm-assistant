const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdminRealtime } = require('../src/controllers/admin-realtime');

function harness() {
  const users = new Map([[1001, { id: 1001, role: 'user' }], [1002, { id: 1002, role: 'user' }], [1000, { id: 1000, role: 'admin' }]]);
  const owners = new Map([['1', 1001], ['2', 1002]]);
  const logs = [{ accountId: '1', message: 1001 }, { accountId: '2', message: 1002 }, { message: 'global' }];
  const sockets = new Map();
  const realtime = createAdminRealtime({
    provider: { getStatus: id => ({ id }), getLogs: id => logs.filter(log => !id || log.accountId === id), getAccountLogs: () => logs },
    getIo: () => ({ sockets: { sockets } }), getSession: token => users.get(token), getSessionRejection: user => user.deleting,
    getAccessibleAccountIdsForUser: user => [...owners].filter(([, name]) => user.role === 'admin' || name === user.id).map(([id]) => id),
    resolveAccountReference: ref => owners.has(ref) ? ref : '',
  });
  function socket(token) {
    const result = { data: { adminToken: token }, events: [], disconnected: false,
      emit(event, payload) { this.events.push([event, payload]); }, disconnect() { this.disconnected = true; } };
    sockets.set(token, result); return result;
  }
  return { realtime, socket, owners, users };
}

test('all subscriptions and log clearing never disclose another user or global logs', () => {
  const h = harness(), alice = h.socket(1001), root = h.socket(1000);
  h.realtime.subscribe(alice, 'all'); h.realtime.subscribe(root, 'all');
  assert.deepEqual(alice.events.find(([event]) => event === 'logs:snapshot')[1].logs.map(log => log.message), [1001]);
  assert.equal(root.events.find(([event]) => event === 'logs:snapshot')[1].logs.length, 3);
  alice.events.length = 0;
  h.realtime.refreshLogs('2'); assert.deepEqual(alice.events, []);
  h.realtime.refreshLogs('1'); assert.deepEqual(alice.events.find(([event]) => event === 'logs:snapshot')[1].logs.map(log => log.message), [1001]);
});

test('unknown or foreign subscriptions disconnect without a broader snapshot', () => {
  for (const ref of ['2', 'missing']) {
    const h = harness(), alice = h.socket(1001); h.realtime.subscribe(alice, ref);
    assert.equal(alice.disconnected, true);
    assert.equal(alice.events.some(([event]) => event === 'logs:snapshot'), false);
  }
});

test('ownership changes and deleted identities invalidate existing live subscriptions', () => {
  const h = harness(), alice = h.socket(1001); h.realtime.subscribe(alice, '1');
  alice.events.length = 0; h.owners.set('1', 1002); h.realtime.emit('1', 'logs:new', { message: 1002 });
  assert.equal(alice.disconnected, true); assert.deepEqual(alice.events, []);
  const bob = h.socket(1002); h.realtime.subscribe(bob, 'all'); bob.events.length = 0;
  h.users.delete(1002); h.realtime.emit('2', 'logs:new', {});
  assert.equal(bob.disconnected, true); assert.deepEqual(bob.events, []);
});
