const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {once}=require('node:events');
const {registerAdminQqLoginRoutes}=require('../src/controllers/admin-qq-login-routes');
const {QqScanError}=require('../src/services/qq-login-service');

test('QQ routes require login and bind each operation to the authenticated panel session',async t=>{
  const calls=[];
  const app=express();app.use(express.json());
  registerAdminQqLoginRoutes({app,userStore:{getUser: id => ({ id, role: 'user', card: { isPermanent: true } })},requireAdminToken(req,res,next){
    if(!req.headers['x-admin-token'])return res.status(401).json({ok:false});
    req.adminToken=req.headers['x-admin-token'];req.currentUser={id:1001,username:'alice',role:'user'};next();
  },resolveProxy:async()=>'',qqLogin:{
    status:()=>({enabled:true}),
    create(owner) { calls.push(['create',owner]); return {sessionId:'fixture',status:'starting'}; },
    get(owner,id){calls.push(['get',owner,id]);throw new QqScanError('会话不存在',404);},
    cancel(owner,id){calls.push(['cancel',owner,id]);}
  }});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.close();server.closeAllConnections();});
  const url=`http://127.0.0.1:${server.address().port}`;
  const a=await fetch(`${url}/api/qq-login/sessions`,{method:'POST'});
  assert.equal(a.status,401);assert.equal(calls.length,0);
  const headers={'x-admin-token':'panel-secret'};
  const b=await fetch(`${url}/api/qq-login/sessions`,{method:'POST',headers});
  assert.equal(b.status,201);assert.equal(b.headers.get('cache-control'),'no-store');
  assert.deepEqual(calls[0],['create','1001:panel-secret']);
  const c=await fetch(`${url}/api/qq-login/sessions/not-owned`,{headers});
  assert.equal(c.status,404);assert.equal((await c.json()).error,'会话不存在');
  await fetch(`${url}/api/qq-login/sessions/fixture`,{method:'DELETE',headers});
  assert.deepEqual(calls.at(-1),['cancel','1001:panel-secret','fixture']);
});

test('targeted sessions inherit the original proxy, bind the account, and reject invalid targets before launch', async t => {
  const calls = [];
  const accounts = [
    { id: '4', userId: 1001, platform: 'qq', uin: '12345678', proxyMode: 'static', proxyProfileId: 7 },
    { id: '5', userId: 1002, platform: 'qq', uin: '12345678' },
    { id: '6', userId: 1001, platform: 'wx', gid: '4242' },
  ];
  const app = express(); app.use(express.json());
  registerAdminQqLoginRoutes({ app, userStore: {getUser: id => ({ id, role: 'user', card: { isPermanent: true } })}, requireAdminToken(req, res, next) {
    req.adminToken = 'test'; req.currentUser = { id: 1001, username: 'alice', role: 'user' }; next();
  }, provider: { getAccounts: () => ({ accounts }) }, qqLogin: {
    create(owner, options) { calls.push({ owner, options }); return { sessionId: 'fixture' }; },
  }, resolveProxy: async setting => { assert.equal(setting.proxyProfileId, 7); return 'http://fixture:8080'; },
  bridgeProxy: async () => ({ url: 'socks5://127.0.0.1:1234' }) });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${server.address().port}/api/qq-login/sessions`;
  const post = targetAccountId => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetAccountId }) });
  assert.equal((await post('4')).status, 201);
  assert.equal(calls[0].options.targetAccountId, '4');
  assert.equal(calls[0].options.proxyMode, 'static'); assert.equal(calls[0].options.proxyProfileId, 7);
  for (const id of ['5', '6', 'missing']) assert.ok((await post(id)).status >= 400);
  assert.equal(calls.length, 1);
});

test('a ban applied while proxy preparation is pending prevents a new QQ session and closes its bridge', async t => {
  let finishProxy, enteredProxy;
  const proxyEntered = new Promise(resolve => { enteredProxy = resolve; });
  let enabled = true, created = 0, closed = 0;
  const app = express(); app.use(express.json());
  registerAdminQqLoginRoutes({ app,
    requireAdminToken(req, _res, next) { req.adminToken = 'fixture'; req.currentUser = { id: 1001, role: 'user' }; next(); },
    userStore: { getUser: id => ({ id, role: 'user', card: { enabled, isPermanent: true } }) },
    provider: { getAccounts: () => ({ accounts: [] }) },
    resolveProxy: () => { enteredProxy(); return new Promise(resolve => { finishProxy = resolve; }); },
    bridgeProxy: async () => ({ url: 'socks5://127.0.0.1:1234', close() { closed++; } }),
    qqLogin: { create() { created++; return { sessionId: 'fixture' }; } },
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const pending = fetch(`http://127.0.0.1:${server.address().port}/api/qq-login/sessions`, { method: 'POST' });
  await proxyEntered; enabled = false; finishProxy('http://fixture:8080');
  const response = await pending;
  assert.equal(response.status, 403);
  assert.equal(created, 0); assert.equal(closed, 1);
});

test('administrator updating another user resolves the proxy as the account owner', async t => {
  const accounts = [{ id: '4', userId: 1002, platform: 'qq', uin: '12345678', proxyMode: 'static', proxyProfileId: 7 }];
  const app = express(); app.use(express.json());
  registerAdminQqLoginRoutes({ app,
    requireAdminToken(req, _res, next) { req.adminToken = 'fixture'; req.currentUser = { id: 1000, role: 'admin' }; next(); },
    userStore: { getUser: id => ({ id, role: id === 1000 ? 'admin' : 'user', card: { isPermanent: true } }) },
    provider: { getAccounts: () => ({ accounts }) },
    resolveProxy: async (_setting, context) => { assert.equal(context.userId, 1002); return ''; },
    qqLogin: { create(_owner, options) { assert.equal(options.targetUserId, 1002); return { sessionId: 'fixture' }; } },
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/qq-login/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetAccountId: '4' }) });
  assert.equal(response.status, 201);
});

test('deleting a bound account while proxy preparation is pending does not launch an orphan scan', async t => {
  const accounts = [{ id: '4', userId: 1001, platform: 'qq', uin: '12345678' }];
  let finish, entered, created = 0, closed = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const app = express(); app.use(express.json());
  registerAdminQqLoginRoutes({ app,
    requireAdminToken(req, _res, next) { req.adminToken = 'fixture'; req.currentUser = { id: 1001, role: 'user' }; next(); },
    userStore: { getUser: id => ({ id, role: 'user', card: { isPermanent: true } }) },
    provider: { getAccounts: () => ({ accounts }) },
    resolveProxy: () => { entered(); return new Promise(resolve => { finish = resolve; }); },
    bridgeProxy: async () => ({ url: 'socks5://127.0.0.1:1234', close() { closed++; } }),
    qqLogin: { create() { created++; return { sessionId: 'fixture' }; } },
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const pending = fetch(`http://127.0.0.1:${server.address().port}/api/qq-login/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetAccountId: '4' }) });
  await ready; accounts.splice(0); finish('http://fixture:8080');
  const response = await pending;
  assert.equal(response.status, 404); assert.equal(created, 0); assert.equal(closed, 1);
});
