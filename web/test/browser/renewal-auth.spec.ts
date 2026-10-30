import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

async function setup(page: Page) {
  const requests: Record<string, string>[] = []
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: {} } }))
  await page.route('**/api/public/access-policy', route => route.fulfill({ json: { ok: true, data: { cardVerificationEnabled: true } } }))
  await page.route('**/api/card/info/**', route => route.fulfill({ json: { ok: true, data: { type: 'time', days: 7, durationValue: 7, durationUnit: 'day', description: 'fixture' } } }))
  await page.route('**/api/public/renew', (route) => {
    requests.push(route.request().postDataJSON())
    return route.fulfill({ json: { ok: true, data: { cardType: 'time', card: { expiresAt: Date.now() + 86400000 } } } })
  })
  await page.route('**/socket.io/**', route => route.abort())
  return requests
}

test('login renewal verifies a password and clears it after closing or completing the modal', async ({ page }) => {
  const requests = await setup(page)
  await page.goto('/login')
  await page.getByRole('button', { name: '账号续费', exact: true }).click()
  await page.getByLabel('用户名', { exact: true }).fill('fixture_alice')
  await page.getByLabel('续费卡密', { exact: true }).fill('fixture-renewal-card')
  await page.getByRole('button', { name: '确认续费', exact: true }).click()
  await expect(page.getByText('请输入账号密码', { exact: true })).toBeVisible()
  expect(requests).toHaveLength(0)
  await page.getByLabel('账号密码', { exact: true }).fill('Fixture-Password-123')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: '账号续费', exact: true }).click()
  await expect(page.getByLabel('账号密码', { exact: true })).toBeEmpty()
  await page.getByLabel('用户名', { exact: true }).fill('fixture_alice')
  await page.getByLabel('账号密码', { exact: true }).fill('Fixture-Password-123')
  await page.getByLabel('续费卡密', { exact: true }).fill('fixture-renewal-card')
  await page.getByRole('button', { name: '确认续费', exact: true }).click()
  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]).toEqual({ username: 'fixture_alice', password: 'Fixture-Password-123', cardCode: 'fixture-renewal-card' })
  await expect(page.getByLabel('账号密码', { exact: true })).toBeEmpty()
})

test('standalone public renewal requires all three fields and submits the account password', async ({ page }) => {
  const requests = await setup(page)
  await page.goto('/renewal?username=fixture_alice')
  await page.getByLabel('卡密', { exact: true }).fill('fixture-renewal-card')
  const submit = page.getByRole('button', { name: '立即续费', exact: true })
  await expect(submit).toBeDisabled()
  await page.getByLabel('账号密码', { exact: true }).fill('Fixture-Password-123')
  await expect(submit).toBeEnabled()
  await submit.click()
  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]).toEqual({ username: 'fixture_alice', password: 'Fixture-Password-123', cardCode: 'fixture-renewal-card' })
  await expect(page.getByLabel('账号密码', { exact: true })).toBeEmpty()
})
