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
  const service = new QqLoginService({ dataDir, environment: {}, resolveProxy: async () => '', ...options,
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

test('user purge waits for imports and removes owned, admin-targeted and orphan native data only', async t => {
  const { service, children } = harness(t);
  const alice = service.create('1001:token-a');
  const admin = service.create('1000:token-admin', { targetUserId: 1001 });
  const bob = service.create('1002:token-b');
  const aliceItem = service.owned('1001:token-a', alice.sessionId);
  const adminItem = service.owned('1000:token-admin', admin.sessionId);
  const bobItem = service.owned('1002:token-b', bob.sessionId);
  let finishImport;
  aliceItem.importPromise = new Promise(resolve => { finishImport = resolve; });
  const orphan = path.join(service.dataDir, 'boot-orphan', 'session-orphan');
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, 'owner.json'), JSON.stringify({ userId: 1000, targetUserId: 1001 }));
  const profilePaths = [];
  for (const [index, owner] of [1001, 1001, 1002].entries()) {
    const base = service.profilePath(require('node:crypto').randomUUID());
    const directory = index === 1 ? `${base}.old-${require('node:crypto').randomUUID()}` : base;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'identity.json'), JSON.stringify({ userId: owner, uin: '12345678' }));
    profilePaths.push(directory);
  }
  let finished = false;
  const pending = service.purgeUser(1001).then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(children[0].exitCode, 0);
  assert.equal(children[1].exitCode, 0);
  assert.equal(children[2].exitCode, null);
  assert.throws(() => service.create('1001:new-token'), { status: 403 });
  assert.throws(() => service.create('1000:another-token', { targetUserId: 1001 }), { status: 403 });
  finishImport(); await pending;
  for (const directory of [aliceItem.directory, adminItem.directory, orphan, ...profilePaths.slice(0, 2)]) {
    assert.equal(fs.existsSync(directory), false, directory);
  }
  assert.equal(fs.existsSync(bobItem.directory), true);
  assert.equal(fs.existsSync(profilePaths[2]), true);
  assert.equal(service.get('1002:token-b', bob.sessionId).status, 'starting');
});

test('restored native sessions persist ownership before launching the helper', t => {
  const { service } = harness(t);
  const item = service.launch({ userId: 1001 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(item.directory, 'owner.json'), 'utf8')), { userId: 1001, targetUserId: null });
  service.dispose(item);
});

test('suspension cancels owned and admin-targeted QR helpers, preserves profiles and permits fresh scans after unban', async t => {
  const { service, children } = harness(t);
  service.create('1001:token-a');
  service.create('1000:token-admin', { targetUserId: 1001 });
  const bob = service.create('1002:token-b');
  const profile = service.profilePath(require('node:crypto').randomUUID());
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'identity.json'), JSON.stringify({ userId: 1001, uin: '12345678' }));
  await service.suspendUser(1001);
  assert.equal(children[0].exitCode, 0); assert.equal(children[1].exitCode, 0); assert.equal(children[2].exitCode, null);
  assert.equal(fs.existsSync(profile), true); assert.equal(service.get('1002:token-b', bob.sessionId).status, 'starting');
  assert.throws(() => service.create('1001:new-token'), { status: 403 });
  service.resumeUser(1001); assert.ok(service.create('1001:new-token').sessionId);
});

test('proxy changes cancel only native helpers holding that profile', async t => {
  const { service, children } = harness(t);
  service.create('1001:token-a', { proxyMode: 'static', proxyProfileId: 7 });
  const bob = service.create('1002:token-b', { proxyMode: 'static', proxyProfileId: 8 });
  await service.invalidateProxyProfile(7);
  assert.equal(children[0].exitCode, 0); assert.equal(children[1].exitCode, null);
  assert.equal(service.get('1002:token-b', bob.sessionId).status, 'starting');
});

test('user deletion also waits for cancelled QQ helpers and their unfinished imports', async t => {
  const { service, children } = harness(t);
  const scan = service.create('1001:token-a');
  const bob = service.create('1002:token-b');
  const item = service.owned('1001:token-a', scan.sessionId);
  children[0].stdin.removeAllListeners('data');
  let finishImport;
  item.importPromise = new Promise(resolve => { finishImport = resolve; });
  service.cancel('1001:token-a', scan.sessionId);
  assert.equal(service.sessions.has(scan.sessionId), false);
  assert.equal(service.trackedItems.has(item), true);
  let done = false;
  const purge = service.purgeUser(1001).then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false);
  children[0].kill();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(done, false);
  finishImport(); await purge;
  assert.equal(service.trackedItems.has(item), false);
  assert.equal(fs.existsSync(item.directory), false);
  assert.equal(service.get('1002:token-b', bob.sessionId).status, 'starting');
});

test('startup prewarms one helper and first scan claims it without a second native process', t => {
  const {service,children}=harness(t);
  service.start();
  assert.equal(children.length,1);
  children[0].event('qr',{png:PNG});
  const s=service.create('1001:token-a');
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
  assert.equal(service.create('1001:fixture-token').status, 'starting');
  assert.equal(children.length, 2);
});

test('QR, Code and cancellation are isolated by panel session owner', t => {
  const {service,children}=harness(t);
  const a=service.create('1001:token-a');
  const b=service.create('1002:token-b');
  children[0].event('code',{code:'fixture_ALICE_CODE_12345678'});
  assert.equal(service.get('1001:token-a',a.sessionId).code,'fixture_ALICE_CODE_12345678');
  assert.equal(service.get('1002:token-b',b.sessionId).code,'');
  assert.throws(()=>service.get('1002:token-b',a.sessionId),{status:404});
  assert.throws(()=>service.cancel('1002:token-b',a.sessionId),{status:404});
  assert.throws(()=>service.get('1001:another-token',a.sessionId),{status:404});
});

test('nonzero status, malformed frames and numeric values cannot become Codes', t => {
  const {service,children}=harness(t); const s=service.create('1001:fixture-token');
  children[0].stdout.write('private native credentials that must be ignored\nQQFARM_LOGIN:broken\n');
  children[0].event('code',{code:'-3000'});
  children[0].event('state',{phase:'error',message:'授权失败',canRequest:false});
  const state=service.get('1001:fixture-token',s.sessionId);
  assert.equal(state.code,'');assert.equal(state.status,'error');
});

test('failed native phases remove stale QR images and explain selected proxy disconnects', t => {
  const {service,children}=harness(t);
  const scan=service.create('1001:fixture-token',{proxyMode:'static',proxyProfileId:1});
  for(const phase of ['offline','expired','login_failed','error']) {
    children[0].event('qr',{png:PNG});
    children[0].event('state',{phase,message:'QQ 未返回有效格式的授权结果（空字符串）',canRequest:false});
    const state=service.get('1001:fixture-token',scan.sessionId);
    assert.equal(state.image,'');
    assert.equal(state.status,phase);
    if(phase==='offline') assert.match(state.message,/代理连接已断开/);
    if(phase==='error') assert.match(state.message,/扫码代理链路返回异常/);
  }
});

test('native failure immediately rejects a pending Code refresh', async t => {
  const {service,children}=harness(t);
  const scan=service.create('1001:fixture-token');
  children[0].event('code',{code:'fixture_PREVIOUS_CODE_12345678'});
  const pending=service.refreshCode('1001:fixture-token',scan.sessionId);
  children[0].event('state',{phase:'error',message:'QQ 授权失败',canRequest:false});
  await assert.rejects(pending,/QQ 授权失败/);
});

test('stream fragments reassemble into one event and oversized diagnostic lines are discarded', t => {
  const {service,children}=harness(t); const s=service.create('1001:fixture-token');
  const frame=`QQFARM_LOGIN:${JSON.stringify({kind:'code',value:{code:'fixture_SPLIT_CODE_12345678'}})}\n`;
  children[0].stdout.write('x'.repeat(3*1024*1024+1));children[0].stdout.write('ignored\n');
  children[0].stdout.write(frame.slice(0,17));children[0].stdout.write(frame.slice(17));
  assert.equal(service.get('1001:fixture-token',s.sessionId).code,'fixture_SPLIT_CODE_12345678');
});

test('successful Code survives helper shutdown until its owner cancels or session expires', t => {
  const {service,children}=harness(t); const s=service.create('1001:fixture-token');
  children[0].event('code',{code:'fixture_KEEP_CODE_12345678'});
  children[0].kill();
  assert.equal(service.get('1001:fixture-token',s.sessionId).status,'success');
  service.cancel('1001:fixture-token',s.sessionId);
  assert.throws(()=>service.get('1001:fixture-token',s.sessionId),{status:404});
});

test('parallel scans from the same panel remain independent until explicitly cancelled', t => {
  const {service}=harness(t);
  const old=service.create('1001:fixture-token'); const bob=service.create('1002:fixture-token');
  const next = service.create('1001:fixture-token');
  assert.notEqual(next.sessionId, old.sessionId);
  assert.equal(service.get('1001:fixture-token',old.sessionId).status,'starting');
  service.cancel('1001:fixture-token', old.sessionId);
  assert.throws(()=>service.get('1001:fixture-token',old.sessionId),{status:404});
  assert.equal(service.get('1001:fixture-token',next.sessionId).status,'starting');
  assert.equal(service.get('1002:fixture-token',bob.sessionId).status,'starting');
});

test('multi-user multi-QQ credentials are saved in distinct native profiles with exact ownership', async t => {
  const { service, children } = harness(t);
  const scans = [
    { owner: '1001:token-a', userId: 1001, uin: '12345678' },
    { owner: '1001:token-a', userId: 1001, uin: '87654321' },
    { owner: '1002:token-b', userId: 1002, uin: '12345678' },
  ];
  for (const [index, scan] of scans.entries()) {
    scan.session = service.create(scan.owner);
    scan.item = service.owned(scan.owner, scan.session.sessionId);
    children[index].event('session', { uin: scan.uin });
    children[index].event('code', { code: `fixture_PRIVATE_CODE_${index}` });
    fs.mkdirSync(path.join(scan.item.directory, 'qq-data'));
    fs.writeFileSync(path.join(scan.item.directory, 'qq-data', 'credentials'), `private-state-${index}`);
  }
  const profiles = await Promise.all(scans.map(scan => service.saveProfile(scan.item, scan.userId)));
  assert.equal(new Set(profiles).size, 3);
  for (const [index, scan] of scans.entries()) {
    const directory = service.profilePath(profiles[index]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'identity.json'), 'utf8')), { userId: scan.userId, uin: scan.uin });
    assert.equal(fs.readFileSync(path.join(directory, 'qq-data', 'credentials'), 'utf8'), `private-state-${index}`);
    assert.equal(service.get(scan.owner, scan.session.sessionId).code, `fixture_PRIVATE_CODE_${index}`);
    assert.throws(() => service.get(index < 2 ? '1002:token-b' : '1001:token-a', scan.session.sessionId), { status: 404 });
  }
  service.cancel(scans[0].owner, scans[0].session.sessionId);
  assert.equal(service.get(scans[1].owner, scans[1].session.sessionId).code, 'fixture_PRIVATE_CODE_1');
  assert.equal(service.get(scans[2].owner, scans[2].session.sessionId).code, 'fixture_PRIVATE_CODE_2');
  await service.purgeUser(1001);
  assert.equal(fs.existsSync(service.profilePath(profiles[0])), false);
  assert.equal(fs.existsSync(service.profilePath(profiles[1])), false);
  assert.equal(fs.existsSync(service.profilePath(profiles[2])), true);
  assert.throws(() => service.get(scans[1].owner, scans[1].session.sessionId), { status: 404 });
  assert.equal(service.get(scans[2].owner, scans[2].session.sessionId).code, 'fixture_PRIVATE_CODE_2');
});

test('QQ status exposes only the requesting panel sessions and reserves recovery diagnostics for admins', t => {
  const { service } = harness(t);
  service.create('1001:token-a'); service.create('1001:token-b'); service.create('1002:token-c');
  service.lastRecovery = { outcome: 'bob-recovery' };
  assert.equal(service.status({ owner: '1001:token-a' }).activeSessions, 1);
  assert.equal(service.status({ owner: '1002:token-c' }).activeSessions, 1);
  const stranger = service.status({ owner: 'carol:token-d' });
  assert.equal(stranger.activeSessions, 0); assert.equal(stranger.running, false); assert.equal(stranger.lastRecovery, null);
  assert.equal(service.status({ admin: true }).activeSessions, 3);
  assert.equal(service.status({ admin: true }).lastRecovery.outcome, 'bob-recovery');
});

test('QQ concurrency capacity accepts an explicit positive integer and rejects invalid settings', t => {
  const { service } = harness(t, { environment: { QQ_LOGIN_MAX_SESSIONS: '6' } });
  for (let i = 0; i < 6; i++) service.create(`1001:token-${i}`);
  assert.throws(() => service.create('1002:token'), { status: 429 });
  for (const value of ['0', '-1', '2.5', 'invalid', '']) {
    assert.throws(() => new QqLoginService({ environment: { QQ_LOGIN_MAX_SESSIONS: value } }), /正整数/);
  }
});

test('session TTL and concurrent helper limit are enforced', t => {
  let now=0;const {service}=harness(t,{now:()=>now,ttlMs:100,maxSessions:1});
  const first=service.create('1001:fixture-token');
  assert.throws(()=>service.create('1002:fixture-token'),{status:429});
  now=101;
  assert.throws(()=>service.get('1001:fixture-token',first.sessionId),{status:410});
  assert(service.create('1002:fixture-token').sessionId);
});

test('native profile and log files are never returned in snapshots', t => {
  const {service,children}=harness(t);const state=service.create('1001:fixture-token');
  children[0].event('diagnostic',{event:'invalid_code_result',resultType:'string',length:0,syntax:'empty',secret:'private fixture'});
  assert.deepEqual(service.owned('1001:fixture-token',state.sessionId).diagnostic,{resultType:'string',length:0,syntax:'empty'});
  assert(!('directory' in state));assert(!('child' in state));assert(!('owner' in state));
  assert(!('diagnostic' in service.get('1001:fixture-token',state.sessionId)));
});

test('native stable identity stays private and a consumed Code can be refreshed before helper release', async t => {
  const { service, children } = harness(t);
  const state = service.create('1001:fixture-token');
  children[0].event('session', { uin: '12345678' });
  children[0].event('code', { code: 'fixture_INITIAL_CODE_12345678' });
  assert.equal(service.owned('1001:fixture-token', state.sessionId).uin, '12345678');
  assert.equal('uin' in service.get('1001:fixture-token', state.sessionId), false);
  assert.equal(service.owned('1001:fixture-token', state.sessionId).stopping, undefined);
  const refreshed = service.refreshCode('1001:fixture-token', state.sessionId);
  children[0].event('code', { code: 'fixture_REFRESH_CODE_12345678' });
  assert.equal(await refreshed, 'fixture_REFRESH_CODE_12345678');
});

test('a static proxy scan never claims a prewarmed direct native client', t => {
  const { service, children } = harness(t);
  service.start();
  const bridge = { close() {} };
  const state = service.create('1001:fixture-token', { nativeProxyURL: 'socks5://127.0.0.1:18080', proxyURL: 'http://private:proxy@fixture:8888', proxyMode: 'static', proxyProfileId: 7, proxyBridge: bridge });
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
  const scan = h.service.create('1001:fixture-token');
  const item = h.service.owned('1001:fixture-token', scan.sessionId);
  fs.mkdirSync(path.join(item.directory, 'qq-data'), { recursive: true });
  fs.writeFileSync(path.join(item.directory, 'qq-data', 'fixture-ticket'), 'private-ticket');
  h.children[0].event('session', { uin: '12345678' });
  h.children[0].event('code', { code: 'fixture_INITIAL_CODE_12345678' });
  const profile = await h.service.saveProfile(item, 1001);
  h.service.cancel('1001:fixture-token', scan.sessionId);
  return { ...h, profile, account: { userId: 1001, uin: '12345678', qqLoginProfile: profile } };
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
  for (const patch of [{ userId: 1002 }, { uin: '87654321' }, { qqLoginProfile: '../outside' }]) {
    await assert.rejects(h.service.refreshAccountCode({ ...h.account, ...patch }), { status: 409 });
  }
  assert.equal(h.children.length, 1);
});

test('saved QQ credentials remain usable after the login service restarts', async t => {
  const h = await savedProfile(t);
  h.service.close();
  const restored = new QqLoginService({ dataDir: h.service.dataDir, environment: {}, resolveProxy: h.service.resolveProxy, getLaunch: h.service.getLaunch, spawn: h.service.spawn });
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
  const scan = service.create('1001:fixture-token');
  service.cancel('1001:fixture-token', scan.sessionId);
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
  assert.equal(h.service.status({ admin: true }).lastRecovery.outcome, 'success');
  assert.equal(h.service.status({ admin: true }).lastRecovery.matchesSaved, true);
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
  assert.equal(h.service.status({ admin: true }).lastRecovery.hasIdentity, false);
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
  assert.equal(h.service.status({ admin: true }).lastRecovery.matchesSaved, false);
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

test('account purge cancels its admin-targeted import and removes snapshots without touching another user', async t => {
  const h = await savedProfile(t);
  h.account.id = '1';
  const admin = h.service.create('1000:admin-token', { targetUserId: h.account.userId, targetAccountId: '1' });
  const item = h.service.owned('1000:admin-token', admin.sessionId);
  const other = h.service.create('1002:other-token');
  const otherItem = h.service.owned('1002:other-token', other.sessionId);
  let finish; item.importPromise = new Promise(resolve => { finish = resolve; });
  let done = false;
  const pending = h.service.purgeAccount(h.account).then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(item.disposed, true); assert.equal(item.exited, true);
  assert.equal(done, false);
  finish(); await pending;
  assert.equal(fs.existsSync(h.service.profilePath(h.profile)), false);
  assert.equal(fs.existsSync(item.directory), false);
  assert.equal(otherItem.disposed, false); assert.equal(fs.existsSync(otherItem.directory), true);
});
