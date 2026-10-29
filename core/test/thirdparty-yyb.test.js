const test = require('node:test');
const assert = require('node:assert/strict');
const { getThirdpartyYybCode } = require('../src/utils/thirdpartyYyb');
const params = { apiBase: 'https://fixture.test', apiToken: 'fixture-token', openid: 'fixture-openid' };

for (const data of [{ code: 500 }, { data: { code: 12345678 } }, { success: false, data: { code: 'stale-code' } }, { ok: false, token: 'stale-code' }, { data: { code: '   ' } }]) {
  test(`third party status or failed envelopes cannot become credentials: ${JSON.stringify(data)}`, async t => {
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => data }));
    assert.equal((await getThirdpartyYybCode(params)).ok, false);
  });
}

for (const [status, kind] of [[401, 'configuration'], [403, 'configuration'], [409, 'rescan'], [429, 'busy'], [502, 'temporary']]) {
  test(`third party HTTP ${status} is classified as ${kind}`, async t => {
    t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status }));
    assert.equal((await getThirdpartyYybCode(params)).kind, kind);
  });
}

test('third party accepts a string Code and forwards cancellation to the request', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ success: true, data: { code: 'fresh-code' } }) }));
  assert.equal((await getThirdpartyYybCode(params)).code, 'fresh-code');
  const controller = new AbortController(); let signal;
  t.mock.method(globalThis, 'fetch', async (_url, options) => { signal = options.signal; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('request aborted'), { name: 'AbortError' })))); });
  const pending = getThirdpartyYybCode({ ...params, signal: controller.signal });
  controller.abort();
  assert.equal(signal.aborted, true);
  assert.equal((await pending).kind, 'cancelled');
});

test('third party timeout aborts its request without leaking connection secrets', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  t.mock.method(globalThis, 'fetch', async (_url, options) => { signal = options.signal; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('request aborted'), { name: 'AbortError' })))); });
  const pending = getThirdpartyYybCode(params);
  t.mock.timers.tick(10000);
  assert.equal((await pending).kind, 'timeout');
  assert.equal(signal.aborted, true);
});
