import type { Page, Route } from '@playwright/test'
import { expect, test } from '@playwright/test'

function growing(id: number, extras = {}) {
  return { id, unlocked: true, status: 'growing', plantName: `作物${id}`, phaseName: '生长期', matureInSec: 3600, totalGrowTime: 7200, currentSeason: 1, totalSeason: 2, organicFertilizerRemaining: 2, level: 5, ...extras }
}
const initialLands = [growing(1, { plantSize: 2, occupiedLandIds: [1, 2, 3, 4] }), ...[2, 3, 4].map(id => growing(id, { occupiedByMaster: true, masterLandId: 1 })), growing(5, { needWater: true }), growing(6, { organicFertilizerRemaining: 0 }), growing(7, { status: 'harvestable', matureInSec: 0, phaseName: '成熟' }), growing(8, { status: 'empty', plantName: '' }), growing(9, { status: 'locked', unlocked: false })]
const card = (page: Page, id: number) => page.locator(`[data-land-id="${id}"]`)

function result(ids: number[], overrides = {}) {
  return { action: 'fertilizeNormal', requestedLandIds: ids, targetLandIds: ids, successLandIds: ids, skipped: [], failedLandIds: [], unconfirmedLandIds: [], uncertain: false, error: '', fertilizerRemainingSec: null, fertilizerConsumedSec: null, ...overrides }
}
async function setup(page: Page, lands = initialLands) {
  // Every API is mocked. No game mutation or external network traffic is used by the fixture.
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort())
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: {} } }))
  await page.route('**/api/status', route => route.fulfill({ json: { ok: true, data: { connection: { connected: true } } } }))
  await page.route('**/api/lands', route => route.fulfill({ json: { ok: true, data: { lands, summary: {} } } }))
  await page.goto('/test/browser/farm.html')
  await expect(card(page, 1)).toBeVisible()
}
async function confirm(page: Page, title: string) {
  const dialog = page.getByRole('dialog', { name: title })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '确定', exact: true }).click()
}

test('land details compare bonuses, keep large costs exact and expose unknown balances without spending', async ({ page }, testInfo) => {
  const level = { name: '黑土地', image: '/land-assets/3.png', yieldBonus: 200, growthReduction: 10, expBonus: 0, mutantMultiplier: 0, resonanceBonus: 0 }
  await setup(page, [growing(1, { landInfo: { mode: 'upgrade', current: level, next: { ...level, name: '金土地', yieldBonus: 300 }, needLevel: 40, serverAllowed: false, costs: [{ id: '1001', count: '9007199254740993', name: '金币' }], unknown: false } })])
  const button = page.getByRole('button', { name: '土地 #1 详情', exact: true })
  await button.focus()
  await button.press('Enter')
  const dialog = page.getByRole('dialog', { name: '土地 #1 详情', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('9,007,199,254,740,993')
  await expect(dialog).toContainText('余额待同步')
  await expect(dialog.getByRole('table')).toContainText('300%')
  expect(await dialog.evaluate(el => el.getBoundingClientRect().right <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('land-detail.png') })
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(button).toBeFocused()
  await button.click()
  // Account change must dismiss details, even if the same land ID exists there.
  await page.evaluate(() => (document.querySelector('[data-testid="switch"]') as HTMLButtonElement).click())
  await expect(dialog).toBeHidden()
})

test('merged cards stay independent, keyboard selection maps slaves to one master and submits only fixed IDs', async ({ page }) => {
  await setup(page)
  const calls: any[] = []
  await page.route('**/api/farm/selected', async (route) => {
    calls.push({ body: route.request().postDataJSON(), account: route.request().headers()['x-account-id'] })
    await route.fulfill({ json: { ok: true, data: result([1], { fertilizerConsumedSec: 600, fertilizerRemainingSec: 1200 }) } })
  })
  expect((await card(page, 1).boundingBox())!.width).toBeCloseTo((await card(page, 2).boundingBox())!.width, 0)
  await page.getByRole('button', { name: '选地普通肥', exact: true }).click()
  await expect(page.getByRole('button', { name: '对所选普通肥', exact: true })).toBeDisabled()
  await card(page, 2).focus()
  await card(page, 2).press('Space')
  await expect(card(page, 1)).toHaveAttribute('aria-checked', 'true')
  await expect(card(page, 3)).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText('普通肥 · 已选 1 株')).toBeVisible()
  await card(page, 3).press('Enter')
  await expect(card(page, 1)).toHaveAttribute('aria-checked', 'false')
  await card(page, 4).click()
  await page.getByRole('button', { name: '对所选普通肥', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('仅对主地 #1')
  await expect(dialog).not.toContainText('#5')
  await confirm(page, '确认所选土地普通肥')
  await expect(page.getByRole('status')).toContainText('确认成功 1 株')
  await expect(page.getByRole('status')).toContainText('消耗肥料 600 秒，剩余肥料 1200 秒')
  expect(calls).toEqual([{ body: { action: 'fertilizeNormal', landIds: [1] }, account: '1' }])
  await expect(page.getByText('普通肥 · 已选 0 株')).toBeVisible()
})

async function visibility(page: Page, state: 'visible' | 'hidden') {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}

test('countdown updates cards without updating the panel; maturity removes fertilizer eligibility once', async ({ page }) => {
  await page.clock.install()
  await setup(page, [growing(1, { matureInSec: 30 }), growing(5)])
  await page.getByRole('button', { name: '选地普通肥', exact: true }).click()
  await card(page, 1).click()
  await expect(page.getByText('普通肥 · 已选 1 株')).toBeVisible()
  const updates = await page.evaluate(() => (window as any).__farmMetrics.panelUpdates)
  await page.clock.runFor(10000)
  await expect(card(page, 1).locator('.phase-text')).toHaveText('00:20 后成熟')
  expect(await page.evaluate(() => (window as any).__farmMetrics.panelUpdates)).toBe(updates)
  await page.clock.runFor(20000)
  await expect(card(page, 1)).toHaveAttribute('aria-disabled', 'true')
  await expect(card(page, 1)).toContainText('待刷新确认成熟')
  await expect(page.getByText('普通肥 · 已选 0 株')).toBeVisible()
  await page.getByRole('button', { name: '选地收获', exact: true }).click()
  await expect(card(page, 1)).toHaveAttribute('aria-disabled', 'true')
})

test('hidden pages stop countdown and polling; wake calibrates elapsed time and refreshes once', async ({ page }) => {
  await page.clock.install()
  await setup(page)
  let reads = 0
  let wake: Route | undefined
  await page.route('**/api/lands', (route) => {
    reads++
    wake = route
  })
  await page.getByRole('button', { name: '选地普通肥', exact: true }).click()
  await card(page, 1).click()
  await visibility(page, 'hidden')
  const text = await card(page, 1).locator('.phase-text').textContent()
  const updates = await page.evaluate(() => (window as any).__farmMetrics.panelUpdates)
  await page.clock.runFor(125000)
  expect(await card(page, 1).locator('.phase-text').textContent()).toBe(text)
  expect(await page.evaluate(() => (window as any).__farmMetrics.panelUpdates)).toBe(updates)
  expect(reads).toBe(0)
  await visibility(page, 'visible')
  await expect(card(page, 1).locator('.phase-text')).toHaveText('57:55 后成熟')
  await expect.poll(() => reads).toBe(1)
  // No overlapping polls while the wake refresh is still awaiting its response.
  await page.clock.runFor(120000)
  expect(reads).toBe(1)
  await wake!.fulfill({ json: { ok: true, data: { lands: [growing(1, { matureInSec: 100 })] } } })
  await expect(card(page, 1).locator('.phase-text')).toHaveText('01:40 后成熟')
  await page.clock.runFor(59000)
  expect(reads).toBe(1)
  await page.clock.runFor(1000)
  await expect.poll(() => reads).toBe(2)
  await wake!.fulfill({ json: { ok: true, data: { lands: [growing(1)] } } })
})

test('waking behind an in-flight read waits then requests a fresh snapshot; account changes reset the clock', async ({ page }) => {
  await page.clock.install()
  await setup(page, [growing(1, { matureInSec: 10 })])
  const pending: Route[] = []
  await page.route('**/api/lands', (route) => {
    pending.push(route)
  })
  await page.getByRole('button', { name: '刷新土地', exact: true }).click()
  await expect.poll(() => pending.length).toBe(1)
  await visibility(page, 'hidden')
  await page.clock.runFor(15000)
  await visibility(page, 'visible')
  await expect(card(page, 1)).toContainText('待刷新确认成熟')
  expect(pending).toHaveLength(1)
  await pending[0]!.fulfill({ json: { ok: true, data: { lands: [growing(1, { matureInSec: 2 })] } } })
  await expect.poll(() => pending.length).toBe(2)
  await pending[1]!.fulfill({ json: { ok: true, data: { lands: [growing(1, { matureInSec: 100 })] } } })
  await expect(card(page, 1).locator('.phase-text')).toHaveText('01:40 后成熟')
  await page.getByTestId('switch').click()
  await expect.poll(() => pending.length).toBe(3)
  await pending[2]!.fulfill({ json: { ok: true, data: { lands: [growing(1, { matureInSec: 300 })] } } })
  await expect(card(page, 1).locator('.phase-text')).toHaveText('05:00 后成熟')
  await page.clock.setSystemTime(new Date('2000-01-01T00:00:00Z'))
  await page.clock.runFor(5000)
  await expect(card(page, 1).locator('.phase-text')).toHaveText('04:55 后成熟')
})

test('same-account land reads coalesce and a mutation forces exactly one fresh snapshot', async ({ page }) => {
  await setup(page)
  const pending: Route[] = []
  await page.route('**/api/lands', (route) => {
    pending.push(route)
  })
  await page.getByTestId('merge-fetch').click()
  await page.getByTestId('merge-fetch').click()
  await expect.poll(() => pending.length).toBe(1)
  await page.route('**/api/farm/operate', route => route.fulfill({ json: { ok: true } }))
  await page.getByRole('button', { name: '一键务农', exact: true }).click()
  await confirm(page, '确认全场操作')
  await expect.poll(() => pending.length).toBe(2)
  await pending[1]!.fulfill({ json: { ok: true, data: { lands: [growing(10)] } } })
  await expect(card(page, 10)).toBeVisible()
  await pending[0]!.fulfill({ status: 503, json: { ok: false, error: '旧请求失败' } })
  await expect(card(page, 1)).toHaveCount(0)
  expect(pending).toHaveLength(2)
})

test('hiding during a status read defers land reads and operation completion until wake', async ({ page }) => {
  await page.clock.install()
  await setup(page)
  const statuses: Route[] = []
  let reads = 0
  await page.route('**/api/status', (route) => {
    statuses.push(route)
  })
  await page.route('**/api/lands', (route) => {
    reads++
    return route.fulfill({ json: { ok: true, data: { lands: initialLands } } })
  })
  await page.clock.runFor(60000)
  await expect.poll(() => statuses.length).toBe(1)
  await visibility(page, 'hidden')
  await statuses[0]!.fulfill({ json: { ok: true, data: { connection: { connected: true } } } })
  await page.clock.runFor(60000)
  expect(reads).toBe(0)
  await visibility(page, 'visible')
  await expect.poll(() => statuses.length).toBe(2)
  await statuses[1]!.fulfill({ json: { ok: true, data: { connection: { connected: true } } } })
  await expect.poll(() => reads).toBe(1)
  let finish: Route | undefined
  let sends = 0
  await page.route('**/api/farm/selected', (route) => {
    sends++
    finish = route
  })
  await page.getByRole('button', { name: '催熟 #1', exact: true }).click()
  await confirm(page, '确认所选土地有机肥')
  await expect.poll(() => sends).toBe(1)
  await visibility(page, 'hidden')
  await finish!.fulfill({ json: { ok: true, data: result([1]) } })
  await expect(page.getByRole('status')).toContainText('确认成功 1 株')
  expect(reads).toBe(1)
  await visibility(page, 'visible')
  await expect.poll(() => statuses.length).toBe(3)
  await statuses[2]!.fulfill({ json: { ok: true, data: { connection: { connected: true } } } })
  await expect.poll(() => reads).toBe(2)
  expect(sends).toBe(1)
})

test('action eligibility, select all and clear never select mature, empty or locked crops for fertilizer', async ({ page }) => {
  await setup(page)
  await page.getByRole('button', { name: '选地有机肥', exact: true }).click()
  await expect(card(page, 6)).toHaveAttribute('aria-disabled', 'true')
  await expect(card(page, 6)).toContainText('有机肥次数已用完')
  await expect(card(page, 7)).toHaveAttribute('aria-disabled', 'true')
  await page.getByRole('button', { name: '全选可用', exact: true }).click()
  await expect(page.getByText('有机肥 · 已选 2 株')).toBeVisible()
  await page.getByRole('button', { name: '清空', exact: true }).click()
  await expect(page.getByRole('button', { name: '对所选有机肥', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '选地务农', exact: true }).click()
  await page.getByRole('button', { name: '全选可用', exact: true }).click()
  await expect(page.getByText('务农 · 已选 1 株')).toBeVisible()
  await expect(card(page, 5)).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('button', { name: '选地收获', exact: true }).click()
  await expect(page.getByText('收获 · 已选 0 株')).toBeVisible()
  await page.getByRole('button', { name: '全选可用', exact: true }).click()
  await expect(card(page, 7)).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('button', { name: '退出选地', exact: true }).click()
  await expect(page.getByRole('checkbox')).toHaveCount(0)
})

test('account switch and disconnect cancel pending confirmations; late operations cannot pollute another account', async ({ page }) => {
  await setup(page)
  const calls: any[] = []
  let release: (() => Promise<void>) | undefined
  await page.route('**/api/farm/selected', (route) => {
    calls.push(route.request().postDataJSON())
    release = () => route.fulfill({ json: { ok: true, data: result([1]) } })
  })
  await page.getByRole('button', { name: '铲除 #1', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('铲除不可恢复')
  // The fixture button deliberately changes the account while the modal is open.
  await page.getByTestId('switch').evaluate((el: HTMLElement) => el.click())
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(calls).toHaveLength(0)
  await expect(card(page, 1)).toBeVisible()
  await page.getByRole('button', { name: '催熟 #1', exact: true }).focus()
  await page.getByRole('button', { name: '催熟 #1', exact: true }).press('Enter')
  await confirm(page, '确认所选土地有机肥')
  await expect.poll(() => calls.length).toBe(1)
  await page.getByTestId('switch').click()
  await release!()
  await expect(page.getByRole('status')).toHaveCount(0)
  await page.getByRole('button', { name: '选地铲除', exact: true }).click()
  await card(page, 1).click()
  await page.getByRole('button', { name: '对所选铲除', exact: true }).click()
  await page.getByTestId('disconnect').evaluate((el: HTMLElement) => el.click())
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('账号未连接，请先运行账号或检查网络连接')).toBeVisible()
  expect(calls).toHaveLength(1)
})

test('partial success retains eligible failures; uncertain replies require a manual refresh and never replay automatically', async ({ page }) => {
  await setup(page)
  let sends = 0
  await page.route('**/api/farm/selected', (route) => {
    sends++
    return route.fulfill({ json: { ok: true, data: result([1, 5], {
      successLandIds: [1],
      unconfirmedLandIds: [5],
      uncertain: true,
      error: '请求超时',
    }) } })
  })
  await page.getByRole('button', { name: '选地有机肥', exact: true }).click()
  await page.getByRole('button', { name: '全选可用', exact: true }).click()
  await page.getByRole('button', { name: '对所选有机肥', exact: true }).click()
  await confirm(page, '确认所选土地有机肥')
  await expect(page.getByRole('status')).toContainText('结果未确认 1 株')
  await expect(page.getByText('有机肥 · 已选 1 株')).toBeVisible()
  await expect(page.getByRole('button', { name: '对所选有机肥', exact: true })).toBeDisabled()
  expect(sends).toBe(1)
  await page.getByRole('button', { name: '刷新土地', exact: true }).click()
  await expect(page.getByRole('button', { name: '对所选有机肥', exact: true })).toBeEnabled()
  expect(sends).toBe(1)
})

test('a manual refresh started before a mutation cannot acknowledge its later uncertain result', async ({ page }) => {
  await setup(page)
  let oldStatus: Route | undefined
  let statusReads = 0
  let landReads = 0
  await page.route('**/api/status', (route) => {
    if (++statusReads === 1) {
      oldStatus = route
      return
    }
    return route.fulfill({ json: { ok: true, data: { connection: { connected: true } } } })
  })
  await page.route('**/api/lands', (route) => {
    landReads++
    return route.fulfill({ json: { ok: true, data: { lands: initialLands } } })
  })
  await page.route('**/api/farm/selected', route => route.fulfill({ json: { ok: true, data: result([1], {
    successLandIds: [],
    unconfirmedLandIds: [1],
    uncertain: true,
  }) } }))
  await page.getByRole('button', { name: '刷新土地', exact: true }).click()
  await expect.poll(() => statusReads).toBe(1)
  await page.getByRole('button', { name: '选地普通肥', exact: true }).click()
  await card(page, 1).click()
  await page.getByRole('button', { name: '对所选普通肥', exact: true }).click()
  await confirm(page, '确认所选土地普通肥')
  await expect(page.getByRole('status')).toContainText('结果未确认 1 株')
  await expect.poll(() => landReads).toBe(1)
  await oldStatus!.fulfill({ json: { ok: true, data: { connection: { connected: true } } } })
  await expect.poll(() => landReads).toBe(2)
  await expect(page.getByRole('button', { name: '对所选普通肥', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '刷新土地', exact: true }).click()
  await expect(page.getByRole('button', { name: '对所选普通肥', exact: true })).toBeEnabled()
})

test('business failure is visible and a failed refresh preserves old data and blocks mutations', async ({ page }) => {
  await setup(page)
  let sends = 0
  await page.route('**/api/farm/selected', async (route) => {
    sends++
    await page.route('**/api/lands', landRoute => landRoute.fulfill({ json: { ok: false, error: '账号未运行' } }))
    await route.fulfill({ json: { ok: false, error: '账号未运行' } })
  })
  await page.getByRole('button', { name: '铲除 #5', exact: true }).click()
  await confirm(page, '确认所选土地铲除')
  await expect(page.getByRole('status')).toContainText('账号未运行')
  await expect(page.getByRole('alert')).toContainText('土地刷新失败')
  await expect(card(page, 1)).toBeVisible()
  await expect(page.getByRole('button', { name: '铲除 #5', exact: true })).toBeDisabled()
  expect(sends).toBe(1)
})

test('newer land requests win, account-scoped data never reappears from late responses', async ({ page }) => {
  await setup(page)
  const pending: Route[] = []
  await page.route('**/api/lands', (route) => {
    pending.push(route)
  })
  await page.getByTestId('fetch').click()
  await page.getByTestId('fetch').click()
  await expect.poll(() => pending.length).toBe(2)
  await pending[1]!.fulfill({ json: { ok: true, data: { lands: [growing(10, { plantName: '最新作物' })] } } })
  await expect(card(page, 10)).toBeVisible()
  await pending[0]!.fulfill({ json: { ok: true, data: { lands: initialLands } } })
  await expect(card(page, 1)).toHaveCount(0)
  await page.getByTestId('fetch').click()
  await expect.poll(() => pending.length).toBe(3)
  await page.getByTestId('switch').click()
  await expect.poll(() => pending.length).toBe(4)
  await pending[3]!.fulfill({ json: { ok: true, data: { lands: [growing(11, { plantName: '账号乙作物' })] } } })
  await pending[2]!.fulfill({ json: { ok: true, data: { lands: initialLands } } })
  await expect(card(page, 11)).toBeVisible()
  await expect(card(page, 1)).toHaveCount(0)
})

test('mobile and desktop selection controls fit, meet touch sizes and stay above navigation', async ({ page }, testInfo) => {
  await setup(page)
  await page.getByRole('button', { name: '选地有机肥', exact: true }).click()
  await page.getByRole('button', { name: '全选可用', exact: true }).click()
  await page.locator('.fixture-scroll').evaluate(el => el.scrollTo(0, el.scrollHeight))
  const toolbar = page.locator('.selection-toolbar')
  const box = (await toolbar.boundingBox())!
  const dock = (await page.locator('.fixture-dock').boundingBox())!
  expect(box.y + box.height).toBeLessThanOrEqual(dock.y)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const color = await toolbar.evaluate(el => getComputedStyle(el).color)
  expect(color).not.toBe('rgb(252, 165, 165)')
  for (const button of await toolbar.getByRole('button').all()) {
    const rect = (await button.boundingBox())!
    expect(rect.height).toBeGreaterThanOrEqual(44)
    expect(rect.width).toBeGreaterThanOrEqual(44)
  }
  await page.screenshot({ path: testInfo.outputPath('farm-selection.png') })
})
