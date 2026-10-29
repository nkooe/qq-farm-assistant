const test = require('node:test');
const assert = require('node:assert/strict');

const adapter = import('../qq-login/qq-native-login.mjs');
const code = 'fixture_CODE_12345678';

test('native identity waits for observed self information and never substitutes the requested account', async () => {
  const { waitForIdentity, describeIdentity } = await adapter;
  const self = { uin: '' };
  setTimeout(() => { self.uin = 12345678; }, 15);
  assert.equal(await waitForIdentity(self, { timeoutMs: 1000, intervalMs: 5 }), '12345678');
  assert.deepEqual(describeIdentity(self), { type: 'number', length: 8, valid: true });
  await assert.rejects(waitForIdentity({}, { timeoutMs: 10, intervalMs: 5 }), /尚未就绪/);
});

test('native host forwards only a valid saved identity to the quick-login argv', async t => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-host-quick-login-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'napcat'));
  // Execute the actual host bootstrap, substituting only the native module.
  fs.writeFileSync(path.join(root, 'napcat', 'napcat.mjs'), [
    "const index = process.argv.indexOf('-q');",
    "const expected = process.env.EXPECT_RESTORE === '1';",
    "if (expected ? index < 0 || process.argv[index + 1] !== '12345678' : index >= 0) process.exit(9);",
    "await globalThis.__qqFarmLogin.ready({ getNodeMiscService: () => ({ loginWithAppId: async () => ({ errCode: 0, result: 'fixture_HOST_CODE_12345678' }) }) }, { uin: '12345678' });",
    'process.exit(0);',
  ].join('\n'));
  for (const [uin, expected] of [['12345678', '1'], ['invalid-identity', '0'], ['', '0']]) {
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(__dirname, '../qq-login/host.mjs'), root, path.join(root, 'profile')], {
      env: { ...process.env, FARM_QQ_RUNTIME: root, FARM_QQ_SESSION_DIR: path.join(root, 'profile'), FARM_QQ_RESTORE_UIN: uin, EXPECT_RESTORE: expected }, timeout: 10000, windowsHide: true,
    });
    const events = stdout.trim().split('\n').map(line => JSON.parse(line.slice('QQFARM_LOGIN:'.length)));
    assert(events.some(event => event.kind === 'code' && event.value.code === 'fixture_HOST_CODE_12345678'));
  }
});

test('native adapter accepts only a successful opaque result', async () => {
  const { decodeLoginResult } = await adapter;
  assert.equal(decodeLoginResult({ errCode: 0, result: code }), code);
  for (const reply of [{ errCode: -3000, result: code }, { errCode: 0, result: '' },
    { errCode: 0 }, { errCode: 0, result: '123456789' },
    { errCode: 0, result: { code } }, { code },
    { errCode: 0, result: JSON.stringify({ code }) }]) {
    assert.throws(() => decodeLoginResult(reply));
  }
});

test('invalid native results expose structure without private values or arbitrary keys', async () => {
  const { decodeLoginResult, describeLoginResult } = await adapter;
  const privateValue = 'private-value-must-never-escape';
  const reply = { errCode: 0, errMsg: privateValue, result: JSON.stringify({ code: privateValue, [privateValue]: privateValue }) };
  const diagnostic = describeLoginResult(reply);
  assert.deepEqual(diagnostic.jsonFields, ['code']);
  assert.equal(diagnostic.codeType, 'string');
  assert.equal(JSON.stringify(diagnostic).includes(privateValue), false);
  assert.throws(() => decodeLoginResult(reply), error => {
    assert.equal(error.message.includes(privateValue), false);
    assert.deepEqual(error.diagnostic, diagnostic);
    return true;
  });
  assert.equal(describeLoginResult({ errCode: 0, result: '' }).syntax, 'empty');
  assert.equal(describeLoginResult({ errCode: 0 }).resultType, 'undefined');
});

test('native authorization is attempted once and honors timeout and cancellation', async () => {
  const { requestFarmCode } = await adapter;
  const calls = [];
  const session = { getNodeMiscService: () => ({ loginWithAppId: async id => { calls.push(id); return { errCode: 0, result: code }; } }) };
  assert.deepEqual(await requestFarmCode(session), { code });
  assert.deepEqual(calls, ['1112386029']);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(requestFarmCode(session, { signal: controller.signal }), /取消/);
  assert.equal(calls.length, 1);
  let attempts = 0;
  await assert.rejects(requestFarmCode({ getNodeMiscService: () => ({ loginWithAppId() { attempts++; return new Promise(() => {}); } }) }, { timeoutMs: 10 }), /超时/);
  assert.equal(attempts, 1);
});
