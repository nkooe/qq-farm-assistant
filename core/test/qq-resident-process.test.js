const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { QqLoginService } = require('../src/services/qq-login-service');

async function waitFor(check) {
  const until = Date.now() + 8000;
  while (!check()) {
    if (Date.now() >= until) throw new Error('Fixture native process timed out');
    await delay(20);
  }
}

test('real host IPC reuses one live process after import and restores the same directory after service restart', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-resident-process-'));
  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(path.join(runtime, 'napcat'), { recursive: true });
  // Execute our actual host and service. Only the external QQ native module is
  // replaced: no production account, network authorization or resource writes.
  fs.writeFileSync(path.join(runtime, 'napcat', 'napcat.mjs'), `
    import fs from 'node:fs';
    import path from 'node:path';
    const data = process.env.FARM_QQ_SESSION_DIR;
    fs.mkdirSync(path.join(data, 'qq-data'), {recursive:true});
    const counter = path.join(data, 'qq-data', 'requests');
    const uin = process.env.FARM_QQ_RESTORE_UIN || '12345678';
    await globalThis.__qqFarmLogin.ready({getNodeMiscService:()=>({loginWithAppId:async()=>{
      const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
      fs.writeFileSync(counter, String(count));
      return {errCode:0,result:'fixture_PROCESS_CODE_'+count};
    }})},{uin});
  `);
  const services = [];
  const children = [];
  function makeService() {
    const service = new QqLoginService({ dataDir: path.join(root, 'data'), environment: {}, resolveProxy: async () => '',
      getLaunch: () => ({ runtime, host: path.resolve(__dirname, '../qq-login/host.mjs'), executable: process.execPath }),
      spawn(...args) {
        const child = require('node:child_process').spawn(...args);
        children.push(child); return child;
      },
    });
    services.push(service); return service;
  }
  t.after(async () => {
    for (const service of services) service.close();
    await waitFor(() => children.every(child => child.exitCode !== null || child.signalCode !== null));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const service = makeService();
  const scan = service.create('1001:fixture-panel');
  const item = service.owned('1001:fixture-panel', scan.sessionId);
  await waitFor(() => item.code && item.uin);
  const qqLoginProfile = await service.saveProfile(item, 1001);
  const account = { id: '1', userId: 1001, uin: '12345678', qqLoginProfile };
  await service.retainAccountSession(item, account);
  const pid = children[0].pid;
  service.cancel('1001:fixture-panel', scan.sessionId);
  assert.equal(children[0].exitCode, null);
  assert.equal(await service.refreshAccountCode(account), 'fixture_PROCESS_CODE_2');
  assert.equal(await service.refreshAccountCode(account), 'fixture_PROCESS_CODE_3');
  assert.equal(children.length, 1); assert.equal(children[0].pid, pid);
  assert.equal(service.getAccountState(account).state, 'online');
  assert.equal(item.directory, service.profilePath(qqLoginProfile));
  service.close();
  await waitFor(() => children[0].exitCode !== null);
  assert.equal(fs.readFileSync(path.join(item.directory, 'qq-data', 'requests'), 'utf8'), '3');
  const restarted = makeService();
  assert.equal(await restarted.refreshAccountCode(account), 'fixture_PROCESS_CODE_4');
  assert.equal(await restarted.refreshAccountCode(account), 'fixture_PROCESS_CODE_5');
  assert.equal(children.length, 2);
  assert.equal(restarted.accountSessions.get('1001:1').directory, item.directory);
  await restarted.stopAccount(account);
  await waitFor(() => children[1].exitCode !== null);
  assert.equal(restarted.getAccountState(account).state, 'stopped');
  assert.equal(fs.readFileSync(path.join(item.directory, 'qq-data', 'requests'), 'utf8'), '5');
});
