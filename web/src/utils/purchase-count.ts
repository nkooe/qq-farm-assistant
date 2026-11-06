export interface PurchaseCost {
  id?: number | string
  count: number
  balance?: number | null
}

// Missing or invalid balances cannot authorize a purchase. Repeated currencies
// share one balance, so aggregate their unit costs before calculating the cap.
export function affordableCount(costs: PurchaseCost[]): number {
  const totals = new Map<string, { price: number, balance: number }>()
  for (const [index, cost] of costs.entries()) {
    if (!Number.isSafeInteger(cost.count) || cost.count < 0)
      return 0
    if (cost.count === 0)
      continue
    if (cost.balance == null || !Number.isSafeInteger(cost.balance) || cost.balance < 0)
      return 0
    const key = cost.id == null ? `row:${index}` : `id:${cost.id}`
    const previous = totals.get(key)
    const price = (previous?.price ?? 0) + cost.count
    if (!Number.isSafeInteger(price))
      return 0
    totals.set(key, { price, balance: Math.min(previous?.balance ?? cost.balance, cost.balance) })
  }
  return Math.min(Number.POSITIVE_INFINITY, ...[...totals.values()].map(cost => Math.floor(cost.balance / cost.price)))
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
