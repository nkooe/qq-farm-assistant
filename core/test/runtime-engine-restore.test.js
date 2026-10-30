const test = require('node:test');
const assert = require('node:assert/strict');
const { getRestorableAccounts } = require('../src/runtime/runtime-engine');

test('boot restore accepts only explicitly enabled accounts and excludes pending deletion', () => {
  const accounts = [
    { id: '1', name: 'legacy-without-flag' },
    { id: '2', name: 'running', autoStart: true },
    { id: '3', name: 'stopped', autoStart: false },
    { id: '4', name: 'deleting', autoStart: true, deleting: true },
    null,
  ];
  assert.deepEqual(getRestorableAccounts(accounts).map(account => account.id), ['2']);
  assert.deepEqual(getRestorableAccounts(null), []);
});
