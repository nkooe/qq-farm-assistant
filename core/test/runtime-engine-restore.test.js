const test = require('node:test');
const assert = require('node:assert/strict');
const { getRestorableAccounts } = require('../src/runtime/runtime-engine');

test('boot restore includes running legacy accounts and excludes explicitly stopped accounts', () => {
  const accounts = [
    { id: '1', name: 'legacy-without-flag' },
    { id: '2', name: 'running', autoStart: true },
    { id: '3', name: 'stopped', autoStart: false },
    null,
  ];
  assert.deepEqual(getRestorableAccounts(accounts).map(account => account.id), ['1', '2']);
  assert.deepEqual(getRestorableAccounts(null), []);
});
