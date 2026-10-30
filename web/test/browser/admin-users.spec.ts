import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

test.use({ timezoneId: 'Asia/Shanghai' })

function fixtureUsers() {
  const card = { code: 'fixture', description: '', days: 7, enabled: true, expiresAt: Date.UTC(2026, 10, 5) }
  return [
    { id: 1000, username: 'admin', role: 'admin', accountLimit: 2, createdAt: Date.UTC(2026, 9, 1), card: null, accessStatus: 'normal' },
    { id: 1001, username: 'coco', role: 'user', accountLimit: 2, createdAt: Date.UTC(2026, 9, 2), card: null, accessStatus: 'normal' },
    { id: 1002, username: 'permanent_user', role: 'user', accountLimit: 12, createdAt: Date.UTC(2026, 9, 3), card: { ...card, isPermanent: true, days: -1, expiresAt: null }, accessStatus: 'normal' },
    { id: 1003, username: 'expired_user', role: 'user', accountLimit: 3, createdAt: Date.UTC(2026, 9, 4), card: { ...card, expiresAt: Date.UTC(2026, 9, 25) }, accessStatus: 'expired' },
    { id: 1004, username: 'banned_user', role: 'user', accountLimit: 2, createdAt: Date.UTC(2026, 9, 5), card: { ...card, enabled: false }, accessStatus: 'banned' },
    { id: 1005, username: 'pending_user', role: 'user', accountLimit: 2, createdAt: Date.UTC(2026, 9, 6), card: null, accessStatus: 'card_required' },
    { id: 1006, username: 'long_username_with_32_characters_1', role: 'user', accountLimit: 2, createdAt: Date.UTC(2026, 9, 7), card, accessStatus: 'deleting' },
  ]
}

async function setup(page: Page) {
  let users = fixtureUsers()
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: {} } }))
  await page.route('**/api/admin/users', route => route.fulfill({ json: { ok: true, data: users } }))
  await page.route('**/api/admin/cards', route => route.fulfill({ json: { ok: true, data: [] } }))
  await page.route('**/api/admin/login-logs?*', route => route.fulfill({ json: { ok: true, data: { logs: [], total: 0 } } }))
  await page.route('**/api/admin/announcement', route => route.fulfill({ json: { ok: true, data: { enabled: false, title: '系统公告', content: '', showOnce: true, updatedAt: 0 } } }))
  await page.route('**/api/admin/access-policy', route => route.fulfill({ json: { ok: true, data: { cardVerificationEnabled: false } } }))
  await page.route('**/api/admin/login-links', route => route.fulfill({ json: { ok: true, data: { title: 'QQ农场智能助手', logoUrl: '', loginSubtitle: '', registerSubtitle: '', purchaseUrl: '', qqGroupUrl: '' } } }))
  return { get users() { return users }, set users(value) { users = value } }
}
async function open(page: Page) {
  await page.goto('/test/browser/admin-users.html')
  await expect(page.locator('tr[data-user-id]')).toHaveCount(7)
  expect(await page.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches))
}
function row(page: Page, id: number) { return page.locator(`tr[data-user-id="${id}"]`) }
function allCheckbox(page: Page) {
  return page.getByLabel(page.viewportSize()!.width > 1100 ? '全选当前列表普通用户' : '选择当前列表普通用户', { exact: true })
}
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  for (const id of [1000, 1001, 1002, 1003, 1004, 1005, 1006]) {
    expect(await row(page, id).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  }
}

test('user list presents the requested columns, real dates and complete statuses', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await setup(page)
  await open(page)
  expect(await page.locator('thead th').allTextContents()).toEqual(['', 'ID', '用户名', '角色', '额度', '注册时间', '到期时间', '状态', '操作'])
  await expect(page.getByTestId('active-user-count')).toContainText('2')
  await expect(row(page, 1000).locator('td[data-label="ID"]')).toHaveText('1000')
  await expect(row(page, 1001).locator('time').first()).toHaveAttribute('datetime', '2026-10-02T00:00:00.000Z')
  await expect(row(page, 1001).locator('td[data-label="注册时间"]')).toContainText('2026/10/02')
  await expect(row(page, 1001).locator('td[data-label="注册时间"]')).toContainText('08:00:00')
  for (const [id, status] of [[1000, '正常'], [1001, '正常'], [1002, '正常'], [1003, '已到期'], [1004, '已封禁'], [1005, '待激活'], [1006, '清理中']] as const) {
    await expect(row(page, id).locator('.user-status')).toHaveText(status)
  }
  await expect(row(page, 1002).locator('td[data-label="到期时间"]')).toHaveText('永久有效')
  if (await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)) {
    await expect(row(page, 1001).locator('.user-status')).toHaveCSS('color', 'rgb(110, 231, 183)')
    await expect(row(page, 1001).getByRole('button', { name: '删除', exact: true })).toHaveCSS('color', 'rgb(252, 165, 165)')
  }
  await expect(row(page, 1000).getByRole('button', { name: '删除', exact: true })).toHaveCount(0)
  await expect(row(page, 1006).getByRole('button', { name: '重试删除', exact: true })).toBeVisible()
  await fits(page)
  expect(errors).toEqual([])
  await page.screenshot({ path: test.info().outputPath('user-management.png'), fullPage: true })
  if (page.viewportSize()!.width <= 1100) await row(page, 1001).screenshot({ path: test.info().outputPath('mobile-user-card.png') })
})

test('user list fits tablet and desktop widths without clipping data or actions', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')
  await setup(page)
  await open(page)
  for (const width of [768, 1024, 1200, 1920]) {
    await page.setViewportSize({ width, height: 1000 })
    await fits(page)
    await expect(row(page, 1001).getByRole('button', { name: '删除', exact: true })).toBeInViewport()
    await expect(row(page, 1001).locator('td[data-label="注册时间"]')).toBeVisible()
  }
})

test('production admin page connects selection and confirmation to the user panel', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.stack || error.message))
  await setup(page)
  await page.goto('/test/browser/admin-users.html?full')
  await page.getByRole('tab', { name: '用户', exact: true }).click()
  await expect(row(page, 1001)).toBeVisible()
  await row(page, 1001).getByRole('checkbox').check()
  await expect(page.locator('.user-selection-count')).toHaveText('已选 1 人')
  await page.getByRole('button', { name: '删除所选', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '确认批量删除用户', exact: true })
  await expect(dialog.getByRole('listitem')).toHaveText('cocoID 1001')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await fits(page)
  expect(errors).toEqual([])
  await page.screenshot({ path: test.info().outputPath('production-admin-users.png'), fullPage: true })
})

test('system configuration removes the obsolete WeChat page and makes no legacy administrator requests', async ({ page }) => {
  const errors: string[] = []
  const legacyRequests: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/admin/wx-config') legacyRequests.push(request.method())
  })
  await setup(page)
  await page.addInitScript(() => localStorage.setItem('admin-config-section', 'wechat'))
  await page.goto('/test/browser/admin-users.html?full')
  await page.getByRole('tab', { name: '配置', exact: true }).click()
  const tabs = page.getByRole('tablist', { name: '配置子菜单' })
  await expect(tabs.getByRole('tab')).toHaveText(['访问控制', '公告', '登录页', '系统连接'])
  await expect(tabs.getByRole('tab', { name: '访问控制', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('微信配置', { exact: true })).toHaveCount(0)
  await expect(page.getByLabel('自动添加账号', { exact: true })).toHaveCount(0)
  for (const name of ['公告', '登录页', '系统连接']) {
    await tabs.getByRole('tab', { name, exact: true }).click()
    await expect(tabs.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true')
  }
  expect(legacyRequests).toEqual([])
  expect(errors).toEqual([])
  await page.screenshot({ path: test.info().outputPath('system-config-cleanup.png'), fullPage: true })
})

test('selection excludes the administrator, supports indeterminate state and clears on search', async ({ page }) => {
  await setup(page)
  await open(page)
  await expect(row(page, 1000).getByRole('checkbox')).toBeDisabled()
  await row(page, 1001).getByRole('checkbox').check()
  await expect(allCheckbox(page)).toHaveJSProperty('indeterminate', true)
  await allCheckbox(page).check()
  await expect(page.locator('.user-selection-count')).toHaveText('已选 6 人')
  await expect(row(page, 1000).getByRole('checkbox')).not.toBeChecked()
  await page.getByLabel('搜索用户', { exact: true }).fill('1003')
  await expect(page.locator('tr[data-user-id]')).toHaveCount(1)
  await expect(page.locator('.user-selection-count')).toHaveText('已选 0 人')
  await allCheckbox(page).check()
  await page.getByRole('button', { name: '删除所选', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '确认批量删除用户', exact: true })
  await expect(dialog.getByRole('list', { name: '待删除用户' })).toHaveText('expired_userID 1003')
  await expect(dialog).not.toContainText('coco')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).toHaveCount(0)
})

test('bulk deletion confirms a fixed list and retries only failures', async ({ page }) => {
  const fixture = await setup(page)
  const requests: number[] = []
  let failSecond = true
  await page.route('**/api/admin/users/*', async (route) => {
    expect(route.request().method()).toBe('DELETE')
    expect(route.request().postDataJSON()).toEqual({ confirmed: true })
    const id = Number(new URL(route.request().url()).pathname.split('/').pop())
    requests.push(id)
    if (id === 1002 && failSecond) return route.fulfill({ status: 500, json: { ok: false, error: 'fixture storage failure' } })
    fixture.users = fixture.users.filter(user => user.id !== id)
    return route.fulfill({ json: { ok: true } })
  })
  await open(page)
  await row(page, 1001).getByRole('checkbox').check()
  await row(page, 1002).getByRole('checkbox').check()
  await page.getByRole('button', { name: '删除所选', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '确认批量删除用户', exact: true })
  expect(requests).toEqual([])
  await expect(dialog.getByRole('listitem')).toHaveCount(2)
  await dialog.getByRole('button', { name: '确认删除 2 个用户' }).click()
  await expect(dialog.getByRole('alert')).toContainText('1 个用户未删除')
  await expect(dialog.getByRole('listitem')).toHaveCount(1)
  await expect(dialog.getByRole('listitem')).toContainText('permanent_user')
  await expect(row(page, 1001)).toHaveCount(0)
  failSecond = false
  await dialog.getByRole('button', { name: '确认删除 1 个用户' }).click()
  await expect(dialog).toHaveCount(0)
  expect(requests).toEqual([1001, 1002, 1002])
  await expect(row(page, 1000)).toBeVisible()
  await expect(row(page, 1003)).toBeVisible()
  await expect(page.locator('.user-selection-count')).toHaveText('已选 0 人')
})

test('users without a card can be banned and unbanned with the correct boolean', async ({ page }) => {
  const fixture = await setup(page)
  const patches: boolean[] = []
  await page.route('**/api/admin/users/1001', async (route) => {
    const body = route.request().postDataJSON()
    patches.push(body.enabled)
    const user = fixture.users.find(user => user.id === 1001)!
    user.card = { code: '', description: '', days: 0, expiresAt: null, enabled: body.enabled }
    user.accessStatus = body.enabled ? 'normal' : 'banned'
    await route.fulfill({ json: { ok: true, data: user } })
  })
  await open(page)
  await row(page, 1001).getByRole('button', { name: '封禁', exact: true }).click()
  await page.getByRole('dialog', { name: '确认封禁用户' }).getByRole('button', { name: '确认执行' }).click()
  await expect(row(page, 1001).locator('.user-status')).toHaveText('已封禁')
  await row(page, 1001).getByRole('button', { name: '解封', exact: true }).click()
  await page.getByRole('dialog', { name: '确认解封用户' }).getByRole('button', { name: '确认执行' }).click()
  await expect(row(page, 1001).locator('.user-status')).toHaveText('正常')
  expect(patches).toEqual([false, true])
})
