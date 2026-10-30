import type { Route } from '@playwright/test'
import { expect, test } from '@playwright/test'

test('theme synchronization waits for session validation and only sends authenticated requests', async ({ page }) => {
  const settingsTokens: Array<string | undefined> = []
  const errors: string[] = []
  let validation: Route | undefined
  page.on('pageerror', error => errors.push(error.message))
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort())
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: {} } }))
  await page.route('**/api/accounts', route => route.fulfill({ json: { ok: true, data: { accounts: [] } } }))
  await page.route('**/api/user/me', route => route.fulfill({ json: { ok: true, data: { id: 1000, username: 'fixture', role: 'admin', card: null, accountLimit: -1 } } }))
  await page.route('**/api/settings', async (route) => {
    settingsTokens.push(route.request().headers()['x-admin-token'])
    await route.fulfill({ json: { ok: true, data: { ui: { theme: 'dark' } } } })
  })
  await page.addInitScript(() => localStorage.setItem('admin_token', 'fixture-session'))
  await page.route('**/api/auth/validate', (route) => { validation = route })
  await page.goto('/')
  await expect.poll(() => !!validation).toBe(true)
  expect(settingsTokens).toEqual([])
  await validation!.fulfill({ json: { ok: true } })
  await expect(page.locator('html')).toHaveClass(/dark/)
  expect(settingsTokens.length).toBeGreaterThan(0)
  expect(settingsTokens.every(token => token === 'fixture-session')).toBe(true)
  expect(errors).toEqual([])
})

test('logged out startup keeps the cached theme without requesting private settings', async ({ page }) => {
  let settingsRequests = 0
  await page.addInitScript(() => localStorage.setItem('ui_theme:public', 'dark'))
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort())
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: {} } }))
  await page.route('**/api/auto-login', route => route.fulfill({ status: 403, json: { ok: false } }))
  await page.route('**/api/settings', (route) => {
    settingsRequests++
    return route.fulfill({ status: 401, json: { ok: false } })
  })
  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.locator('html')).toHaveClass(/dark/)
  expect(settingsRequests).toBe(0)
})

test('account selection and account actions use separate buttons', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('admin_token', 'fixture-session'))
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort())
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: {} } }))
  await page.route('**/api/user/me', route => route.fulfill({ json: { ok: true, data: { id: 1000, username: 'fixture', role: 'admin', card: null, accountLimit: -1 } } }))
  await page.route('**/api/accounts', route => route.fulfill({ json: { ok: true, data: { accounts: [{ id: 'fixture', name: '测试账号', connected: false, running: false }] } } }))
  await page.goto('/activity')
  await page.getByRole('button', { name: '账号', exact: true }).click()
  const popup = page.getByRole('dialog', { name: '切换账号', exact: true })
  await expect(popup).toBeVisible()
  await expect(popup.getByRole('button', { name: '测试账号' })).toBeVisible()
  await expect(popup.locator('button button')).toHaveCount(0)
  await popup.getByRole('button', { name: '测试账号' }).focus()
  await page.keyboard.press('Enter')
  await expect(popup).not.toBeVisible()
})

test('navigating away from a scrolled page opens the next page at the top', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('admin_token', 'fixture-session'))
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort())
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: {} } }))
  await page.route('**/api/accounts', route => route.fulfill({ json: { ok: true, data: { accounts: [] } } }))
  await page.route('**/api/user/me', route => route.fulfill({ json: { ok: true, data: { id: 1000, username: 'fixture', role: 'admin', card: null, accountLimit: -1 } } }))
  await page.goto('/activity')
  const scroll = page.locator('[data-page-scroll]')
  await expect(scroll).toBeVisible()
  await scroll.evaluate((el) => {
    const content = el.firstElementChild as HTMLElement
    content.style.minHeight = '2000px'
    el.scrollTop = 600
  })
  await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(300)
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '设置', exact: true }).click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBe(0)
})
