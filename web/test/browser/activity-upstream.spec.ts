import { expect, test } from '@playwright/test'
import { state as baseline } from './milk-tea-fixtures'

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error })
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort())
  await page.route('**/game-config/**', route => route.fulfill({ path: '../core/src/modern/gameConfig/seed_images_named/seed_images/700001.png' }))
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: {} } }))
})

test('milk tea hiring handles zero employees and settings remain automatic', async ({ page }) => {
  const state = { ...structuredClone(baseline), hire: { friends: [], robots: [], wage_total: 10 }, durations: [] }
  await page.route('**/api/activities/milk-tea?**', route => route.fulfill({ json: { ok: true, data: state } }))
  await page.goto('/test/browser/milk-tea.html?full')
  await page.getByRole('button', { name: '雇佣好友', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '好友雇佣', exact: true }).last()
  await expect(dialog.getByText('还没有雇佣员工')).toBeVisible()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '更多店铺功能' }).click()
  await page.getByText('店铺设置', { exact: true }).click()
  await expect(page.getByRole('switch')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '保存设置' })).toHaveCount(0)
})

test('milk tea exchange quantity respects the wallet and craft costs use fruit stacks', async ({ page }) => {
  const state: any = structuredClone(baseline)
  state.goods = [{ id: '301', name: '测试礼包', available: true, remaining: 10, purchaseLimit: 10, limitPeriod: 'daily', conditions: [], costs: [{ id: 1041, count: 5000, name: '奶茶券', image: '' }], rewards: [{ id: 1, count: 1, name: '礼包', image: '' }] }]
  state.fruits = [{ id: 40525, uid: '9', count: 12, name: '草莓', image: '', locked: false, mutations: [] }]
  state.recipes[1].fruitId = 40525
  await page.route('**/api/activities/milk-tea?**', route => route.fulfill({ json: { ok: true, data: state } }))
  await page.goto('/test/browser/milk-tea.html?full')
  await page.getByText('兑换商店', { exact: true }).click()
  await page.locator('.tea-goods-card__buy').click()
  const exchange = page.getByRole('dialog', { name: '测试礼包', exact: true }).last()
  await exchange.getByRole('button', { name: '最大', exact: true }).click()
  await expect(exchange.getByRole('textbox', { name: '数量', exact: true })).toHaveValue('2')
  await exchange.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByText('我的店铺', { exact: true }).click()
  await page.getByRole('button', { name: '制作奶茶', exact: true }).click()
  await page.getByRole('button', { name: '全部制作', exact: true }).click()
  const craft = page.getByRole('dialog', { name: '确认制作', exact: true }).last()
  await expect(craft.getByRole('button', { name: '确认', exact: true })).toBeEnabled()
  await expect(craft).toContainText('草莓')
})

test('late milk tea responses and dialogs cannot cross accounts', async ({ page }) => {
  let release = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/activities/milk-tea?**', async (route) => {
    const id = route.request().headers()['x-account-id']
    if (id === '1') await held
    const state = { ...structuredClone(baseline), summary: { ...baseline.summary, shop_name: id === '1' ? '旧店铺' : '新店铺' } }
    await route.fulfill({ json: { ok: true, data: state } })
  })
  await page.goto('/test/browser/milk-tea.html?full')
  await page.getByTestId('switch').click()
  await expect(page.getByRole('heading', { name: '新店铺' })).toBeVisible()
  release()
  await expect(page.getByRole('heading', { name: '旧店铺' })).toHaveCount(0)
  await page.getByRole('button', { name: '店铺升级', exact: true }).click()
  await expect(page.getByRole('dialog').last()).toBeVisible()
  await page.getByTestId('switch').evaluate(el => (el as HTMLButtonElement).click())
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('share reward descriptions render as text and clear on account change', async ({ page }) => {
  const description = '<img src=x onerror=alert(1)> 奖励用途'
  await page.route('**/api/activities/share-reward/2026110104', route => route.fulfill({ json: { ok: true, data: {
    id: '2026110104', title: '快乐不独享', active: true, startTime: Date.now() - 86400000, endTime: Date.now() + 86400000,
    serverTime: Date.now(), score: 10, claimedCount: 0, claimLimit: 5, canShare: false, canClaimDaily: false, canClaimMilestones: false,
    milestones: [{ id: '1', threshold: 10, state: 3, rewards: [{ id: 101616, name: '奶茶券礼包', count: 1, image: '', description }] }],
  } } }))
  await page.goto('/test/browser/catalogs.html?page=share')
  await page.getByRole('button', { name: '查看奶茶券礼包说明' }).click()
  await expect(page.getByText(description, { exact: true })).toBeVisible()
  await expect(page.locator('.reward-description img')).toHaveCount(0)
  await page.getByTestId('switch').click()
  await expect(page.getByText(description, { exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: test.info().outputPath('share-reward.png'), fullPage: true })
})
