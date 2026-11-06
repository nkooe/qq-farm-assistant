import { expect, test } from '@playwright/test'

import { state } from './milk-tea-fixtures'

test.beforeEach(async ({ page }) => {
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort())
  await page.route('**/game-config/**', route => route.fulfill({ path: '../core/src/modern/gameConfig/seed_images_named/seed_images/700001.png' }))
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
      const content = document.querySelector('.tea-shop')!
      return { nestedScroll: scroll.scrollHeight > scroll.clientHeight + 1, overflow: content.scrollWidth > content.clientWidth + 1, columns: getComputedStyle(content).gridTemplateColumns.split(' ').length }
    })
    expect(layout).toEqual({ nestedScroll: false, overflow: false, columns: viewport.width >= 1366 ? 2 : 1 })
    await page.getByRole('button', { name: '制作奶茶', exact: true }).scrollIntoViewIfNeeded()
    await expect(page.getByRole('button', { name: '制作奶茶', exact: true })).toBeInViewport()
  }
})

test('long detail lists scroll to their last entry and close normally', async ({ page }) => {
  await page.getByRole('button', { name: '店铺升级', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '店铺升级', exact: true }).last()
  await expect(dialog).toBeVisible()
  await dialog.getByText('20 级', { exact: true }).scrollIntoViewIfNeeded()
  await expect(dialog.getByText('20 级', { exact: true })).toBeInViewport()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog).not.toBeVisible()
})
