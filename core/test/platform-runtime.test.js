const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');
const { inspectRuntime, runtimeEnvironment, ensureToken } = require('../../scripts/runtime.cjs');
const { copyProductionDependencies } = require('../../scripts/copy-production-deps.cjs');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-platform-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('runtime checks identify a missing QQ component and disabled QQ does not block WX', t => {
  const root = temporary(t);
  const env = runtimeEnvironment(root, { ADMIN_PORT: '3900', YYB_PORT: '8450' }, 'win32');
  const report = inspectRuntime(root, env, { platform: 'win32', arch: 'x64', nodeVersion: '24.12.0' });
  assert.equal(report.checks.find(check => check.id === 'qq').ok, false);
  assert.equal(report.checks.find(check => check.id === 'yyb').ok, false);
  assert.equal(report.ok, false);
  assert.equal(inspectRuntime(root, { ...env, QQ_LOGIN_ENABLED: '0' }).checks.some(check => check.id === 'qq'), false);
  assert(!JSON.stringify(report).includes('YYB_API_KEY'));
});

test('runtime refuses invalid or identical ports before starting components', t => {
  const root = temporary(t);
  const env = runtimeEnvironment(root, { ADMIN_PORT: '8450', YYB_PORT: '08450' });
  assert.equal(inspectRuntime(root, env).checks.find(check => check.id === 'distinct_ports').ok, false);
  env.ADMIN_PORT = '3900/path';
  assert.equal(inspectRuntime(root, env).checks.find(check => check.id === 'admin_port').ok, false);
});

test('platform checks reject unsupported architectures and old Node runtime', t => {
  const root = temporary(t);
  for (const options of [{ platform: 'darwin', arch: 'x64' }, { platform: 'win32', arch: 'arm64' }]) {
    assert.equal(inspectRuntime(root, runtimeEnvironment(root, {}), options).checks.find(check => check.id === 'platform').ok, false);
  }
  assert.equal(inspectRuntime(root, runtimeEnvironment(root, {}), { nodeVersion: '18.20.0' }).checks.find(check => check.id === 'node').ok, false);
});

test('YYB token persists across restarts and both services receive the same private token', t => {
  const root = temporary(t);
  const first = runtimeEnvironment(root, {});
  ensureToken(first);
  const second = runtimeEnvironment(root, { YYB_API_TOKEN: 'ignored-new-value' });
  ensureToken(second);
  assert.equal(first.YYB_API_TOKEN, first.YYB_API_KEY);
  assert.equal(first.YYB_API_TOKEN, second.YYB_API_TOKEN);
  assert.equal(first.YYB_API_TOKEN.length, 64);
});

test('portable dependency copy retains version conflicts, cycles and built-in-named packages without junctions', t => {
  const root = temporary(t);
  const project = path.join(root, 'source'); const out = path.join(root, 'release');
  const put = (directory, value, body) => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ main: 'index.js', ...value }));
    fs.writeFileSync(path.join(directory, 'index.js'), body || 'module.exports = 1;');
  };
  put(project, { dependencies: { a: '1', shared: '1', string_decoder: '1' } });
  put(path.join(project, 'node_modules/a'), { name: 'a', version: '1', dependencies: { shared: '2' } }, "module.exports = require('shared');");
  put(path.join(project, 'node_modules/shared'), { name: 'shared', version: '1' }, "module.exports = 'root';");
  put(path.join(project, 'node_modules/a/node_modules/shared'), { name: 'shared', version: '2', dependencies: { a: '1' } }, "module.exports = 'nested';");
  put(path.join(project, 'node_modules/string_decoder'), { name: 'string_decoder', version: '1' });
  fs.mkdirSync(out);
  copyProductionDependencies(project, out);
  fs.renameSync(project, path.join(root, 'source-unavailable'));
  const requireOut = createRequire(path.join(out, 'package.json'));
  assert.equal(requireOut('a'), 'nested');
  assert.equal(requireOut('shared'), 'root');
  assert(fs.existsSync(path.join(out, 'node_modules/string_decoder/package.json')));
});

test('launcher health checks reject non-service HTML and unhealthy YYB data', async t => {
  const { healthy } = require('../../scripts/farm.cjs');
  let body = { data: { ok: true } };
  const server = http.createServer((_req, res) => { res.end(typeof body === 'string' ? body : JSON.stringify(body)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  assert.equal(await healthy(port, 'yyb'), true);
  body = { data: { ok: false } };
  assert.equal(await healthy(port, 'yyb'), false);
  body = 'unrelated web page';
  assert.equal(await healthy(port, 'bot'), false);
});
