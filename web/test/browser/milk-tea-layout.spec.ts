import { expect, test } from '@playwright/test'

const recipes = Array.from({ length: 9 }, (_, index) => ({
  recipe_id: index + 1,
  recipe_name: ['经典奶茶', '草莓奶茶', '葡萄奶茶', '芒果奶茶', '西瓜奶茶', '蜜桃奶茶', '椰香奶茶', '蓝莓奶茶', '热销特调'][index],
  image: `/activity-assets/milk-tea/recipe-${index + 1}.png`,
  description: '使用农场果实制作的香甜奶茶',
  unlocked: index < 6,
  is_advanced: index > 0,
  token_price: 10 + index,
}))
const state = {
  id: '2026110101',
  active: true,
  settling: false,
  startTime: 1792029600,
  endTime: 1794844799,
  serverTime: 1792530000,
  summary: { shop_open_at: 1792030000, shop_name: '海风奶茶小铺', level: 3, total_revenue: 12580, can_upgrade: false },
  balances: { 1041: 12880, 1042: 12, 1004: 888 },
  automation: { enabled: true, status: 'idle', message: '已领取营业收益', lastRunAt: 1792530000000, nextRunAt: 1792530300000 },
  recipes,
  levels: Array.from({ length: 20 }, (_, index) => ({ level: index + 1, revenue_required: index * 10000, base_popularity: 60 + index * 10, advanced_price_percent: index * 100, employee_slot_count: 2, recipes: ['经典奶茶'], rewards: [] })),
  fruits: [],
  shop: {
    next_level_revenue: 30000,
    effective_cups_per_hour: 160,
    sales_item_id: 1042,
    cashier_elapsed_sec: 5400,
    cashier_capacity_sec: 28800,
    pending_cups_by_recipe: { 1: 60, 2: 45, 3: 20 },
    drink_cups: { 2: 100, 3: 80 },
    pending_rewards: [{ id: 1041, name: '奶茶券', count: 1250, image: '/activity-assets/milk-tea/logo.png' }],
    slots: [],
  },
  goods: [],
  rules: ['【活动规则】', '种植果实、制作奶茶，经营你的专属奶茶店铺。', '领取营业收益并升级店铺，解锁更多配方。'],
}

test.beforeEach(async ({ page }) => {
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort())
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: state } }))
  await page.goto('/test/browser/milk-tea.html?full')
  await expect(page.getByRole('heading', { name: '海风奶茶小铺' })).toBeVisible()
  await expect(page.getByRole('button', { name: '刷新活动数据' })).toBeEnabled()
})

test('full milk tea shop stays reachable in the application scroll area', async ({ page }, testInfo) => {
  await page.screenshot({ path: testInfo.outputPath('milk-tea-shop.png'), fullPage: true })
  await page.getByText('活动说明', { exact: true }).click()
  const lastRule = page.getByText('领取营业收益并升级店铺，解锁更多配方。')
  await lastRule.scrollIntoViewIfNeeded()
  await expect(lastRule).toBeInViewport()
  await page.getByRole('button', { name: '制作奶茶', exact: true }).scrollIntoViewIfNeeded()
  await expect(page.getByRole('button', { name: '制作奶茶', exact: true })).toBeInViewport()
  const widths = await page.evaluate(() => [...document.querySelectorAll('.tea-page, .tea-content, .tea-scroll')].map(el => ({ width: el.clientWidth, scroll: el.scrollWidth })))
  for (const size of widths) expect(size.scroll).toBeLessThanOrEqual(size.width + 1)
  expect(await page.locator('.tea-scroll').evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
  expect(await page.locator('[data-page-scroll]').evaluate(el => el.scrollTop)).toBeGreaterThan(0)
})

test('desktop layouts fit wide and short windows without nested scrolling', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop window sizes')
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 1024, height: 600 }]) {
    await page.setViewportSize(viewport)
    await page.locator('[data-page-scroll]').evaluate(el => el.scrollTop = 0)
    await page.screenshot({ path: testInfo.outputPath(`milk-tea-${viewport.width}.png`) })
    const layout = await page.evaluate(() => {
      const scroll = document.querySelector('.tea-scroll')!
      const content = document.querySelector('.shop-layout')!
      return { nestedScroll: scroll.scrollHeight > scroll.clientHeight + 1, overflow: content.scrollWidth > content.clientWidth + 1, columns: getComputedStyle(content).gridTemplateColumns.split(' ').length }
    })
    expect(layout).toEqual({ nestedScroll: false, overflow: false, columns: 2 })
    await page.getByRole('button', { name: '制作奶茶', exact: true }).scrollIntoViewIfNeeded()
    await expect(page.getByRole('button', { name: '制作奶茶', exact: true })).toBeInViewport()
  }
})

test('long detail lists scroll to their last entry and close normally', async ({ page }) => {
  await page.getByRole('button', { name: '店铺升级', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '店铺升级', exact: true }).last()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('heading', { name: '20级', exact: true }).scrollIntoViewIfNeeded()
  await expect(dialog.getByRole('heading', { name: '20级', exact: true })).toBeInViewport()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog).not.toBeVisible()
})
