import { expect, test } from '@playwright/test'

function snapshot(accountId = '1') {
  const name = accountId === '1' ? '测试藏品甲' : '测试藏品乙'
  return {
    category: 1,
    score: 0,
    claimedScore: 0,
    activatedCount: 0,
    totalCount: 1,
    nextRewardScore: 400,
    currentBuffs: [],
    milestones: [],
    display: null,
    pedestals: [],
    series: [{ id: 2002, name: '测试系列', rarity: 2, rarityName: '稀有', description: '', requirements: [], mutationRules: [], activatedCount: 0, totalCount: 1, items: [{ id: 700001, name, image: '/game-config/700001.png', description: '', starLevel: 0, maxStarLevel: 5, ownCount: '3', activated: false, isNew: false, score: 0, displayed: false, wished: false, requirements: [], unlocked: true, canUpgrade: true, nextStarCosts: [{ itemId: 700001, count: '1', name, image: '' }] }] }],
  }
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort())
  await page.route('**/game-config/**', route => route.fulfill({ path: '../core/src/modern/gameConfig/seed_images_named/seed_images/700001.png' }))
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: {} } }))
})

test('collections display owned copies separately and confirm activation costs', async ({ page }) => {
  const writes: any[] = []
  await page.route('**/api/collections', route => route.fulfill({ json: { ok: true, data: snapshot() } }))
  await page.route('**/api/collections/upgrade', async (route) => {
    writes.push(route.request().postDataJSON())
    const after = snapshot()
    Object.assign(after.series[0].items[0], { starLevel: 1, activated: true, ownCount: '2' })
    after.activatedCount = after.series[0].activatedCount = 1
    await route.fulfill({ json: { ok: true, data: { snapshot: after } } })
  })
  await page.goto('/test/browser/catalogs.html')
  await expect(page.locator('html')).toHaveClass(test.info().project.name === 'mobile-dark' ? /dark/ : /^$/)
  await expect(page.getByText('待激活 · 持有 3', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /测试藏品甲/ }).click()
  await page.getByRole('button', { name: '激活', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: '确认激活' })
  await expect(confirm).toContainText('消耗：测试藏品甲 ×1')
  await confirm.getByRole('button', { name: '确定', exact: true }).click()
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]).toEqual({ collectionId: 700001, expectedStarLevel: 0, expectedCosts: [{ itemId: 700001, count: '1' }] })
  await expect(page.getByText('已激活', { exact: true }).first()).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: test.info().outputPath('collections.png') })
})

test('late collection reads cannot reveal the previous account snapshot', async ({ page }) => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => release = resolve)
  await page.route('**/api/collections', async (route) => {
    const id = route.request().headers()['x-account-id']
    if (id === '1')
      await held
    await route.fulfill({ json: { ok: true, data: snapshot(id) } })
  })
  await page.goto('/test/browser/catalogs.html')
  await page.getByTestId('switch').click()
  await expect(page.getByText('测试藏品乙', { exact: true })).toBeVisible()
  release()
  await expect(page.getByText('测试藏品甲', { exact: true })).toHaveCount(0)
  await expect(page.getByText('测试藏品乙', { exact: true })).toBeVisible()
})

test('mall shows a weekly cap and stops purchases after switching accounts', async ({ page }) => {
  await page.route('**/api/game-mall?**', route => route.fulfill({ json: { ok: true, data: {
    serverTime: Date.now(),
    refreshCountdown: 3600,
    slotType: 1,
    currencies: [{ id: 1002, name: '点券', count: 100, image: '', balanceKnown: true }],
    goods: [{
      id: 71,
      name: '测试礼包',
      rewards: [{ id: 700001, name: '测试藏品甲', count: 1, image: '' }],
      price: { id: 1002, name: '点券', count: 2, balance: 100, image: '' },
      isFree: false,
      limit: { type: 2, max: 4, bought: 1, remaining: 3 },
      purchasable: true,
      purchaseStatus: 'available',
      discountEndTime: 0,
    }],
  } } }))
  await page.goto('/test/browser/catalogs.html?page=mall')
  await expect(page.getByText('每周限购 1/4', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '购买', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: '购买', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  // Simulate an account update arriving externally while a modal makes the page inert.
  await page.getByTestId('switch').evaluate(element => (element as HTMLButtonElement).click())
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: test.info().outputPath('game-mall.png') })
})
