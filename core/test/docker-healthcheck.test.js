const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const run = promisify(execFile);

test('container health checks both main panel and YYB rather than only the main page', async (t) => {
  let mainStatus = 200;
  let yybStatus = 200;
  let yybOK = true;
  const main = http.createServer((_req, res) => { res.writeHead(mainStatus); res.end('panel'); });
  const yyb = http.createServer((_req, res) => { res.writeHead(yybStatus); res.end(JSON.stringify({ data: { ok: yybOK } })); });
  for (const server of [main, yyb]) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
  }
  const verify = () => run(process.execPath, [path.join(__dirname, '../docker/healthcheck.js')], {
    env: { ...process.env, ADMIN_PORT: String(main.address().port), YYB_PORT: String(yyb.address().port) },
    timeout: 8000,
  });
  await verify();
  yybStatus = 503;
  await assert.rejects(verify(), err => err.code === 1);
  yybStatus = 200;
  yybOK = false;
  await assert.rejects(verify(), err => err.code === 1);
  yybOK = true;
  mainStatus = 503;
  await assert.rejects(verify(), err => err.code === 1);
});
