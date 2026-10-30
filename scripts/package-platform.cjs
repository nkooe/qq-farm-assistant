const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { copyProductionDependencies } = require('./copy-production-deps.cjs');
const root = path.resolve(__dirname, '..');
const target = process.argv[2];
if (!['win32-x64', 'linux-docker'].includes(target)) throw new Error('Target must be win32-x64 or linux-docker');
if (target === 'win32-x64' && (process.platform !== 'win32' || process.arch !== 'x64')) throw new Error('Build the Windows release on Windows x64.');
const parent = path.join(root, 'dist');
const out = path.join(parent, 'qq-farm-' + target);
fs.mkdirSync(parent, { recursive: true });
const staging = fs.mkdtempSync(path.join(parent, '.platform-'));
const copy = (relative, destination = relative, options = {}) => {
  const source = path.join(root, relative);
  if (!fs.existsSync(source)) { if (options.required !== false) throw new Error('Missing release input: ' + relative); return; }
  fs.mkdirSync(path.dirname(path.join(staging, destination)), { recursive: true });
  fs.cpSync(source, path.join(staging, destination), { recursive: true, dereference: true,
    filter: file => !path.relative(source, file).split(path.sep).some(part => ['node_modules', '.git', 'data', 'db', 'logs', 'avatars', 'qr', 'native', 'test-results', 'playwright-report', 'coverage', '.cache'].includes(part))
      && !/^(\.env(?:\..*)?|.*\.(log|db|sqlite|dmp))$/.test(path.basename(file)), ...options });
};
try {
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'UPDATE_README.md', 'docker-compose.yml', '.dockerignore', 'start.bat', 'tingzhi.bat', 'start.sh', 'stop.sh']) copy(file);
  for (const file of ['client.js', 'package.json', 'src', 'docker', 'Dockerfile', 'share.txt']) copy('core/' + file);
  for (const file of ['host.mjs', 'qq-native-login.mjs', 'patch-napcat.cjs', 'electron-launcher.cjs', 'install-linux.sh', 'licenses']) copy('core/qq-login/' + file);
  copy('scripts');
  copy('core/test');
  copy('web/dist');
  if (target === 'linux-docker') {
    copy('web');
    copy('yyb-go');
    fs.chmodSync(path.join(staging, 'start.sh'), 0o755);
    fs.chmodSync(path.join(staging, 'stop.sh'), 0o755);
  } else {
    copy('yyb-go/resource');
    const runtime = path.join(root, 'core/qq-login/native/win32-x64');
    const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'manifest.json'), 'utf8'));
    if (manifest.qqVersion !== '9.9.35-52892' || manifest.napcatVersion !== '4.18.41') throw new Error('Unexpected QQ runtime version');
    for (const [file, expected] of Object.entries(manifest.files)) {
      if (file.split(/[\\/]/).some(part => ['..', 'logs', 'data', 'cache', 'state', 'qq-data'].includes(part))) throw new Error('Non-program runtime file');
      const source = path.join(runtime, file);
      const actual = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
      if (actual !== expected) throw new Error('Runtime checksum failed: ' + file);
      const destination = path.join(staging, 'core/qq-login/native/win32-x64', file);
      fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination);
    }
    fs.copyFileSync(path.join(runtime, 'manifest.json'), path.join(staging, 'core/qq-login/native/win32-x64/manifest.json'));
    const dependencies = copyProductionDependencies(path.join(root, 'core'), path.join(staging, 'core'));
    fs.writeFileSync(path.join(staging, 'dependencies.json'), JSON.stringify(dependencies, null, 2));
    fs.mkdirSync(path.join(staging, 'runtime'), { recursive: true });
    fs.copyFileSync(process.execPath, path.join(staging, 'runtime/node.exe'));
    fs.copyFileSync(path.join(root, 'core/qq-login/licenses/Node-LICENSE.txt'), path.join(staging, 'runtime/Node-LICENSE.txt'));
    const go = spawnSync('go', ['build', '-trimpath', '-o', path.join(staging, 'runtime/yyb-go.exe'), './cmd/yyb-go'], { cwd: path.join(root, 'yyb-go'), stdio: 'inherit', windowsHide: true });
    if (go.status !== 0) throw new Error('Cannot build YYB release binary');
  }
  const files = {};
  const walk = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Release must not contain external links');
    if (entry.isDirectory()) walk(file);
    else files[path.relative(staging, file).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } };
  walk(staging);
  fs.writeFileSync(path.join(staging, 'release-manifest.json'), JSON.stringify({ target, node: process.version, builtAt: new Date().toISOString(), files }, null, 2));
  fs.rmSync(out, { recursive: true, force: true });
  fs.renameSync(staging, out);
  console.log(JSON.stringify({ directory: out, files: Object.keys(files).length, target }));
} catch (error) { fs.rmSync(staging, { recursive: true, force: true }); throw error; }
