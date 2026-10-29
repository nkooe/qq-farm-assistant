// Shared Windows/Linux source and portable-release supervisor.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { runtimeEnvironment, inspectRuntime, ensureToken, commandExists } = require('./runtime.cjs');
const root = path.resolve(__dirname, '..');
const env = runtimeEnvironment(root);
const stateFile = path.join(env.FARM_DATA_DIR, 'launcher.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function request(port, route, token, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: Number(port), path: route, method, timeout: 1500,
      headers: token ? { authorization: 'Bearer ' + token } : {} }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; if (body.length > 1024 * 1024) req.destroy(new Error('Response too large')); });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); } catch { reject(new Error('Invalid service response')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Service timeout')));
    req.on('error', reject);
    req.end();
  });
}
async function healthy(port, kind) {
  try {
    const reply = await request(port, kind === 'bot' ? '/api/health' : '/health');
    return reply.status === 200 && (kind === 'bot' ? reply.data.ok === true && reply.data.status === 'ok' : reply.data.data?.ok === true);
  } catch { return false; }
}
function readState() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; } }
async function control(action = 'status') {
  const state = readState();
  if (!state?.port || !state.token) return null;
  try {
    const reply = await request(state.port, '/' + action, state.token, action === 'stop' ? 'POST' : 'GET');
    return reply.status === 200 ? reply.data : null;
  } catch { return null; }
}
async function waitFor(port, kind, child, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode || child.spawnError)) throw new Error(kind + ' exited during startup. See launcher logs.');
    if (await healthy(port, kind)) return;
    await sleep(250);
  }
  throw new Error(kind + ' did not become healthy before the startup deadline.');
}
function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, env, windowsHide: true, stdio: 'inherit', ...options });
    child.once('error', () => reject(new Error('Cannot run ' + path.basename(file))));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(path.basename(file) + ' failed (' + code + ')')));
  });
}
async function setup(runCommand = run) {
  const report = inspectRuntime(root, env);
  for (const check of report.checks.filter(check => !check.ok && ['platform', 'node', 'admin_port', 'yyb_port', 'distinct_ports'].includes(check.id)))
    throw new Error(check.message);
  const pnpm = async args => {
    // Only fixed package-manager commands go through cmd.exe.
    if (process.platform === 'win32') {
      const command = commandExists('pnpm') ? 'pnpm' : 'corepack pnpm';
      await runCommand('cmd.exe', ['/d', '/s', '/c', command + ' ' + args.join(' ')]);
    } else {
      const corepack = commandExists('corepack');
      await runCommand(corepack ? 'corepack' : 'pnpm', corepack ? ['pnpm', ...args] : args);
    }
  };
  if (!report.checks.find(check => check.id === 'dependencies').ok) await pnpm(['install', '--frozen-lockfile']);
  if (!report.checks.find(check => check.id === 'web').ok) await pnpm(['build:web']);
  if (!fs.existsSync(env.YYB_EXECUTABLE)) {
    if (!commandExists('go')) throw new Error('Go is required to build the missing YYB service. Use a complete release or install Go.');
    fs.mkdirSync(path.dirname(env.YYB_EXECUTABLE), { recursive: true });
    await runCommand('go', ['build', '-o', env.YYB_EXECUTABLE, './cmd/yyb-go'], { cwd: path.join(root, 'yyb-go') });
  }
  const failures = inspectRuntime(root, env).checks.filter(check => !check.ok);
  if (failures.length) throw new Error(failures.map(check => check.message).join('\n'));
}
async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode || child.spawnError) return;
  if (process.platform === 'win32') {
    await run('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }).catch(() => {});
  } else {
    const signal = value => { try { if (child.managedGroup) process.kill(-child.pid, value); else child.kill(value); } catch {} };
    signal('SIGTERM');
    const deadline = Date.now() + 5000;
    while (child.exitCode === null && !child.signalCode && Date.now() < deadline) await sleep(50);
    signal('SIGKILL');
  }
}
async function serve() {
  fs.mkdirSync(env.FARM_DATA_DIR, { recursive: true });
  const old = readState();
  if (old) {
    if (await control()) throw new Error('This project is already managed by a running launcher.');
    let alive = false;
    try { if (old.pid !== process.pid) { process.kill(old.pid, 0); alive = true; } } catch {}
    if (alive) throw new Error('A launcher is still starting or stopping. Retry shortly.');
    fs.unlinkSync(stateFile);
  }
  const token = crypto.randomBytes(32).toString('hex');
  const descriptor = fs.openSync(stateFile, 'wx', 0o600);
  fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, port: 0 }));
  fs.closeSync(descriptor);
  const children = [];
  let stopping = false; let ready = false; let shutdownPromise;
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401).end(); return; }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/status' && req.method === 'GET') return res.end(JSON.stringify({ running: true, ready, pid: process.pid }));
    if (req.url === '/stop' && req.method === 'POST') {
      res.end(JSON.stringify({ stopping: true }));
      void shutdown();
    } else res.writeHead(404).end();
  });
  const shutdown = () => shutdownPromise ||= (async () => {
    stopping = true;
    for (const child of [...children].reverse()) await terminate(child);
    await new Promise(resolve => server.close(resolve));
    if (readState()?.token === token) fs.unlinkSync(stateFile);
  })();
  const startChild = (file, args, options = {}) => {
    if (stopping) throw new Error('Startup cancelled.');
    const child = spawn(file, args, { cwd: root, env, windowsHide: true, detached: process.platform !== 'win32',
      stdio: 'inherit', ...options });
    child.managedGroup = process.platform !== 'win32';
    children.push(child);
    child.once('error', () => { child.spawnError = true; });
    child.once('exit', () => {
      if (ready && !stopping) { console.error('[ERROR] A managed service exited; shutting down this launcher.'); process.exitCode = 1; void shutdown(); }
    });
    return child;
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    fs.writeFileSync(stateFile, JSON.stringify({ pid: process.pid, token, port: server.address().port }), { mode: 0o600 });
    await setup((file, args, options) => new Promise((resolve, reject) => {
      const child = startChild(file, args, options);
      child.once('error', () => reject(new Error('Cannot run ' + path.basename(file))));
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(path.basename(file) + ' failed (' + code + ')')));
    }));
    if (stopping) return;
    ensureToken(env);
    if (process.platform === 'linux' && env.QQ_LOGIN_ENABLED !== '0' && !env.DISPLAY) {
      const display = startChild('Xvfb', ['-displayfd', '3', '-screen', '0', '1024x768x24', '-nolisten', 'tcp'],
        { stdio: ['ignore', 'ignore', 'inherit', 'pipe'] });
      const number = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Xvfb startup timed out')), 5000);
        display.once('error', () => { clearTimeout(timer); reject(new Error('Cannot start Xvfb')); });
        display.once('exit', () => { clearTimeout(timer); reject(new Error('Xvfb exited')); });
        display.stdio[3].once('data', chunk => { clearTimeout(timer); resolve(String(chunk).trim()); });
      });
      if (!/^\d+$/.test(number)) throw new Error('Invalid Xvfb display');
      env.DISPLAY = ':' + number;
    }
    if (await healthy(env.YYB_PORT, 'yyb')) {
      const auth = await request(env.YYB_PORT, '/accounts', env.YYB_API_TOKEN);
      if (auth.status !== 200) throw new Error('YYB port is owned by another service or uses a different token.');
      console.log('[INFO] Reusing the authenticated YYB service; it will not be stopped by this launcher.');
    } else {
      const yyb = startChild(env.YYB_EXECUTABLE, ['-host', '127.0.0.1', '-port', env.YYB_PORT, '-resource-root', env.YYB_RESOURCE_ROOT], { cwd: path.dirname(env.YYB_RESOURCE_ROOT) });
      await waitFor(env.YYB_PORT, 'yyb', yyb);
    }
    if (stopping) return;
    if (await healthy(env.ADMIN_PORT, 'bot')) throw new Error('The panel is already running outside this launcher. Stop that instance first.');
    const bot = startChild(process.execPath, [path.join(root, 'core', 'client.js')], { cwd: path.join(root, 'core') });
    await waitFor(env.ADMIN_PORT, 'bot', bot);
    if (stopping) return;
    ready = true;
    console.log('[OK] Panel: http://localhost:' + env.ADMIN_PORT);
    console.log('[OK] QQ and YYB are managed automatically.');
  } catch (error) {
    console.error('[ERROR] ' + error.message);
    process.exitCode = 1;
    await shutdown();
  }
}
async function main() {
  const command = process.argv[2] || 'doctor';
  if (command === 'doctor') {
    const report = inspectRuntime(root, env);
    if (process.argv.includes('--json')) console.log(JSON.stringify(report));
    else for (const check of report.checks) console.log((check.ok ? '[OK] ' : '[MISSING] ') + check.id + ': ' + check.message);
    process.exitCode = report.ok ? 0 : 1;
  } else if (command === 'serve') await serve();
  else if (command === 'status') {
    const status = await control();
    console.log(JSON.stringify(status || { running: false, panelReachable: await healthy(env.ADMIN_PORT, 'bot') }));
  } else if (command === 'stop') {
    const state = readState();
    if (!await control('stop')) {
      if (state) throw new Error('Launcher control unavailable. No unrelated process was stopped.');
      console.log('[INFO] No managed launcher is running.'); return;
    }
    for (let count = 0; count < 60; count++) {
      if (readState()?.token !== state.token) { console.log('[OK] Managed services stopped.'); return; }
      await sleep(200);
    }
    throw new Error('Service shutdown is still in progress. Check launcher logs.');
  } else if (command === 'start') {
    if (await control()) { console.log('[INFO] Launcher is already running.'); return; }
    const logs = path.join(env.FARM_DATA_DIR, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    const fd = fs.openSync(path.join(logs, 'launcher.log'), 'a', 0o600);
    const child = spawn(process.execPath, [__filename, 'serve'], { cwd: root, env, windowsHide: true, detached: true, stdio: ['ignore', fd, fd] });
    let spawnFailed = false;
    child.once('error', () => { spawnFailed = true; });
    fs.closeSync(fd); child.unref();
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      if ((await control())?.ready) { console.log('[OK] Panel: http://localhost:' + env.ADMIN_PORT); return; }
      if (spawnFailed || child.exitCode !== null || child.signalCode) throw new Error('Startup failed. See ' + path.join(logs, 'launcher.log'));
      await sleep(500);
    }
    await control('stop');
    throw new Error('Startup timed out. See launcher.log.');
  } else throw new Error('Usage: node scripts/farm.cjs doctor [--json] | start | serve | status | stop');
}
if (require.main === module) main().catch(error => { console.error('[ERROR] ' + error.message); process.exitCode = 1; });
module.exports = { request, healthy };
