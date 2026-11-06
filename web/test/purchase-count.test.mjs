import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/utils/purchase-count.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const { affordableCount, purchaseMaxCount, clampPurchaseCount } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

test('purchase caps respect wallet, stock, multiple currencies and free goods', () => {
  assert.equal(purchaseMaxCount({ costs: [{ count: 30, balance: 100 }], limitRemaining: 8 }), 3)
  assert.equal(purchaseMaxCount({ costs: [{ count: 1, balance: 50 }], limitRemaining: 2 }), 2)
  assert.equal(purchaseMaxCount({ costs: [{ count: 30, balance: 29 }] }), 0)
  assert.equal(purchaseMaxCount({ costs: [], limitRemaining: 0 }), 0)
  assert.equal(purchaseMaxCount({ costs: [] }), 9999)
  assert.equal(affordableCount([{ id: 1, count: 2, balance: 100 }, { id: 2, count: 3, balance: 7 }]), 2)
  assert.equal(affordableCount([{ id: 1, count: 30, balance: 100 }, { id: '1', count: 30, balance: 100 }]), 1)
})

test('unknown, corrupt or unsafe costs and balances cannot authorize purchases', () => {
  for (const balance of [undefined, null, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(purchaseMaxCount({ costs: [{ count: 1, balance }] }), 0)
  for (const count of [undefined, NaN, Infinity, -1, 0.5])
    assert.equal(purchaseMaxCount({ costs: [{ count, balance: 100 }] }), 0)
  for (const limitRemaining of [NaN, Infinity, -1, 0.5])
    assert.equal(purchaseMaxCount({ limitRemaining }), 0)
  assert.equal(purchaseMaxCount({ costs: [{ count: 0 }] }), 9999)
})

test('quantity clamps on shrinking caps and zero is never turned into one', () => {
  assert.equal(clampPurchaseCount(9, 3), 3)
  assert.equal(clampPurchaseCount(3, 0), 0)
  assert.equal(clampPurchaseCount(0, 3), 1)
  for (const value of [NaN, Infinity, -Infinity, -1])
    assert.equal(clampPurchaseCount(value, 3), 1)
  assert.equal(clampPurchaseCount(2.9, 3), 2)
})
