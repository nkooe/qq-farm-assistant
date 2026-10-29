const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runtimeEnvironment(root, input = process.env, platform = process.platform) {
  const data = path.resolve(input.FARM_DATA_DIR || path.join(root, 'core', 'data'));
  const env = { ...input, FARM_DATA_DIR: data, ADMIN_PORT: input.ADMIN_PORT || '3900',
    YYB_HOST: '127.0.0.1', YYB_PORT: input.YYB_PORT || '8450',
    YYB_RESOURCE_ROOT: input.YYB_RESOURCE_ROOT || path.join(root, 'yyb-go', 'resource') };
  env.YYB_API_URL ||= 'http://127.0.0.1:' + env.YYB_PORT;
  env.YYB_EXECUTABLE ||= path.join(data, 'bin', platform === 'win32' ? 'yyb-go.exe' : 'yyb-go');
  if (fs.existsSync(path.join(root, 'runtime', platform === 'win32' ? 'yyb-go.exe' : 'yyb-go')) && !input.YYB_EXECUTABLE)
    env.YYB_EXECUTABLE = path.join(root, 'runtime', platform === 'win32' ? 'yyb-go.exe' : 'yyb-go');
  if (platform === 'linux' && fs.existsSync('/opt/qq-login/wrapper.node')) {
    env.QQ_LOGIN_RUNTIME_DIR ||= '/opt/qq-login';
    env.QQ_LOGIN_EXECUTABLE ||= '/opt/QQ/qq';
    env.QQ_LOGIN_ELECTRON ||= '1';
    env.LD_LIBRARY_PATH ||= '/opt/QQ/resources/app/sharp-lib:/opt/QQ/resources/app:/opt/QQ';
  }
  return env;
}

function commandExists(name, platform = process.platform) {
  return spawnSync(platform === 'win32' ? 'where.exe' : 'which', [name], { windowsHide: true, stdio: 'ignore' }).status === 0;
}

function inspectRuntime(root, env = runtimeEnvironment(root), options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const version = options.nodeVersion || process.versions.node;
  const [major, minor] = version.split('.').map(Number);
  const checks = [];
  const add = (id, ok, message) => checks.push({ id, ok, message });
  add('platform', platform === 'win32' && arch === 'x64' || platform === 'linux' && ['x64', 'arm64'].includes(arch),
    'Supported: Windows x64, Linux x64/arm64. Linux QQ requires glibc; Docker is recommended.');
  add('node', major === 22 && minor >= 12 || major === 24, 'Use Node.js 24 LTS (or 22.12+ LTS). Detected: ' + version);
  for (const key of ['ADMIN_PORT', 'YYB_PORT'])
    add(key.toLowerCase(), /^\d+$/.test(env[key]) && Number(env[key]) >= 1 && Number(env[key]) <= 65535, key + ' must be a port from 1 to 65535.');
  add('distinct_ports', Number(env.ADMIN_PORT) !== Number(env.YYB_PORT), 'Panel and YYB must use different ports.');
  let dependencies = true;
  for (const name of ['express', 'ws', 'socket.io']) {
    try { require(require.resolve(name, { paths: [path.join(root, 'core')] })); } catch { dependencies = false; }
  }
  add('dependencies', dependencies, 'Install dependencies: pnpm install --frozen-lockfile');
  add('web', fs.existsSync(path.join(root, 'web', 'dist', 'index.html')), 'Build web panel: pnpm build:web');
  add('yyb', fs.existsSync(env.YYB_EXECUTABLE), 'YYB binary is required; the source launcher builds it with Go if missing.');
  if (env.QQ_LOGIN_ENABLED !== '0') {
    const component = env.QQ_LOGIN_COMPONENT_DIR || path.join(root, 'core', 'qq-login');
    const runtime = env.QQ_LOGIN_RUNTIME_DIR || path.join(component, 'native', platform + '-' + arch);
    const executable = env.QQ_LOGIN_EXECUTABLE || path.join(runtime, platform === 'win32' ? 'node.exe' : 'qq');
    const files = ['host.mjs', 'qq-native-login.mjs'].map(name => path.join(component, name))
      .concat(['wrapper.node', 'napcat/napcat.mjs', 'package.json', 'config.json'].map(name => path.join(runtime, name)), executable);
    add('qq', files.every(file => fs.existsSync(file)), platform === 'win32'
      ? 'Install core/qq-login/native/win32-x64 with scripts/install-qq-login-windows.ps1.'
      : 'Install the QQ runtime and native libraries; recommended: docker compose up -d --build');
    if (platform === 'linux')
      add('display', !!env.DISPLAY || commandExists('Xvfb', platform), 'A display is required; the launcher can start Xvfb automatically.');
  }
  return { ok: checks.every(check => check.ok), platform, arch, node: version, checks };
}

function ensureToken(env) {
  const file = env.YYB_TOKEN_FILE || path.join(env.FARM_DATA_DIR, 'yyb_token');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let token = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  if (!token) {
    token = env.YYB_API_TOKEN || env.YYB_API_KEY || require('node:crypto').randomBytes(32).toString('hex');
    fs.writeFileSync(file, token, { mode: 0o600 });
  }
  env.YYB_API_TOKEN = token;
  env.YYB_API_KEY = token;
}

module.exports = { runtimeEnvironment, inspectRuntime, ensureToken, commandExists };
