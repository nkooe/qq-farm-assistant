// Read-only natural-load sampling. Run inside the application container with Node 20+.
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');

const duration = Number(process.argv[2] || 600);
const interval = Number(process.argv[3] || 15);
if (!(duration >= 1 && duration <= 86400 && interval >= 1 && interval <= duration))
  throw new Error('Usage: node sample-runtime.cjs [durationSeconds=600] [intervalSeconds=15]');
const base = 'http://127.0.0.1:3007';
function readNumber(path) {
  try { return Number(fs.readFileSync(path, 'utf8').trim()); }
  catch { return null; }
}
function cpuUsageMs() {
  try {
    const stat = fs.readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8');
    const usage = /^usage_usec\s+(\d+)/m.exec(stat);
    if (usage) return Number(usage[1]) / 1000;
  }
  catch {}
  const ns = readNumber('/sys/fs/cgroup/cpuacct/cpuacct.usage');
  return ns == null ? null : ns / 1e6;
}
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);

async function main() {
  let token;
  try {
    const login = await fetch(`${base}/api/auto-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(8000) });
    const credentials = await login.json();
    if (!login.ok || !credentials.data?.token) throw new Error('Local health login failed');
    token = credentials.data.token;
    const headers = { 'x-admin-token': token };
    async function read(path, accountId) {
      const start = performance.now();
      const response = await fetch(base + path, { headers: { ...headers, ...(accountId ? { 'x-account-id': accountId } : {}) }, signal: AbortSignal.timeout(8000) });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(`Read failed: ${path} (${response.status})`);
      return { data: payload.data, latencyMs: performance.now() - start };
    }
    const ping = await read('/api/ping');
    const start = performance.now();
    let previousTime = start;
    let previousCpu = cpuUsageMs();
    emit({ type: 'start', at: new Date().toISOString(), version: ping.data.version, duration, interval, cpuScope: 'container cgroup; 100% = one core', memoryScope: 'container cgroup including file cache' });
    while (true) {
      const at = performance.now();
      try {
        const accounts = await read('/api/accounts');
        const statuses = [];
        for (const account of accounts.data.accounts || []) {
          const id = String(account.id);
          const status = await read('/api/status', id);
          statuses.push({ id, running: !!account.running, connected: !!status.data.connection?.connected, state: account.runtimeState || '', latencyMs: status.latencyMs });
        }
        const cpu = cpuUsageMs();
        const measuredAt = performance.now();
        emit({ type: 'sample', elapsedSec: (at - start) / 1000,
          cpuPercent: cpu == null || previousCpu == null || measuredAt === previousTime ? null : (cpu - previousCpu) / (measuredAt - previousTime) * 100,
          memoryBytes: readNumber('/sys/fs/cgroup/memory.current') ?? readNumber('/sys/fs/cgroup/memory/memory.usage_in_bytes'), accounts: statuses });
        previousCpu = cpu;
        previousTime = measuredAt;
      }
      catch (error) { emit({ type: 'error', elapsedSec: (at - start) / 1000, message: error.message }); }
      const remaining = duration * 1000 - (performance.now() - start);
      if (remaining <= 0) break;
      await delay(Math.min(interval * 1000, remaining));
    }
    emit({ type: 'end', at: new Date().toISOString(), elapsedSec: (performance.now() - start) / 1000 });
  }
  finally {
    if (token) await fetch(`${base}/api/logout`, { method: 'POST', headers: { 'x-admin-token': token }, signal: AbortSignal.timeout(8000) });
  }
}
main().catch(error => { emit({ type: 'fatal', message: error.message }); process.exitCode = 1; });
