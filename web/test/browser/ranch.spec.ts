import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort())
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: {} } }))
  await page.route('**/game-config/**', route => route.fulfill({ path: '../core/src/modern/gameConfig/seed_images_named/seed_images/7001.png' }))
})

test('ranch late reads are discarded when the account changes', async ({ page }) => {
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/ranch?**', async (route) => {
    const id = route.request().headers()['x-account-id']
    if (id === '1')
      await held
    await route.fulfill({ json: { ok: true, data: { unlocked: false, reason: id === '1' ? '旧账号的牧场状态' : '新账号的牧场状态' } } })
  })
  await page.goto('/test/browser/ranch.html')
  await page.getByTestId('switch').click()
  await expect(page.getByText('新账号的牧场状态')).toBeVisible()
  release()
  await expect(page.getByText('旧账号的牧场状态')).toHaveCount(0)
  await expect(page.getByText('新账号的牧场状态')).toBeVisible()
})

test('ranch strategy saves only ranch fields to the selected account and fits mobile', async ({ page }) => {
  const writes: any[] = []
  await page.route('**/api/settings', route => route.fulfill({ json: { ok: true, data: {
    plantingStrategy: 'bag_priority',
    automation: { farm: false, milk_tea: true, ranch_check_minutes: 5, ranch_grass_threshold_percent: 20, ranch_strategy: 'level', ranch_harvest: true },
  } } }))
  await page.route('**/api/ranch/automation-options', route => route.fulfill({ json: { ok: true, data: [] } }))
  await page.route('**/api/settings/save', async (route) => {
    writes.push({ id: route.request().headers()['x-account-id'], ...route.request().postDataJSON() })
    await route.fulfill({ json: { ok: true } })
  })
  await page.goto('/test/browser/ranch.html?page=strategy')
  await page.getByLabel('巡查间隔（分钟）').fill('9')
  await page.getByRole('button', { name: '保存策略' }).click()
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0].id).toBe('1')
  expect(writes[0].automation.ranch_check_minutes).toBe(9)
  expect(Object.keys(writes[0].automation).every(key => key.startsWith('ranch_'))).toBe(true)
  expect(Object.keys(writes[0]).sort()).toEqual(['automation', 'id'])
  await page.getByTestId('switch').click()
  await page.getByRole('button', { name: '保存策略' }).click()
  await expect.poll(() => writes.length).toBe(2)
  expect(writes[1].id).toBe('2')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expect(page.locator('[data-floating-dock]')).toBeInViewport()
  await expect.poll(() => page.locator('[data-floating-dock] button').evaluateAll(buttons => buttons.every((button) => {
    const rect = button.getBoundingClientRect()
    return rect.left >= 0 && rect.right <= innerWidth && rect.width >= 44
  }))).toBe(true)
  await page.screenshot({ path: test.info().outputPath('ranch-strategy.png') })
})

test('ranch shop cannot buy with unknown or insufficient balances', async ({ page }) => {
  await page.route('**/api/ranch?**', route => route.fulfill({ json: { ok: true, data: {
    unlocked: true,
    level: 1,
    facilities: [],
    currencies: [],
    pendingOperations: [],
    shop: { goods: [
      { id: '1', available: true, maxCount: 99, reward: { id: 1, name: '测试幼崽', count: '1', image: '' }, price: { id: 1007, name: '金券', count: '10', balance: '0' } },
      { id: '2', available: true, maxCount: 99, reward: { id: 2, name: '未知余额幼崽', count: '1', image: '' }, price: { id: 1008, name: '松果', count: '10', balance: null } },
    ] },
  } } }))
  await page.goto('/test/browser/ranch.html?page=mall')
  await expect(page.getByText('测试幼崽', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '购买', exact: true })).toHaveCount(2)
  for (const button of await page.getByRole('button', { name: '购买', exact: true }).all()) await expect(button).toBeDisabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('refresh during a ranch quote releases the buttons and discards the stale confirmation', async ({ page }) => {
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let quotes = 0
  let reads = 0
  await page.route('**/api/ranch?**', async (route) => {
    reads++
    await route.fulfill({ json: { ok: true, data: {
      unlocked: true,
      level: 1,
      pendingOperations: [],
      currencies: [],
      facilities: [{ id: '10', name: '窝', ranch: { capacity: 2, animals: [], hazards: [{ id: '1' }], shelves: [] } }],
    } } })
  })
  await page.route('**/api/ranch/clean/quote', async (route) => {
    quotes++
    if (quotes === 1)
      await held
    await route.fulfill({ json: { ok: true, data: {
      action: 'clean',
      label: '清理牧场',
      costs: [],
      costItems: [],
      rewards: [],
      count: 1,
      expected: { signature: 'clean' },
      skipped: false,
    } } })
  })
  await page.goto('/test/browser/ranch.html')
  const clean = page.getByRole('button', { name: '一键清理', exact: true })
  await expect(clean).toBeEnabled()
  await clean.click()
  await expect.poll(() => quotes).toBe(1)
  await page.getByRole('button', { name: '刷新牧场', exact: true }).click()
  release()
  await expect.poll(() => reads).toBe(2)
  await expect(clean).toBeEnabled()
  await expect(page.getByRole('button', { name: '确认', exact: true })).toHaveCount(0)
  await clean.click()
  await expect(page.getByRole('button', { name: '确认', exact: true })).toBeVisible()
})

test('muge survey restart clears saved answers before continuing', async ({ page }) => {
  const writes: any[] = []
  const state: any = { title: '牧歌初启', active: true, startTime: Date.now() - 1000, endTime: Date.now() + 86400000, serverTime: Date.now(), rules: [], celebration: { total: 0, tiers: [] }, friends: { count: 0, tiers: [] }, handbook: { points: 0, tasks: [], tiers: [] }, personality: { answers: { 1: 2 }, personalityId: 1, settleCount: 1, image: '', shareRewardClaimed: true }, questions: [{ id: 1, title: '测试问题', options: [{ value: 1, label: 'A', text: '测试选项' }] }] }
  await page.route('**/api/activities/muge', route => route.fulfill({ json: { ok: true, data: state } }))
  await page.route('**/api/activities/muge/saveAnswers', async (route) => {
    const input = route.request().postDataJSON()
    writes.push(input)
    if (input.clear)
      state.personality.answers = {}
    else Object.assign(state.personality.answers, input.answers)
    await route.fulfill({ json: { ok: true, data: { activity: state, rewards: [] } } })
  })
  await page.goto('/test/browser/ranch.html?muge')
  await page.getByRole('tab', { name: '牧场人格' }).click()
  await page.getByRole('button', { name: '重新测试' }).click()
  await expect(page.getByText('测试问题', { exact: true })).toBeVisible()
  expect(writes[0]).toEqual({ answers: {}, clear: true })
  await page.getByRole('radio', { name: /测试选项/ }).click()
  await expect.poll(() => writes.length).toBe(2)
  expect(writes[1]).toEqual({ answers: { 1: 1 } })
})

test('bag cub priorities can be reordered and saved for the current account only', async ({ page }) => {
  const writes: any[] = []
  await page.route('**/api/settings', route => route.fulfill({ json: { ok: true, data: {
    automation: { ranch_strategy: 'bag_priority', ranch_bag_fallback: 'level', ranch_coop_cub_priority: [7101, 7102], ranch_shed_cub_priority: [], ranch_check_minutes: 5, ranch_grass_threshold_percent: 20, ranch_market_organic_poop: true, ranch_market_organic_pinecone: true },
  } } }))
  await page.route('**/api/ranch/automation-options', route => route.fulfill({ json: { ok: true, data: [] } }))
  await page.route('**/api/ranch?**', route => route.fulfill({ json: { ok: true, data: { unlocked: true, bag: [
    { uid: '1', id: 7101, count: '2', name: '测试鸡崽', animalId: 1, husbandryType: '窝', locked: false, image: '' },
    { uid: '2', id: 7102, count: '3', name: '测试鸭崽', animalId: 2, husbandryType: '窝', locked: false, image: '' },
    { uid: '3', id: 7103, count: '9', name: '已锁幼崽', animalId: 3, husbandryType: '窝', locked: true, image: '' },
  ] } } }))
  await page.route('**/api/settings/save', async (route) => {
    writes.push({ id: route.request().headers()['x-account-id'], ...route.request().postDataJSON() })
    await route.fulfill({ json: { ok: true } })
  })
  await page.goto('/test/browser/ranch.html?page=strategy&connected')
  const list = page.getByRole('list', { name: '窝的幼崽优先顺序' })
  await expect(list.getByRole('listitem').first()).toContainText('测试鸡崽')
  await page.getByRole('button', { name: '上移测试鸭崽' }).click()
  await expect(list.getByRole('listitem').first()).toContainText('测试鸭崽')
  await expect(page.getByText('已锁幼崽', { exact: true })).toHaveCount(0)
  await page.getByText('粑粑兑换有机化肥', { exact: true }).click()
  await expect(page.getByRole('checkbox', { name: '粑粑兑换有机化肥', exact: true })).not.toBeChecked()
  await expect(page.getByRole('checkbox', { name: '松果兑换有机化肥', exact: true })).toBeChecked()
  await page.getByRole('button', { name: '保存策略' }).click()
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0].automation.ranch_coop_cub_priority).toEqual([7102, 7101])
  expect(writes[0].automation.ranch_market_organic_poop).toBe(false)
  expect(writes[0].automation.ranch_market_organic_pinecone).toBe(true)
  expect(writes[0].id).toBe('1')
  expect(Object.keys(writes[0].automation).every(key => key.startsWith('ranch_'))).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByTestId('switch').click()
  await expect(page.getByText('测试鸭崽', { exact: true })).toHaveCount(0)
})

test('Muge shows the selected account background scheduler status and clears it when switching', async ({ page }) => {
  await page.route('**/api/activities/muge', route => route.fulfill({ json: { ok: true, data: {
    title: '牧歌初启',
    active: true,
    startTime: Date.now() - 1000,
    endTime: Date.now() + 86400000,
    serverTime: Date.now(),
    rules: [],
    celebration: null,
    friends: null,
    handbook: null,
    personality: null,
    questions: [],
  } } }))
  await page.goto('/test/browser/ranch.html?muge&connected')
  const scheduler = page.getByRole('status').filter({ hasText: '自动领奖' })
  await expect(scheduler).toContainText('自动领奖 · 暂无奖励')
  await expect(scheduler).toContainText('下次')
  await page.getByTestId('switch').click()
  await expect(scheduler).toContainText('等待账号连接')
  await expect(page.getByText('暂无奖励', { exact: false })).toHaveCount(0)
})
