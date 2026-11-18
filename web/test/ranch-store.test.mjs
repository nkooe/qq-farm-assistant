import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const { createPinia, setActivePinia } = require('pinia')
const ts = require('typescript')
const { reactive } = require('vue')

const source = readFileSync(new URL('../src/stores/ranch.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })

function deferred() {
  let resolve
  const promise = new Promise(done => resolve = done)
  return { promise, resolve }
}

function harness(t, api) {
  const accounts = reactive({ currentAccountId: '1' })
  const user = reactive({ userId: 1000, token: 'test-session' })
  const mocks = {
    '@/api': { default: api, getApiErrorMessage: cause => cause.message },
    '@/stores/account': { useAccountStore: () => accounts },
    '@/stores/user': { useUserStore: () => user },
  }
  const exports = {}
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', outputText)(exports, key => Object.hasOwn(mocks, key) ? mocks[key] : require(key))
  setActivePinia(createPinia())
  const store = exports.useRanchStore()
  t.after(() => store.$dispose())
  return { store, accounts, user }
}

const reply = data => ({ data: { ok: true, data } })
const quoteReply = reply({ expected: { signature: 'quote' }, skipped: false })

test('refreshing during a quote discards the old quote and releases the operation buttons', async (t) => {
  const pending = deferred()
  const { store } = harness(t, {
    get: async () => reply({ unlocked: true, level: 2 }),
    post: async () => pending.promise,
  })
  await store.load('1', 'animals')
  const quote = store.quote('1', 'harvest', { all: true })
  const refresh = store.reload('1')
  pending.resolve(quoteReply)
  assert.equal(await quote, null, 'a quote for the previous view must not open a confirmation')
  await refresh
  assert.equal(store.busy, false)
  assert.equal(store.loading, false)
  assert.ok(await store.quote('1', 'harvest', { all: true }), 'the next operation remains available')
})

test('a view read waits for a submitted write and cannot replace its result with older data', async (t) => {
  const pending = deferred()
  let completed = false
  let reads = 0
  const { store } = harness(t, {
    get: async () => {
      reads++
      return reply({ unlocked: true, level: completed ? 3 : 2 })
    },
    post: async () => {
      await pending.promise
      completed = true
      return reply({ status: 'confirmed', notice: '已收获' })
    },
  })
  await store.load('1', 'animals')
  const write = store.execute('1', 'harvest', {}, { signature: 'quote' })
  const refresh = store.load('1', 'facilities')
  await Promise.resolve()
  assert.equal(reads, 1, 'the read must not start before the write finishes')
  pending.resolve()
  assert.equal(await write, true)
  await refresh
  assert.equal(store.state.level, 3)
  assert.equal(store.notice, '已收获')
  assert.equal(store.busy, false)
  assert.equal(store.loading, false)
})

test('switching accounts releases queued reads without leaking results or unlocking a newer operation', async (t) => {
  const old = deferred()
  const newer = deferred()
  const reads = []
  const { store, accounts } = harness(t, {
    get: async (_url, config) => {
      reads.push(config.headers['x-account-id'])
      return reply({ unlocked: true })
    },
    post: async (_url, _input, config) => config.headers['x-account-id'] === '1' ? old.promise : newer.promise,
  })
  await store.load('1', 'animals')
  const oldQuote = store.quote('1', 'harvest', {})
  const queued = store.reload('1')
  accounts.currentAccountId = '2'
  await store.load('2', 'animals')
  const newQuote = store.quote('2', 'harvest', {})
  old.resolve(quoteReply)
  assert.equal(await oldQuote, null)
  await queued
  assert.deepEqual(reads, ['1', '2'], 'the queued old-account read must not send')
  assert.equal(store.busy, true, 'old cleanup must not unlock the new account operation')
  newer.resolve(quoteReply)
  assert.ok(await newQuote)
  assert.equal(store.busy, false)
})

test('out-of-order reads and replaced user sessions cannot overwrite the active view', async (t) => {
  const reads = []
  const { store, user } = harness(t, { get: async () => {
    const read = deferred()
    reads.push(read)
    return read.promise
  } })
  const first = store.load('1', 'animals')
  await Promise.resolve()
  const second = store.load('1', 'facilities')
  await Promise.resolve()
  reads[1].resolve(reply({ level: 3 }))
  await second
  reads[0].resolve(reply({ level: 1 }))
  await first
  assert.equal(store.state.level, 3)
  const stale = store.load('1', 'animals')
  await Promise.resolve()
  user.token = 'replacement-session'
  reads[2].resolve(reply({ level: 9 }))
  await stale
  assert.equal(store.state, null)
  assert.equal(store.loading, false)
})
