import type { Route } from '@playwright/test'
import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort())
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: {} } }))
  await page.goto('/test/browser/milk-tea.html')
})
test('automatic collection describes its scope and persists the selected account switch', async ({ page }, testInfo) => {
  const calls: any[] = []
  await page.route('**/api/automation', async (route) => {
    calls.push({ account: route.request().headers()['x-account-id'], body: route.request().postDataJSON() })
    await route.fulfill({ json: { ok: true, data: { automation: { milk_tea: false } } } })
  })
  await expect(page.getByRole('checkbox', { name: /自动领取/ })).toBeChecked()
  await expect(page.getByRole('status')).toContainText('已领取营业收益')
  await expect(page.getByText(/每5分钟/)).toContainText('关闭页面后继续运行')
  await page.screenshot({ path: testInfo.outputPath('milk-tea-automation.png') })
  await page.getByRole('checkbox').uncheck()
  await expect(page.getByRole('checkbox')).not.toBeChecked()
  expect(calls).toEqual([{ account: '1', body: { milk_tea: false } }])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
test('failed save rolls back and a response from a previous account cannot overwrite the current switch', async ({ page }) => {
  await page.route('**/api/automation', route => route.fulfill({ status: 500, json: { ok: false } }))
  // The immediate failure can restore the value before uncheck verifies it.
  await page.getByRole('checkbox').click()
  await expect(page.getByRole('checkbox')).toBeChecked()
  await expect(page.getByRole('status')).toContainText('保存失败')
  let pending: Route | undefined
  await page.route('**/api/automation', (route) => {
    pending = route
  })
  await page.getByRole('checkbox').uncheck()
  await expect(page.getByRole('checkbox')).toBeDisabled()
  await page.getByTestId('switch').click()
  await expect(page.getByRole('checkbox')).toBeChecked()
  await expect(page.getByRole('checkbox')).toBeEnabled()
  await pending!.fulfill({ json: { ok: true, data: { automation: { milk_tea: false } } } })
  await expect(page.getByRole('checkbox')).toBeChecked()
  await expect(page.getByRole('status')).not.toContainText('保存失败')
})
