import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const { createPinia, setActivePinia } = require('pinia')
const source = readFileSync(new URL('../src/stores/setting.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })

function harness(api) {
  const account = { currentAccountId: 'A' }
  const exports = {}
  // eslint-disable-next-line no-new-func
  new Function('require', 'exports', outputText)((name) => {
    if (name === '@/api')
      return { default: api }
    if (name === '@/stores/account')
      return { useAccountStore: () => account }
    return require(name)
  }, exports)
  setActivePinia(createPinia())
  return { store: exports.useSettingStore(), account }
}

test('email hour saves and reloads midnight and 23 independently for each account', async () => {
  const saved = new Map()
  const h = harness({
    post: async (url, body, config) => {
      assert.equal(url, '/api/settings/save')
      saved.set(config.headers['x-account-id'], body)
      return { data: { ok: true } }
    },
    get: async (url, config) => {
      assert.equal(url, '/api/settings')
      return { data: { ok: true, data: saved.get(config.headers['x-account-id']) } }
    },
  })
  assert.equal(h.store.settings.emailClaimHour, 10)
  await h.store.saveSettings('A', { emailClaimHour: 0, plantDelaySeconds: 0, stealDelaySeconds: 0 })
  assert.equal(h.store.settings.emailClaimHour, 0)
  h.account.currentAccountId = 'B'
  await h.store.saveSettings('B', { emailClaimHour: 23 })
  assert.equal(h.store.settings.emailClaimHour, 23)
  h.account.currentAccountId = 'A'
  await h.store.fetchSettings('A')
  assert.equal(h.store.settings.emailClaimHour, 0)
  assert.equal(h.store.settings.plantDelaySeconds, 0)
  assert.equal(saved.get('B').emailClaimHour, 23)
  h.store.clearSettingsState()
  assert.equal(h.store.settings.emailClaimHour, 10)
})

test('a previous account save completing after a switch cannot reload its settings', async () => {
  let release
  const pending = new Promise(resolve => release = resolve)
  const requested = []
  const h = harness({
    post: async () => {
      await pending
      return { data: { ok: true } }
    },
    get: async (url, config) => {
      requested.push(config.headers['x-account-id'])
      return { data: { ok: true, data: { emailClaimHour: 7 } } }
    },
  })
  const saving = h.store.saveSettings('A', { emailClaimHour: 23 })
  h.account.currentAccountId = 'B'
  await h.store.fetchSettings('B')
  release()
  await saving
  assert.deepEqual(requested, ['B'])
  assert.equal(h.store.settings.emailClaimHour, 7)
})
