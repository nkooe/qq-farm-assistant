const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function run(source, variables = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-license-config-'));
  const env = { ...process.env, FARM_DATA_DIR: directory };
  delete env.FARM_LICENSE_ENABLED;
  delete env.FARM_LICENSE_SECRET;
  Object.assign(env, variables);
  try {
    return spawnSync(process.execPath, ['-e', source], {
      cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 10000,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('public source starts with legacy machine licensing disabled and no embedded seed', () => {
  const result = run(`const assert = require('node:assert/strict');
    const service = require('./src/services/license');
    assert.equal(service.LICENSE_ENABLED, false);
    assert.equal(service.LICENSE_SECRET, '');
    service.verifyAndRun().then(value => assert.equal(value, true));`);
  assert.equal(result.status, 0, result.stderr);
});

test('enabling machine licensing without a seed fails before startup', () => {
  const result = run("require('./src/services/license')", { FARM_LICENSE_ENABLED: 'true' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FARM_LICENSE_SECRET is required/);
});

test('license generation requires an installation seed even when licensing is disabled', () => {
  const result = run(`const assert = require('node:assert/strict');
    const service = require('./src/services/license');
    assert.throws(() => service.generateLicenseKey('ABCDEF1234567890'), /FARM_LICENSE_SECRET/);`);
  assert.equal(result.status, 0, result.stderr);
});

test('explicit installation seeds retain deterministic license generation', () => {
  const result = run(`const assert = require('node:assert/strict');
    const service = require('./src/services/license');
    const key = service.generateLicenseKey('ABCDEF1234567890');
    assert.match(key, /^[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/);
    assert.equal(service.generateLicenseKey('ABCD-EF12-3456-7890'), key);`, {
    FARM_LICENSE_ENABLED: 'true', FARM_LICENSE_SECRET: crypto.randomBytes(32).toString('hex'),
  });
  assert.equal(result.status, 0, result.stderr);
});
