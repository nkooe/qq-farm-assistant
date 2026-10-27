// Probe both services. No authentication secrets are printed or passed in argv.
const http = require('node:http');

function probe(port, path, json = false) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        if (json) {
          try { if (JSON.parse(body).data?.ok !== true) return reject(new Error('YYB unavailable')); }
          catch (error) { return reject(error); }
        }
        resolve();
      });
    });
    req.on('timeout', () => req.destroy(new Error('health check timeout')));
    req.on('error', reject);
  });
}

Promise.all([
  probe(Number(process.env.ADMIN_PORT) || 3007, '/'),
  probe(Number(process.env.YYB_PORT) || 8450, '/health', true),
]).catch(() => { process.exitCode = 1; });
