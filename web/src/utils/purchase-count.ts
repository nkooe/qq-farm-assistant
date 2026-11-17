export interface PurchaseCost {
  id?: number | string
  count: number | string
  balance?: number | string | null
}

// Missing or invalid balances cannot authorize a purchase. Repeated currencies
// share one balance, so aggregate their unit costs before calculating the cap.
export function affordableCount(costs: PurchaseCost[]): number {
  const totals = new Map<string, { price: bigint, balance: bigint }>()
  const amount = (value: unknown): bigint | null => {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return null
    if (!/^(0|[1-9]\d*)$/.test(String(value))) return null
    return BigInt(String(value))
  }
  for (const [index, cost] of costs.entries()) {
    const price = amount(cost.count)
    if (price === null) return 0
    if (price === 0n) continue
    const balance = amount(cost.balance)
    if (balance === null) return 0
    const key = cost.id == null ? `row:${index}` : `id:${cost.id}`
    const previous = totals.get(key)
    totals.set(key, { price: (previous?.price ?? 0n) + price,
      balance: previous && previous.balance < balance ? previous.balance : balance })
  }
  let maximum = BigInt(Number.MAX_SAFE_INTEGER)
  for (const { price, balance } of totals.values()) {
    const count = balance / price
    if (count < maximum) maximum = count
  }
  return totals.size ? Number(maximum) : Number.POSITIVE_INFINITY
}

export function purchaseMaxCount(options: { limitRemaining?: number | null, costs?: PurchaseCost[], cap?: number }): number {
  const cap = options.cap ?? 9999
  const limit = options.limitRemaining ?? cap
  if (!Number.isSafeInteger(cap) || cap < 0 || !Number.isSafeInteger(limit) || limit < 0)
    return 0
  return Math.min(cap, limit, affordableCount(options.costs ?? []))
}

export function clampPurchaseCount(value: number, max: number): number {
  if (max <= 0)
    return 0
  return Math.min(max, Math.max(1, Number.isFinite(value) ? Math.floor(value) : 1))
}
