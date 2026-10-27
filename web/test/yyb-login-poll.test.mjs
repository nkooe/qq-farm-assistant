import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

// Exercise the actual modal's login flow with controlled API responses and time.
const source = readFileSync(new URL('../src/components/AccountModal.vue', import.meta.url), 'utf8')
const flow = source.slice(source.indexOf('const yybAccountName'), source.indexOf('async function addAccount'))
const compiled = ts.transpileModule(flow, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

function harness(post, options = {}) {
  const timers = new Map()
  let nextTimer = 0
  const context = vm.createContext({
    AbortController,
    ref: value => ({ value }),
    reactive: value => value,
    computed: get => ({ get value() { return get() } }),
    props: { show: true, ...options.props },
    activeTab: { value: 'yyb' },
    api: { post, get: options.get },
    emit: () => {},
    setTimeout: (callback, delay) => {
      timers.set(++nextTimer, { callback, delay })
      return nextTimer
    },
    clearTimeout: id => timers.delete(id),
    imported: 0,
  })
  vm.runInContext(`${compiled}
    ${options.importAccount ? '' : 'importYybAccount = async () => { imported++ }'}
    this.login = { importYybAccount, pollYybLogin, startYybLogin, stopYybPolling, yybStage, yybBusy, yybAccountName, yybSuccess }
    yybProxyReady.value = ${options.proxyNotReady ? 'false' : 'true'}
    Object.assign(this.login, { loadYybProxyOptions, retryYybProxyOptions, startYybLoginWhenReady, scheduleYybLogin,
      changeYybProxy, resetYybLogin, startSavedYybAccount, yybProxyReady, yybProxyError, yybProxyMode,
      yybProxyProfileId, yybProxyProfiles, yybStartError, yybQrImage })
  `, context)
  return {
    context,
    login: context.login,
    timers,
    async tick() {
      const [id, { callback }] = timers.entries().next().value
      timers.delete(id)
      callback()
      await settle()
    },
  }
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve))
}

function response(status) {
  return { data: { data: { status } } }
}

test('unknown is paced, regeneration stays available, authorization is required for import', async () => {
  const statuses = ['unknown', 'scanned', 'authorized']
  let calls = 0
  const h = harness(async () => response(statuses[calls++]))
  const polling = h.login.pollYybLogin('session', 0)
  await settle()
  assert.equal(calls, 1)
  assert.equal(h.login.yybStage.value, 'unknown')
  assert.equal(h.login.yybBusy.value, false)
  assert.equal(h.context.imported, 0)
  assert.equal(h.timers.values().next().value.delay, 1500)
  await h.tick()
  assert.equal(h.login.yybStage.value, 'scanned')
  assert.equal(h.context.imported, 0)
  await h.tick()
  await polling
  assert.equal(h.context.imported, 1)
  assert.equal(calls, 3)
})

test('closing cancels the retry delay and does not send another poll', async () => {
  let calls = 0
  const h = harness(async () => { calls++; return response('unknown') })
  const polling = h.login.pollYybLogin('session', 0)
  await settle()
  h.login.stopYybPolling()
  await polling
  assert.equal(calls, 1)
  assert.equal(h.timers.size, 0)
})

test('replacement ignores authorization arriving from the previous QR session', async () => {
  let resolveOld
  const ids = []
  const h = harness(async (path, body) => {
    if (path.endsWith('/create'))
      return { data: { data: { session_id: 'new', image_base64: 'data:image/jpeg;base64,test' } } }
    ids.push(body.sessionId)
    if (body.sessionId === 'old')
      return new Promise(resolve => { resolveOld = resolve })
    return response('pending')
  })
  const oldPolling = h.login.pollYybLogin('old', 0)
  await h.login.startYybLogin()
  resolveOld(response('authorized'))
  await oldPolling
  await settle()
  assert.deepEqual(ids, ['old', 'new'])
  assert.equal(h.context.imported, 0)
  assert.equal(h.login.yybStage.value, 'pending')
  h.login.stopYybPolling()
  await settle()
})

test('temporary upstream failures retry with backoff, persistent failure stops visibly', async () => {
  let calls = 0
  const h = harness(async () => {
    calls++
    throw { response: { status: 502, data: { error: 'upstream unavailable' } } }
  })
  const polling = h.login.pollYybLogin('session', 0)
  await settle()
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(h.timers.values().next().value.delay, 1500 * attempt)
    await h.tick()
  }
  await polling
  assert.equal(calls, 4)
  assert.equal(h.login.yybStage.value, 'error')
  assert.equal(h.login.yybBusy.value, false)
  assert.equal(h.timers.size, 0)
})

test('proxy load failure preserves selected exit and prevents automatic or manual QR creation', async () => {
  let creates = 0
  const h = harness(async () => { creates++ }, {
    proxyNotReady: true,
    props: { editData: { yybOpenid: 'wx-a' } },
    get: async () => { throw new Error('network unavailable') },
  })
  h.login.yybProxyMode.value = 'static'
  h.login.yybProxyProfileId.value = 7
  await h.login.loadYybProxyOptions()
  await h.login.startYybLoginWhenReady(0)
  await h.login.startYybLogin()
  assert.equal(creates, 0)
  assert.equal(h.login.yybProxyMode.value, 'static')
  assert.equal(h.login.yybProxyProfileId.value, 7)
  assert.equal(h.login.yybProxyReady.value, false)
  assert.match(h.login.yybProxyError.value, /network/)
})

test('successful settings retry restores saved static exit before QR is generated', async () => {
  let resolveSettings
  let createBody
  const h = harness(async (path, body) => {
    if (path.endsWith('/create')) {
      createBody = body
      return { data: { data: { session_id: 'new', image_base64: 'data:image/png;base64,qr' } } }
    }
    return response('pending')
  }, {
    proxyNotReady: true,
    props: { editData: { yybOpenid: 'wx-a' } },
    get: async path => path.includes('proxy-profiles')
      ? { data: { ok: true, data: [{ id: 7 }] } }
      : new Promise(resolve => { resolveSettings = resolve }),
  })
  const retry = h.login.retryYybProxyOptions()
  await settle()
  assert.equal(createBody, undefined)
  resolveSettings({ data: { ok: true, data: { mode: 'static', proxy_profile_id: 7 } } })
  await retry
  await settle()
  assert.equal(createBody.proxyMode, 'static')
  assert.equal(createBody.proxyProfileId, 7)
  h.login.resetYybLogin()
})

test('changing proxy invalidates old QR and coalesces changes into one new QR', async () => {
  const created = []
  let oldResolve
  const h = harness(async (path, body) => {
    if (path.endsWith('/create')) {
      created.push(body)
      return { data: { data: { session_id: 'new', image_base64: 'new-image' } } }
    }
    if (body.sessionId === 'old') return new Promise(resolve => { oldResolve = resolve })
    return response('pending')
  })
  const polling = h.login.pollYybLogin('old', 0)
  h.login.yybQrImage.value = 'old-image'
  h.login.yybProxyMode.value = 'static'
  h.login.changeYybProxy()
  assert.equal(h.login.yybQrImage.value, '')
  h.login.yybProxyProfileId.value = 7
  h.login.changeYybProxy()
  oldResolve(response('authorized'))
  await polling
  await h.tick()
  assert.equal(created.length, 1)
  assert.equal(created[0].proxyProfileId, 7)
  assert.equal(h.context.imported, 0)
  h.login.resetYybLogin()
})

test('accepted startup is not reported online until actual connection; failure retries without saving again', async () => {
  let status = 'starting'
  let starts = 0
  const h = harness(async path => {
    assert.match(path, /\/start$/)
    starts++
    return { data: { ok: true } }
  }, { get: async () => ({ data: { ok: true, data: { state: status, connected: status === 'online', error: status === 'failed' ? 'proxy unavailable' : '' } } }) })
  h.login.yybSuccess.value = { accountId: '1', name: 'A', isUpdate: true, status: 'saved' }
  const starting = h.login.startSavedYybAccount()
  await settle()
  assert.equal(h.login.yybSuccess.value.status, 'starting')
  status = 'failed'
  await h.tick()
  await starting
  assert.equal(h.login.yybSuccess.value.status, 'failed')
  assert.match(h.login.yybStartError.value, /proxy unavailable/)
  status = 'online'
  await h.login.startSavedYybAccount()
  assert.equal(starts, 2)
  assert.equal(h.login.yybSuccess.value.status, 'online')
})

test('closing cancels runtime polling without sending another startup or status request', async () => {
  let statuses = 0
  const h = harness(async () => ({ data: { ok: true } }), {
    get: async () => { statuses++; return { data: { ok: true, data: { state: 'starting' } } } },
  })
  h.login.yybSuccess.value = { accountId: '1', status: 'saved' }
  const starting = h.login.startSavedYybAccount()
  await settle()
  h.login.resetYybLogin()
  await starting
  assert.equal(statuses, 1)
  assert.equal(h.timers.size, 0)
})

for (const scenario of [
  { name: 'editing A and scanning B creates B without replacing A or inheriting its remark', openid: 'wx-b', targetId: '2', isUpdate: false },
  { name: 'scanning A again updates A and preserves its remark', openid: 'wx-a', targetId: '1', isUpdate: true },
  { name: 'editing A and scanning existing B updates B, leaving A intact', openid: 'wx-b', targetId: '2', isUpdate: true, existingB: true },
  { name: 'third-party identity does not absorb a new builtin account', openid: 'wx-b', targetId: '3', isUpdate: false, existingB: true, thirdparty: true },
]) {
  test(scenario.name, async () => {
    const original = { id: '1', name: 'A remark', yybOpenid: 'wx-a', provider: 'builtin', code: 'old-a' }
    const accounts = [{ ...original }]
    if (scenario.existingB)
      accounts.push({ id: '2', name: 'B remark', yybOpenid: 'wx-b', provider: scenario.thirdparty ? 'thirdparty' : 'builtin', code: 'old-b' })
    const started = []
    const h = harness(async (path, body) => {
      if (path.endsWith('/confirm'))
        return { data: { data: { openid: scenario.openid, nickname: 'B nickname' } } }
      if (path === '/api/yyb/getcode')
        return { data: { data: { code: 'fresh-code' } } }
      if (path === '/api/accounts') {
        if (body.id)
          Object.assign(accounts.find(a => a.id === body.id), body)
        else
          accounts.push({ ...body, id: String(accounts.length + 1) })
        return { data: { ok: true, data: { accounts } } }
      }
      started.push(path)
      return { data: { ok: true } }
    }, {
      importAccount: true,
      props: { editData: original },
      get: async path => path.endsWith('/runtime')
        ? { data: { ok: true, data: { state: 'online', connected: true } } }
        : { data: { data: { accounts } } },
    })
    h.login.yybAccountName.value = original.name
    await h.login.importYybAccount('confirmed-session', 0)
    if (scenario.openid !== original.yybOpenid)
      assert.deepEqual(accounts[0], original)
    assert.equal(accounts.length, scenario.thirdparty ? 3 : scenario.isUpdate && !scenario.existingB ? 1 : 2)
    assert.equal(h.login.yybSuccess.value.accountId, scenario.targetId)
    assert.equal(h.login.yybSuccess.value.isUpdate, scenario.isUpdate)
    assert.equal(h.login.yybSuccess.value.status, 'online')
    assert.equal(accounts.find(a => a.id === scenario.targetId).code, 'fresh-code')
    assert.equal(accounts.find(a => a.id === scenario.targetId).openId, undefined)
    assert.deepEqual(started, [`/api/accounts/${scenario.targetId}/start`])
    assert.equal(h.login.yybSuccess.value.name, scenario.openid === 'wx-a' ? 'A remark' : scenario.existingB && !scenario.thirdparty ? 'B remark' : 'B nickname')
  })
}
