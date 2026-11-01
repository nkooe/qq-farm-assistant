import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort())
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: {} } }))
  await page.goto('/test/browser/milk-tea.html')
})

test('automatic management shows a concise status with no switches or settings writes', async ({ page }, testInfo) => {
  const calls: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/automation'))
      calls.push(request.url())
  })
  const panel = page.getByRole('region', { name: '奶茶自动经营' })
  await expect(panel.getByText('全自动经营')).toBeVisible()
  await expect(page.getByRole('status')).toContainText('已领取营业收益')
  await expect(panel.getByRole('checkbox')).toHaveCount(0)
  await expect(panel.getByRole('switch')).toHaveCount(0)
  await expect(panel.getByText(/上次/)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('milk-tea-full-auto.png') })
  expect(calls).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('switching accounts displays only the selected account automation status', async ({ page }) => {
  await expect(page.getByRole('status')).toContainText('已领取营业收益')
  await page.getByTestId('switch').click()
  await expect(page.getByRole('status')).toHaveText('等待账号连接')
  await expect(page.getByRole('checkbox')).toHaveCount(0)
  await page.getByTestId('switch').click()
  await expect(page.getByRole('status')).toContainText('已领取营业收益')
})
