const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { QqLoginService, helperEnvironment } = require('../src/services/qq-login-service');

const PNG = Buffer.from([137,80,78,71,13,10,26,10]).toString('base64');
function harness(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-qq-scan-test-'));
  const children = [];
  const service = new QqLoginService({ dataDir, environment: {}, ...options,
    getLaunch: () => ({ runtime: dataDir, host: path.join(dataDir,'host.mjs'), executable:'fixture-node' }),
    spawn(_file,_args,config) {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.exitCode = null;
      child.kill = () => { child.exitCode = 0; child.emit('exit',0); };
      child.stdin.on('data', chunk => { if (String(chunk).includes('shutdown')) child.kill(); });
      child.config = config;
      child.event = (kind,value) => child.stdout.write(`QQFARM_LOGIN:${  JSON.stringify({kind,value})  }\n`);
      children.push(child); return child;
    } });
  t.after(() => { service.close(); for (const child of children) child.kill(); fs.rmSync(dataDir,{recursive:true,force:true}); });
  return { service, children };
}

test('startup prewarms one helper and first scan claims it without a second native process', t => {
  const {service,children}=harness(t);
  service.start();
  assert.equal(children.length,1);
  children[0].event('qr',{png:PNG});
  const s=service.create('alice:token-a');
  assert.equal(children.length,1);
  assert.equal(s.status,'waiting_scan');
  assert(s.image.startsWith('data:image/png;base64,'));
});

test('a prewarmed QR that has expired is replaced before a user opens the scan', t => {
  let now = 1;
  const { service, children } = harness(t, { now: () => now });
  service.start();
  children[0].event('qr', { png: PNG, expireTimeRaw: 120 });
  now += 120001;
  assert.equal(service.create('alice').status, 'starting');
  assert.equal(children.length, 2);
});

test('QR, Code and cancellation are isolated by panel session owner', t => {
  const {service,children}=harness(t);
  const a=service.create('alice:token-a');
  const b=service.create('bob:token-b');
  children[0].event('code',{code:'fixture_ALICE_CODE_12345678'});
  assert.equal(service.get('alice:token-a',a.sessionId).code,'fixture_ALICE_CODE_12345678');
  assert.equal(service.get('bob:token-b',b.sessionId).code,'');
  assert.throws(()=>service.get('bob:token-b',a.sessionId),{status:404});
  assert.throws(()=>service.cancel('bob:token-b',a.sessionId),{status:404});
  assert.throws(()=>service.get('alice:another-token',a.sessionId),{status:404});
});

test('nonzero status, malformed frames and numeric values cannot become Codes', t => {
  const {service,children}=harness(t); const s=service.create('alice');
  children[0].stdout.write('private native credentials that must be ignored\nQQFARM_LOGIN:broken\n');
  children[0].event('code',{code:'-3000'});
  children[0].event('state',{phase:'error',message:'授权失败',canRequest:false});
  const state=service.get('alice',s.sessionId);
  assert.equal(state.code,'');assert.equal(state.status,'error');
});

test('failed native phases remove stale QR images and explain selected proxy disconnects', t => {
  const {service,children}=harness(t);
  const scan=service.create('alice',{proxyMode:'static',proxyProfileId:1});
  for(const phase of ['offline','expired','login_failed','error']) {
    children[0].event('qr',{png:PNG});
    children[0].event('state',{phase,message:'QQ 未返回有效格式的授权结果（空字符串）',canRequest:false});
    const state=service.get('alice',scan.sessionId);
    assert.equal(state.image,'');
    assert.equal(state.status,phase);
    if(phase==='offline') assert.match(state.message,/代理连接已断开/);
    if(phase==='error') assert.match(state.message,/扫码代理链路返回异常/);
  }
});

test('native failure immediately rejects a pending Code refresh', async t => {
  const {service,children}=harness(t);
  const scan=service.create('alice');
  children[0].event('code',{code:'fixture_PREVIOUS_CODE_12345678'});
  const pending=service.refreshCode('alice',scan.sessionId);
  children[0].event('state',{phase:'error',message:'QQ 授权失败',canRequest:false});
  await assert.rejects(pending,/QQ 授权失败/);
});

test('stream fragments reassemble into one event and oversized diagnostic lines are discarded', t => {
  const {service,children}=harness(t); const s=service.create('alice');
  const frame=`QQFARM_LOGIN:${JSON.stringify({kind:'code',value:{code:'fixture_SPLIT_CODE_12345678'}})}\n`;
  children[0].stdout.write('x'.repeat(3*1024*1024+1));children[0].stdout.write('ignored\n');
  children[0].stdout.write(frame.slice(0,17));children[0].stdout.write(frame.slice(17));
  assert.equal(service.get('alice',s.sessionId).code,'fixture_SPLIT_CODE_12345678');
});

test('successful Code survives helper shutdown until its owner cancels or session expires', t => {
  const {service,children}=harness(t); const s=service.create('alice');
  children[0].event('code',{code:'fixture_KEEP_CODE_12345678'});
  children[0].kill();
  assert.equal(service.get('alice',s.sessionId).status,'success');
  service.cancel('alice',s.sessionId);
  assert.throws(()=>service.get('alice',s.sessionId),{status:404});
});

test('replacing one user scan clears its old result without cancelling another user', t => {
  const {service}=harness(t);
  const old=service.create('alice'); const bob=service.create('bob');
  service.create('alice');
  assert.throws(()=>service.get('alice',old.sessionId),{status:404});
  assert.equal(service.get('bob',bob.sessionId).status,'starting');
});

test('session TTL and concurrent helper limit are enforced', t => {
  let now=0;const {service}=harness(t,{now:()=>now,ttlMs:100,maxSessions:1});
  const first=service.create('alice');
  assert.throws(()=>service.create('bob'),{status:429});
  now=101;
  assert.throws(()=>service.get('alice',first.sessionId),{status:410});
  assert(service.create('bob').sessionId);
});

test('native profile and log files are never returned in snapshots', t => {
  const {service,children}=harness(t);const state=service.create('alice');
  children[0].event('diagnostic',{event:'invalid_code_result',resultType:'string',length:0,syntax:'empty',secret:'private fixture'});
  assert.deepEqual(service.owned('alice',state.sessionId).diagnostic,{resultType:'string',length:0,syntax:'empty'});
  assert(!('directory' in state));assert(!('child' in state));assert(!('owner' in state));
  assert(!('diagnostic' in service.get('alice',state.sessionId)));
});

test('native stable identity stays private and a consumed Code can be refreshed before helper release', async t => {
  const { service, children } = harness(t);
  const state = service.create('alice');
  children[0].event('session', { uin: '12345678' });
  children[0].event('code', { code: 'fixture_INITIAL_CODE_12345678' });
  assert.equal(service.owned('alice', state.sessionId).uin, '12345678');
  assert.equal('uin' in service.get('alice', state.sessionId), false);
  assert.equal(service.owned('alice', state.sessionId).stopping, undefined);
  const refreshed = service.refreshCode('alice', state.sessionId);
  children[0].event('code', { code: 'fixture_REFRESH_CODE_12345678' });
  assert.equal(await refreshed, 'fixture_REFRESH_CODE_12345678');
});

test('a static proxy scan never claims a prewarmed direct native client', t => {
  const { service, children } = harness(t);
  service.start();
  const bridge = { close() {} };
  const state = service.create('alice', { nativeProxyURL: 'socks5://127.0.0.1:18080', proxyURL: 'http://private:proxy@fixture:8888', proxyMode: 'static', proxyProfileId: 7, proxyBridge: bridge });
  assert.equal(children.length, 2);
  assert.equal(children[1].config.env.NAPCAT_PROXY_PORT, '18080');
  assert.equal('proxyURL' in state, false); assert.equal('proxyBridge' in state, false);
});

test('helper environment discards external session injection and only explicit configured proxy is used', () => {
  const env=helperEnvironment('/session',{runtime:'/runtime',host:'/host'}, {
    NAPCAT_QUICK_ACCOUNT:'secret',NAPCAT_TEST_QQ_DATA:'/old',NODE_OPTIONS:'--require=foreign',
    QQ_LOGIN_SOCKS_PROXY:'socks5://127.0.0.1:19080'
  });
  assert.equal(env.NAPCAT_QUICK_ACCOUNT,undefined);assert.equal(env.NODE_OPTIONS,undefined);
  assert.equal(env.FARM_QQ_SESSION_DIR,'/session');assert.equal(env.NAPCAT_PROXY_PORT,'19080');
  assert.throws(()=>helperEnvironment('/s',{runtime:'/r',host:'/h'},{QQ_LOGIN_SOCKS_PROXY:'http://proxy:8080'}),{status:503});
});

async function savedProfile(t, options = {}) {
  const h = harness(t, options);
  const scan = h.service.create('alice');
  const item = h.service.owned('alice', scan.sessionId);
  fs.mkdirSync(path.join(item.directory, 'qq-data'), { recursive: true });
  fs.writeFileSync(path.join(item.directory, 'qq-data', 'fixture-ticket'), 'private-ticket');
  h.children[0].event('session', { uin: '12345678' });
  h.children[0].event('code', { code: 'fixture_INITIAL_CODE_12345678' });
  const profile = await h.service.saveProfile(item, 'alice');
  h.service.cancel('alice', scan.sessionId);
  return { ...h, profile, account: { username: 'alice', uin: '12345678', qqLoginProfile: profile } };
}

test('saved isolated QQ credentials survive UI cancellation and repeated fresh-code requests', async t => {
  const h = await savedProfile(t);
  for (let i = 1; i <= 2; i++) {
    const pending = h.service.refreshAccountCode(h.account);
    await new Promise(resolve => setImmediate(resolve));
    const child = h.children.at(-1);
    assert.equal(child.config.env.FARM_QQ_RESTORE_UIN, '12345678');
    assert.equal(fs.readFileSync(path.join(child.config.cwd, 'qq-data', 'fixture-ticket'), 'utf8'), 'private-ticket');
    child.event('session', { uin: '12345678' });
    child.event('code', { code: `fixture_REFRESH_CODE_1234567${  i}` });
    assert.equal(await pending, `fixture_REFRESH_CODE_1234567${  i}`);
    assert.equal(h.service.sessions.size, 0);
    assert(fs.existsSync(h.service.profilePath(h.profile)));
  }
});

test('profile restore rejects wrong owners, wrong QQ identity and path traversal before native launch', async t => {
  const h = await savedProfile(t);
  for (const patch of [{ username: 'bob' }, { uin: '87654321' }, { qqLoginProfile: '../outside' }]) {
    await assert.rejects(h.service.refreshAccountCode({ ...h.account, ...patch }), { status: 409 });
  }
  assert.equal(h.children.length, 1);
});

test('saved QQ credentials remain usable after the login service restarts', async t => {
  const h = await savedProfile(t);
  h.service.close();
  const restored = new QqLoginService({ dataDir: h.service.dataDir, environment: {}, getLaunch: h.service.getLaunch, spawn: h.service.spawn });
  t.after(() => restored.close());
  const pending = restored.refreshAccountCode(h.account);
  await new Promise(resolve => setImmediate(resolve));
  const child = h.children.at(-1);
  child.event('session', { uin: '12345678' });
  child.event('code', { code: 'fixture_RESTART_CODE_12345678' });
  assert.equal(await pending, 'fixture_RESTART_CODE_12345678');
  assert.equal(restored.sessions.size, 0);
});

test('a rejected native quick login requests rescan and preserves the saved snapshot', async t => {
  const h = await savedProfile(t);
  const pending = h.service.refreshAccountCode(h.account);
  await new Promise(resolve => setImmediate(resolve));
  h.children.at(-1).event('qr', { png: PNG });
  await assert.rejects(pending, error => error.kind === 'rescan');
  assert(fs.existsSync(h.service.profilePath(h.profile)));
  assert.equal(h.service.sessions.size, 0);
});

test('native QQ disconnect is retryable and does not falsely demand rescan', async t => {
  const h = await savedProfile(t);
  const pending = h.service.refreshAccountCode(h.account);
  await new Promise(resolve => setImmediate(resolve));
  h.children.at(-1).event('state', { phase: 'offline' });
  await assert.rejects(pending, error => error.kind === 'temporary');
  assert(fs.existsSync(h.service.profilePath(h.profile)));
});

test('restoring native QQ uses its selected proxy and never falls back to direct on proxy failure', async t => {
  let fail = false;
  const settings = [];
  const h = await savedProfile(t, { resolveProxy: async setting => { settings.push(setting); if (fail) throw new Error('proxy unavailable'); return 'http://fixture:8080'; }, bridgeProxy: async () => ({ url: 'socks5://127.0.0.1:18080', close() {} }) });
  h.account.proxyMode = 'static'; h.account.proxyProfileId = 7;
  const pending = h.service.refreshAccountCode(h.account);
  await new Promise(resolve => setImmediate(resolve));
  const child = h.children.at(-1);
  assert.equal(child.config.env.NAPCAT_PROXY_PORT, '18080');
  child.event('session', { uin: '12345678' }); child.event('code', { code: 'fixture_PROXY_CODE_12345678' });
  await pending; fail = true;
  await assert.rejects(h.service.refreshAccountCode(h.account), error => error.kind === 'proxy' && /代理不可用/.test(error.message));
  assert.equal(h.children.length, 2);
  assert.deepEqual(settings.at(-1), { proxyMode: 'static', proxyProfileId: 7 });
});

test('stopping a queued or active credential request prevents returning a Code and releases the helper', async t => {
  const h = await savedProfile(t);
  const controller = new AbortController();
  const pending = h.service.refreshAccountCode(h.account, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, /取消/);
  assert.equal(h.service.sessions.size, 0);
  assert(fs.existsSync(h.service.profilePath(h.profile)));
});

test('deleting a saved profile during restore cannot resurrect it or leak a fresh snapshot', async t => {
  const h = await savedProfile(t);
  const pending = h.service.refreshAccountCode(h.account);
  await new Promise(resolve => setImmediate(resolve));
  h.service.discardProfile(h.profile);
  const child = h.children.at(-1);
  child.event('session', { uin: '12345678' });
  child.event('code', { code: 'fixture_DELETED_CODE_12345678' });
  await assert.rejects(pending, /删除或替换/);
  assert.equal(h.service.sessions.size, 0);
  assert.deepEqual(fs.readdirSync(path.join(h.service.dataDir, 'profiles')), []);
});

test('an installed idle component remains available after prewarm is consumed', t => {
  const { service } = harness(t);
  assert.equal(service.status().available, true);
  assert.equal(service.status().running, false);
  service.start();
  const scan = service.create('alice');
  service.cancel('alice', scan.sessionId);
  assert.equal(service.status().installed, true);
  assert.equal(service.status().available, true);
  assert.equal(service.status().activeSessions, 0);
  service.close();
  assert.equal(service.status().available, false);
});

test('missing native identity can arrive after Code without a false rescan', async t => {
  const h = await savedProfile(t);
  const pending = h.service.refreshAccountCode(h.account);
  await new Promise(resolve => setImmediate(resolve));
  const child = h.children.at(-1);
  child.event('session', { uin: '' });
  child.event('code', { code: 'fixture_DELAYED_IDENTITY_CODE' });
  setTimeout(() => child.event('session', { uin: '12345678' }), 150);
  assert.equal(await pending, 'fixture_DELAYED_IDENTITY_CODE');
  assert.equal(h.service.status().lastRecovery.outcome, 'success');
  assert.equal(h.service.status().lastRecovery.matchesSaved, true);
  assert.equal(JSON.stringify(h.service.status()).includes('12345678'), false);
});

test('identity never ready is retryable and cannot replace a saved snapshot', async t => {
  const h = await savedProfile(t, { identityWaitMs: 10 });
  const before = fs.readFileSync(path.join(h.service.profilePath(h.profile), 'identity.json'), 'utf8');
  const pending = h.service.refreshAccountCode(h.account);
  await new Promise(resolve => setImmediate(resolve));
  h.children.at(-1).event('session', { uin: '' });
  h.children.at(-1).event('code', { code: 'fixture_WITHOUT_IDENTITY_CODE' });
  await assert.rejects(pending, error => error.kind === 'temporary' && /尚未就绪/.test(error.message));
  assert.equal(fs.readFileSync(path.join(h.service.profilePath(h.profile), 'identity.json'), 'utf8'), before);
  assert.equal(h.service.status().lastRecovery.hasIdentity, false);
  assert.equal(h.service.sessions.size, 0);
});

test('host identity pending is temporary, real mismatch is rescan, both preserve credentials', async t => {
  const h = await savedProfile(t);
  for (const mismatch of [false, true]) {
    const pending = h.service.refreshAccountCode(h.account);
    await new Promise(resolve => setImmediate(resolve));
    const child = h.children.at(-1);
    if (mismatch) child.event('session', { uin: '87654321' });
    else child.event('state', { phase: 'error', reason: 'identity_pending' });
    await assert.rejects(pending, error => error.kind === (mismatch ? 'rescan' : 'temporary'));
    assert(fs.existsSync(h.service.profilePath(h.profile)));
    assert.equal(h.service.sessions.size, 0);
  }
});

test('identity changing within a native session cannot save Code even if it changes back', async t => {
  const h = await savedProfile(t);
  const pending = h.service.refreshAccountCode(h.account);
  await new Promise(resolve => setImmediate(resolve));
  const child = h.children.at(-1);
  child.event('session', { uin: '12345678' });
  child.event('session', { uin: '87654321' });
  child.event('session', { uin: '12345678' });
  child.event('code', { code: 'fixture_CHANGED_IDENTITY_CODE' });
  await assert.rejects(pending, error => error.kind === 'rescan');
  assert.equal(h.service.status().lastRecovery.matchesSaved, false);
});

test('identity changes during native shutdown cannot overwrite the saved profile', async t => {
  const h = await savedProfile(t);
  const before = fs.readFileSync(path.join(h.service.profilePath(h.profile), 'identity.json'), 'utf8');
  const pending = h.service.refreshAccountCode(h.account);
  await new Promise(resolve => setImmediate(resolve));
  const child = h.children.at(-1);
  child.stdin.prependListener('data', chunk => {
    if (String(chunk).includes('shutdown')) child.event('session', { uin: '87654321' });
  });
  child.event('session', { uin: '12345678' });
  child.event('code', { code: 'fixture_DURING_SHUTDOWN_CODE' });
  await assert.rejects(pending, error => error.kind === 'rescan');
  assert.equal(fs.readFileSync(path.join(h.service.profilePath(h.profile), 'identity.json'), 'utf8'), before);
});
