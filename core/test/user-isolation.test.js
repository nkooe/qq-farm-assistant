const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdminAccountAccess } = require('../src/controllers/admin-account-access');
const { registerAdminAccountRoutes } = require('../src/controllers/admin-account-routes');
const { registerAdminYybRoutes } = require('../src/controllers/admin-yyb-routes');
const { findAccountByRef, resolveAccountId } = require('../src/services/account-resolver');
const { createDataProvider } = require('../src/runtime/data-provider');

const alice = { id: 1001, role: 'user' };
const bob = { id: 1002, role: 'user' };
const admin = { id: 1000, role: 'admin' };

test('farm operations use exact internal IDs even when QQ identifiers collide across users', () => {
  const accounts = [
    { id: '1', userId: 1001, uin: '2', qq: '98765432' },
    { id: '2', userId: 1002, uin: '98765432', qq: '87654321' },
  ];
  const started = [];
  const provider = createDataProvider({ workers: {}, getAccounts: () => ({ accounts }),
    getAccountAccessRejection: () => null,
    store: { addOrUpdateAccount() {} }, startWorker: account => started.push(account.id) });
  const access = createAdminAccountAccess({ getProvider: () => provider });
  assert.equal(findAccountByRef(accounts, '2').userId, 1002);
  assert.equal(resolveAccountId(accounts, '98765432'), '');
  for (const ref of [['1'], { id: '1' }]) assert.equal(access.resolveAccountReference(ref), '');
  const id = access.getAccountIdFromRequest({ headers: { 'x-account-id': '2' } });
  assert.equal(access.canAccessAccount({ currentUser: alice }, id), false);
  assert.equal(access.canAccessAccount({ currentUser: bob }, id), true);
  assert.equal(provider.startAccount('2'), true);
  assert.equal(provider.startAccount('98765432'), false);
  assert.deepEqual(started, ['2']);
});
function routes() {
  const handlers = new Map();
  const app = Object.fromEntries(['get','post','put','delete'].map(method => [method, (path, ...chain) => handlers.set(`${method} ${path}`, chain.at(-1))]));
  return { app, async call(method, path, user, fields = {}) {
    const req = { currentUser: user, body: {}, query: {}, params: {}, headers: {}, ...fields };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handlers.get(`${method} ${path}`)(req, res);
    return res;
  }};
}
function accountHarness() {
  const accounts = [{id:'1',userId:1001,name:'Alice',yybOpenid:'wx-alice'}, {id:'2',userId:1002,name:'Bob',yybOpenid:'wx-bob',code:'fixture-private-code'}];
  const provider = { getAccounts: () => ({ accounts, nextId: 3 }), startAccount() {}, stopAccount() {},
    getLogs: id => [{accountId:id,msg:id === '1' ? 'Alice log' : 'Bob secret log'}],
    getAccountLogs: () => [{accountId:'1',msg:'Alice log'},{accountId:'2',msg:'Bob secret log'}] };
  const store = {getGlobalWxConfig:()=>({userIsolation:false}), getAccounts:provider.getAccounts};
  const access = createAdminAccountAccess({store,getProvider:()=>provider});
  return {accounts,provider,store,access};
}

test('ordinary users remain isolated even when legacy userIsolation is disabled', () => {
  const {access, store} = accountHarness();
  for (const api of [access]) {
    assert.deepEqual(api.getAccountsForUser(1001).map(a=>a.id), ['1']);
    assert.equal(api.canAccessAccount({currentUser:alice}, '2'), false);
    assert.equal(api.canAccessAccount({currentUser:admin}, '2'), true);
    assert.deepEqual(api.getAccessibleAccountIdsForUser(bob), ['2']);
  }
  assert.throws(() => createAdminAccountAccess({store,getProvider:()=>null}).getAccountsForUser(1001));
});

test('account mutation responses, remarks, logs and ownership are scoped to the caller', async () => {
  const {accounts,provider,access} = accountHarness();
  provider.deleteAccount = async id => { accounts.splice(accounts.findIndex(a => a.id === id), 1); return { accounts }; };
  const h = routes();
  registerAdminAccountRoutes({app:h.app,provider,...access,userStore:{DEFAULT_ACCOUNT_LIMIT:10},
    findAccountByRef:(list,id)=>list.find(a=>a.id===String(id)),getIo:()=>null,
    addOrUpdateAccount:input=>{ if(input.id) Object.assign(accounts.find(a=>a.id===input.id),input); else accounts.push({...input,id:'3'}); return {accounts}; },
    deleteAccount:id=>{accounts.splice(accounts.findIndex(a=>a.id===id),1); return {accounts};},
  });
  for (const [method,path,fields] of [
    ['get','/api/accounts',{}],
    ['post','/api/accounts',{body:{id:'1',name:'Renamed'}}],
    ['post','/api/account/remark',{body:{id:'1',remark:'My farm'}}],
    ['post','/api/accounts',{body:{name:'New farm'}}],
    ['delete','/api/accounts/:id',{params:{id:'3'}}],
  ]) {
    const res = await h.call(method,path,alice,fields);
    assert.equal(res.statusCode,200, path);
    assert.ok(res.body.data.accounts.every(a=>a.userId===1001),path);
    assert.equal(JSON.stringify(res.body).includes('fixture-private-code'),false);
  }
  assert.equal(accounts[0].userId,1001);
  assert.equal((await h.call('post','/api/accounts',alice,{body:{id:'1',name:'Injected',role:'admin'}})).statusCode,400);
  assert.equal((await h.call('post','/api/accounts',alice,{body:{id:'1',deleting:true}})).statusCode,400);
  assert.equal(accounts[0].role,undefined);
  assert.equal(accounts[0].deleting,undefined);
  assert.equal((await h.call('post','/api/account/remark',alice,{body:{id:'2',remark:'attack'}})).statusCode,404);
  assert.equal(accounts[1].name,'Bob');
  const logs = await h.call('get','/api/logs',alice,{query:{accountId:'all'}});
  assert.deepEqual(logs.body.data.map(row=>row.accountId),['1']);
  assert.equal((await h.call('get','/api/logs',alice,{query:{accountId:'2'}})).statusCode,403);
  const history = await h.call('get','/api/account-logs',alice);
  assert.deepEqual(history.body.map(row=>row.accountId),['1']);
  assert.equal((await h.call('get','/api/accounts',admin)).body.data.accounts.length,2);
});

test('YYB rejects another user before upstream calls and forwards trusted identity only', async t => {
  const {accounts,access} = accountHarness();
  const previous = {url:process.env.YYB_API_URL,key:process.env.YYB_API_KEY};
  process.env.YYB_API_URL='http://fixture-internal'; process.env.YYB_API_KEY='fixture-service-key';
  t.after(()=>{ for(const [key,value] of [['YYB_API_URL',previous.url],['YYB_API_KEY',previous.key]]) { if(value===undefined) delete process.env[key]; else process.env[key]=value; } });
  const h = routes();
  registerAdminYybRoutes({app:h.app,requireAdminToken(){},...access});
  const calls=[];
  t.mock.method(globalThis,'fetch',async (url,init)=>{
    calls.push({url,init});
    const data=url.endsWith('/accounts') ? accounts.map(a=>({openid:a.yybOpenid,nickname:a.name}))
      : url.endsWith('/confirm') ? {openid:'wx-new'}
        : url.endsWith('/wxapp/getCode') ? {result:{code:'fixture-code'}} : [];
    return {status:200,json:async()=>({code:0,data})};
  });
  for (const [method,path,fields] of [
    ['get','/api/yyb/account-proxy',{query:{ref:'wx-bob'}}],
    ['put','/api/yyb/account-proxy',{body:{ref:'wx-bob',mode:'direct'}}],
    ['post','/api/yyb/getcode',{body:{openid:'wx-bob'}}],
  ]) assert.equal((await h.call(method,path,alice,fields)).statusCode,403);
  assert.equal(calls.length,0);
  const listed=await h.call('post','/api/yyb/accounts',alice,{body:{apiBase:'http://untrusted',apiKey:'untrusted',role: 'admin',userId:1000}});
  assert.deepEqual(listed.body.data.map(row=>row.openid),['wx-alice']);
  assert.equal(calls[0].url,'http://fixture-internal/accounts');
  assert.equal(calls[0].init.headers['X-Farm-User-ID'],'1001');
  assert.equal(calls[0].init.headers['X-Farm-Role'],'user');
  assert.equal(calls[0].init.headers.Authorization,'Bearer fixture-service-key');
  assert.equal((await h.call('post','/api/yyb/accounts',admin)).body.data.length,2);
  assert.equal((await h.call('post','/api/yyb/qr/confirm',alice,{body:{sessionId:'new-session'}})).statusCode,200);
  assert.equal((await h.call('post','/api/yyb/getcode',alice,{body:{openid:'wx-new'}})).statusCode,200);
  assert.equal((await h.call('post','/api/yyb/getcode',bob,{body:{openid:'wx-new'}})).statusCode,403);
});
