import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

async function setup(page: Page, role: 'user' | 'admin' = 'user') {
  await page.addInitScript((role) => {
    localStorage.setItem('admin_token', 'fixture-token')
    localStorage.setItem('user_info', JSON.stringify({ id: role === 'admin' ? 1000 : 1001, username: role === 'admin' ? 'admin' : 'alice', role, card: null, accountLimit: 2 }))
    localStorage.setItem('current_account_id', 'previous-user-account')
    localStorage.setItem('current_account_owner', '1009')
  }, role)
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: {} } }))
  await page.route('**/socket.io/**', route => route.abort())
  await page.route('**/api/accounts', route => route.fulfill({ json: { ok: true, data: { accounts: [] } } }))
  await page.route('**/api/yyb/accounts', route => route.fulfill({ json: { ok: true, data: [] } }))
}

test('first entry clears a previous user account before any account request and renders an empty dashboard', async ({ page }) => {
  await setup(page)
  const errors: string[] = []
  const accountHeaders: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('request', req => {
    if (req.url().includes('/api/'))
      accountHeaders.push(req.headers()['x-account-id'] || '')
  })
  let release!: () => void
  const pending = new Promise<void>(resolve => release = resolve)
  await page.route('**/api/accounts', async (route) => {
    await pending
    await route.fulfill({ json: { ok: true, data: { accounts: [] } } })
  })
  await page.goto('/test/browser/isolation.html')
  await expect(page.getByTestId('selected-account')).toBeEmpty()
  await expect(page.getByTestId('loading')).toHaveText('true')
  expect(accountHeaders.every(id => id === '')).toBe(true)
  release()
  await expect(page.getByTestId('loading')).toHaveText('false')
  await expect(page.getByTestId('account-names')).toBeEmpty()
  expect(accountHeaders.every(id => id === '')).toBe(true)
  expect(errors).toEqual([])
})

test('switching users clears cached accounts and ignores a late response for the previous user', async ({ page }) => {
  await setup(page)
  let release!: () => void
  const pending = new Promise<void>(resolve => release = resolve)
  let count = 0
  await page.route('**/api/accounts', async (route) => {
    if (++count === 1) {
      await pending
      await route.fulfill({ json: { ok: true, data: { accounts: [{ id: 'a', name: 'Alice private farm' }] } } })
      return
    }
    await route.fulfill({ json: { ok: true, data: { accounts: [{ id: 'b', name: 'Bob farm' }] } } })
  })
  await page.goto('/test/browser/isolation.html')
  await expect(page.getByTestId('loading')).toHaveText('true')
  await page.getByTestId('switch-user').click()
  release()
  await page.getByTestId('load-accounts').click()
  await expect(page.getByTestId('account-names')).toHaveText('Bob farm')
  await expect(page.getByTestId('selected-account')).toHaveText('b')
  await expect(page.getByText('Alice private farm', { exact: true })).toHaveCount(0)
})

test('switching users synchronously clears settings and log caches', async ({ page }) => {
  await setup(page)
  await page.goto('/test/browser/isolation.html')
  await page.getByTestId('seed-private-state').click()
  await expect(page.getByTestId('private-state')).toContainText('Alice cached private password')
  await page.getByTestId('switch-user').click()
  await expect(page.getByTestId('private-state')).toBeEmpty()
})

test('theme and persisted friend targets use the numeric user ID even for the same account key', async ({ page }) => {
  await setup(page)
  await page.addInitScript(() => {
    localStorage.setItem('qqfarm:addfriends:1001:same-account', JSON.stringify([{ gid: 11111111, key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', openid: 'alice-only', selected: true }]))
    localStorage.setItem('qqfarm:addfriends:1002:same-account', JSON.stringify([{ gid: 22222222, key: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', openid: 'bob-only', selected: true }]))
    localStorage.setItem('ui_theme:1002', 'light')
  })
  await page.goto('/test/browser/isolation.html?friends')
  await expect(page.getByText('11111111', { exact: true })).toBeVisible()
  await page.getByTestId('set-dark-theme').click()
  await expect(page.getByTestId('current-theme')).toHaveText('dark')
  await page.getByTestId('switch-user').click()
  await expect(page.getByTestId('current-theme')).toHaveText('light')
  await expect(page.getByText('11111111', { exact: true })).toHaveCount(0)
  await expect(page.getByText('22222222', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => [localStorage.getItem('ui_theme:1001'), localStorage.getItem('ui_theme:1002')])).toEqual(['dark', 'light'])
})

test('switching users during a friend batch stops remaining requests and clears imported targets', async ({ page }) => {
  await setup(page)
  await page.addInitScript(() => {
    localStorage.setItem('qqfarm:addfriends:1001:same-account', JSON.stringify([11111111, 22222222].map(gid => ({ gid, key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', openid: 'alice-only', selected: true }))))
  })
  let release!: () => void
  const pending = new Promise<void>(resolve => release = resolve)
  const sent: string[] = []
  await page.route('**/api/friend/apply', async (route) => {
    sent.push(route.request().headers()['x-admin-token'] || '')
    await pending
    await route.fulfill({ json: { ok: true, data: {} } })
  })
  await page.goto('/test/browser/isolation.html?friends')
  await page.getByRole('button', { name: '发送选中 (2)', exact: true }).click()
  await expect.poll(() => sent.length).toBe(1)
  await page.getByTestId('switch-user').click()
  release()
  await expect(page.getByRole('button', { name: '发送选中 (0)', exact: true })).toBeVisible()
  expect(sent).toEqual(['fixture-token'])
  await expect(page.getByText('11111111', { exact: true })).toHaveCount(0)
  await expect(page.getByText('22222222', { exact: true })).toHaveCount(0)
})

test('switching farm accounts clears the previous account settings and log caches', async ({ page }) => {
  await setup(page)
  await page.goto('/test/browser/isolation.html')
  await expect(page.getByTestId('loading')).toHaveText('false')
  await page.getByTestId('seed-private-state').click()
  await expect(page.getByTestId('private-state')).toContainText('Alice cached private password')
  await page.getByTestId('select-other-account').click()
  await expect(page.getByTestId('selected-account')).toHaveText('other-account')
  await expect(page.getByTestId('private-state')).toBeEmpty()
})

for (const status of [200, 401]) {
  test(`a delayed ${status} response from the previous user cannot populate logs or log out the new user`, async ({ page }) => {
    await setup(page)
    let release!: () => void
    const pending = new Promise<void>(resolve => release = resolve)
    let received!: () => void
    const receivedRequest = new Promise<void>(resolve => received = resolve)
    await page.route('**/api/account-logs?*', async (route) => {
      received()
      await pending
      await route.fulfill({ status, json: status === 200 ? [{ msg: 'Alice late private log' }] : { ok: false } })
    })
    await page.goto('/test/browser/isolation.html')
    await page.getByTestId('load-logs').click()
    await receivedRequest
    await expect(page.getByTestId('logs-loading')).toHaveText('true')
    await page.getByTestId('switch-user').click()
    const finished = page.waitForResponse(response => response.url().includes('/api/account-logs?'))
    release()
    await finished
    await expect(page.getByTestId('logs-loading')).toHaveText('false')
    await expect(page.getByTestId('account-log-names')).toBeEmpty()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('admin_token'))).toBe('fixture-bob-token')
    await expect(page).toHaveURL(/isolation\.html$/)
  })
}

for (const token of ['', 'expired-token']) {
  test(`the production router requires login for ${token ? 'expired' : 'missing'} credentials`, async ({ page }) => {
    await page.addInitScript((token) => {
      localStorage.clear()
      if (token) localStorage.setItem('admin_token', token)
    }, token)
    const requests: string[] = []
    page.on('request', request => requests.push(new URL(request.url()).pathname))
    await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: {} } }))
    await page.route('**/api/auth/validate', route => route.fulfill({ status: 401, json: { ok: false } }))
    await page.goto('/')
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByRole('button', { name: /^登\s*录$/ })).toBeVisible()
    expect(requests).not.toContain('/api/auto-login')
    expect(await page.evaluate(() => localStorage.getItem('admin_token'))).toBeFalsy()
  })
}

test('shared proxy only renders its name and ordinary users edit only their own proxy', async ({ page }) => {
  await setup(page)
  await page.route('**/api/yyb/proxy-profiles', route => route.fulfill({ json: { ok: true, data: [
    { id: 1, name: '管理员共享出口', redacted: true, host: 'SHARED-SECRET-HOST', port: 1080, username: 'SHARED-SECRET-LOGIN' },
    { id: 2, name: '我的出口', host: 'my.proxy.test', port: 8080, protocol: 'http-connect', username: 'my-login', password_configured: true },
  ] } }))
  await page.goto('/test/browser/isolation.html?proxy')
  const shared = page.locator('article').filter({ hasText: '管理员共享出口' })
  await expect(shared).toBeVisible()
  await expect(shared).not.toContainText('SHARED-SECRET')
  await expect(shared.getByRole('button', { name: '编辑', exact: true })).toHaveCount(0)
  await expect(shared.getByRole('button', { name: '删除', exact: true })).toHaveCount(0)
  const own = page.locator('article').filter({ hasText: '我的出口' })
  await expect(own).toContainText('my.proxy.test:8080')
  await own.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(page.getByText('允许用户使用（用户仅可见代理名称）', { exact: true })).toHaveCount(0)
  await expect(page.getByLabel('主机/IP')).toHaveValue('my.proxy.test')
})

test('administrator can explicitly enable sharing and the saved request contains the selected setting', async ({ page }) => {
  await setup(page, 'admin')
  let saved: any
  await page.route('**/api/yyb/proxy-profiles', async (route) => {
    if (route.request().method() === 'POST') {
      saved = route.request().postDataJSON()
      await route.fulfill({ status: 201, json: { ok: true, data: { id: 1, ...saved } } })
    }
    else await route.fulfill({ json: { ok: true, data: [] } })
  })
  await page.goto('/test/browser/isolation.html?proxy')
  await page.getByRole('button', { name: '添加静态代理' }).click()
  await page.getByLabel('配置名称').fill('管理员出口')
  await page.getByLabel('主机/IP').fill('proxy.fixture.test')
  await page.getByLabel('端口', { exact: true }).fill('1080')
  const share = page.getByLabel('允许用户使用（用户仅可见代理名称）')
  await expect(share).not.toBeChecked()
  await share.check()
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect(page.getByText('代理配置已保存', { exact: true })).toBeVisible()
  expect(saved.shared_with_users).toBe(true)
  expect(saved.name).toBe('管理员出口')
})
