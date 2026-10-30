const test = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate } = require('node:timers/promises');
const store = require('../src/models/store');
const workerModule = require('../src/runtime/worker-manager');

function harness(t) {
  let finish; const first = new Promise(resolve => { finish = resolve; });
  const accounts = [1, 2, 3, 4].map(id => ({ id: String(id), userId: 1000, autoStart: true, code: `old-${id}` }));
  const calls = [];
  t.mock.method(store, 'getAccounts', () => ({ accounts: structuredClone(accounts) }));
  t.mock.method(workerModule, 'createWorkerManager', () => ({
    startWorker: async (account, options) => { calls.push({ ...account, options }); if (account.id === '1') await first; return true; },
    stopWorker() {}, getWorkerRuntime: () => null,
  }));
  delete require.cache[require.resolve('../src/runtime/runtime-engine')];
  const engine = require('../src/runtime/runtime-engine').createRuntimeEngine();
  t.after(() => { engine.stopAllAccounts(); delete require.cache[require.resolve('../src/runtime/runtime-engine')]; });
  return { engine, accounts, calls, finish };
}

test('boot restoration rereads stopped, deleted and changed accounts after awaiting earlier startup', async t => {
  const h = harness(t); const restoring = h.engine.startAllAccounts();
  await setImmediate();
  h.accounts[1].autoStart = false;
  h.accounts.splice(2, 1);
  h.accounts[2].code = 'fresh-4';
  h.finish(); await restoring;
  assert.deepEqual(h.calls.map(account => account.id), ['1', '4']);
  assert.equal(h.calls[1].code, 'fresh-4');
  assert(h.calls.every(account => account.options?.automatic === true));
});

test('stopping the runtime cancels all queued boot restoration starts', async t => {
  const h = harness(t); const restoring = h.engine.startAllAccounts();
  await setImmediate(); h.engine.stopAllAccounts(); h.finish(); await restoring;
  assert.deepEqual(h.calls.map(account => account.id), ['1']);
});
