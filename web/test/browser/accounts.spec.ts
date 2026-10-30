import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

const initialAccounts = [
  { id: '1', name: '已停止账号甲', runtimeState: 'stopped', running: false },
  { id: '2', name: '已停止账号乙', runtimeState: 'stopped', running: false },
  { id: '3', name: '启动中的账号', runtimeState: 'starting', running: false },
  { id: '4', name: '连接失败的账号', runtimeState: 'failed', running: false },
]

async function mockApi(page: Page, accounts = initialAccounts) {
  // No request from this fixture may reach a real backend or external service.
  await page.addInitScript(() => {
    localStorage.setItem('ui_theme:1000', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  })
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: {} } }))
  await page.route('**/api/accounts', route => route.fulfill({ json: { ok: true, data: { accounts } } }))
}

async function expectFits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

test('shared proxy options show only their name without an empty address', async ({ page }) => {
  await mockApi(page, [])
  await page.route('**/api/yyb/proxy-profiles', route => route.fulfill({ json: { ok: true, data: [
    { id: 7, name: '广东', redacted: true },
    { id: 8, name: '自有代理', host: '192.0.2.8', port: 1080 },
    { id: 9, name: '仅名称代理' },
    { id: 10, name: '脱敏优先', redacted: true, host: '192.0.2.10', port: 1080 },
  ] } }))
  await page.route('**/api/yyb/qr/create', route => route.fulfill({ json: { ok: true, data: { session_id: 'proxy-display', qr_url: '' } } }))
  await page.route('**/api/yyb/qr/poll', route => route.fulfill({ json: { ok: true, data: { status: 'pending' } } }))
  await page.goto('/test/browser/accounts.html')
  await page.getByRole('button', { name: '添加账号', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加账号' })
  await dialog.getByRole('tab', { name: '应用宝扫码' }).click()
  await expect(dialog.locator('option[value="7"]')).toHaveText('广东')
  await expect(dialog.locator('option[value="8"]')).toHaveText('自有代理（192.0.2.8:1080）')
  await expect(dialog.locator('option[value="9"]')).toHaveText('仅名称代理')
  await expect(dialog.locator('option[value="10"]')).toHaveText('脱敏优先')
  await dialog.locator('select').first().selectOption('static')
  await dialog.locator('select').nth(1).selectOption('7')
  await expectFits(page)
  await page.screenshot({ path: test.info().outputPath('shared-proxy-name.png') })
})

for (const [kind, state, label] of [
  ['rescan', 'needs_rescan', '请扫码，重试已暂停'],
  ['configuration', 'blocked', '配置异常，重试已暂停'],
] as const) {
  test(`login recovery explains ${kind} without claiming retries are exhausted`, async ({ page }) => {
    await mockApi(page, [{ id: 'recovery', name: '登录恢复账号', platform: 'qq', runtimeState: 'failed', running: false, runtimeReconnect: { state, kind, attempt: 0, maxAttempts: 3, nextRetryAt: null }, runtimeLogin: { state: 'failed', kind, startedAt: Date.now(), durationMs: 2000 } }] as any)
    await page.route('**/api/accounts/recovery/health', route => route.fulfill({ json: { ok: true, data: { supported: false, runtime: {} } } }))
    await page.goto('/test/browser/accounts.html')
    await expect(page.getByText(label, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /状态检查/ }).click()
    await expect(page.getByText(kind === 'rescan' ? '登录失效，请扫码' : '登录配置异常', { exact: true })).toBeVisible()
    await expect(page.getByText(/重连已达上限/)).toHaveCount(0)
    await expectFits(page)
  })
}

test('busy recovery counts down without spending attempts and follows fresh account state', async ({ page }) => {
  await page.clock.install()
  const account: any = { id: 'queue', name: '排队取码账号', platform: 'qq', runtimeState: 'reconnecting', running: false, runtimeReconnect: { state: 'scheduled', kind: 'busy', attempt: 0, maxAttempts: 3, nextRetryAt: Date.now() + 15000 }, runtimeLogin: { state: 'queued', source: 'qq', startedAt: Date.now(), lastSuccessAt: null } }
  await mockApi(page, [account])
  await page.route('**/api/accounts/queue/health', route => route.fulfill({ json: { ok: true, data: { supported: false, runtime: { login: { state: 'failed', kind: 'rescan' } } } } }))
  await page.goto('/test/browser/accounts.html')
  const countdown = page.getByText(/服务繁忙，\d+ 秒后重试/)
  await expect(countdown).toBeVisible()
  const before = await countdown.textContent()
  await page.clock.runFor(2000)
  expect(await countdown.textContent()).not.toBe(before)
  await page.getByRole('button', { name: /状态检查/ }).click()
  await expect(page.getByText('排队取码中', { exact: true })).toBeVisible()
  account.runtimeLogin = { ...account.runtimeLogin, state: 'success', durationMs: 2100, lastSuccessAt: Date.now() }
  await page.route('**/api/accounts', route => route.fulfill({ json: { ok: true, data: { accounts: [account] } } }))
  await page.getByTestId('force-fetch').click()
  await expect(page.getByText('取码成功，用时 3 秒', { exact: true })).toBeVisible()
  await expect(page.getByText('最近取码：', { exact: false })).toBeVisible()
  await expectFits(page)
  await page.screenshot({ path: test.info().outputPath('login-recovery-state.png') })
})

async function mockOfflineDashboard(page: Page, platform = 'qq') {
  const account = { id: '10', name: '保留原备注', platform, uin: '12345678', running: false, runtimeState: 'stopped', proxyMode: 'static', proxyProfileId: 7 }
  await page.addInitScript(() => localStorage.setItem('current_account_id', '10'))
  await mockApi(page, [account])
  await page.route('**/api/seeds', route => route.fulfill({ json: { ok: true, data: [] } }))
  await page.route('**/api/bag/seeds', route => route.fulfill({ json: { ok: true, data: [] } }))
  await page.route('**/api/status', route => route.fulfill({ json: { ok: true, data: { connection: { connected: false } } } }))
  await page.route('**/api/logs**', route => route.fulfill({ json: { ok: true, data: [] } }))
  await page.route('**/api/account-logs**', route => route.fulfill({ json: { ok: true, data: [] } }))
  await page.route('**/api/yyb/proxy-profiles', route => route.fulfill({ json: { ok: true, data: [{ id: 7, name: '原账号代理' }] } }))
}

test('offline dashboard QQ scan updates its bound account using the original proxy', async ({ page }) => {
  await mockOfflineDashboard(page)
  const choices: any[] = []
  const imported: any[] = []
  const errors: string[] = []
  let polls = 0
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/qq-login/sessions', async (route) => {
    choices.push(route.request().postDataJSON())
    await route.fulfill({ status: 201, json: { ok: true, data: { sessionId: 'update-fixture' } } })
  })
  await page.route('**/api/qq-login/sessions/update-fixture', route => route.fulfill({ json: { ok: true, data: route.request().method() === 'DELETE'
    ? {}
    : ++polls < 2
        ? { status: 'waiting_scan', message: '请使用原账号 QQ 扫码', image: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' }
        : { status: 'success', code: 'fixture_UPDATE_CODE_12345678' } } }))
  await page.route('**/api/qq-login/sessions/update-fixture/import', async (route) => {
    imported.push(route.request().postDataJSON())
    await route.fulfill({ json: { ok: true, data: { accountId: '10', updated: true, code: 'fixture_UPDATE_CODE_12345678' } } })
  })
  await page.goto('/test/browser/accounts.html?dashboard')
  await page.getByRole('button', { name: 'QQ 扫码更新', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'QQ 扫码更新', exact: true })
  await expect(dialog.getByLabel('QQ 连接方式')).toHaveValue('7')
  await expect(dialog.getByAltText('QQ 登录二维码')).toBeVisible()
  await expect(dialog.getByLabel('账号备注（可选）')).toHaveCount(0)
  await expect(dialog.getByRole('status')).toContainText('已更新原账号，正在连接', { timeout: 10000 })
  expect(choices).toEqual([{ proxyMode: 'static', proxyProfileId: 7, targetAccountId: '10' }])
  expect(imported).toEqual([{ name: '', targetAccountId: '10' }])
  await expect(dialog.getByRole('button', { name: '再扫一个账号' })).toHaveCount(0)
  const footer = dialog.getByText('作者：nkooe')
  await footer.scrollIntoViewIfNeeded()
  await expect(footer).toBeInViewport({ ratio: 1 })
  await expectFits(page)
  await page.screenshot({ path: test.info().outputPath('qq-scan-update-success.png') })
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(errors).toEqual([])
})

for (const saved of [true, false]) {
  test(`QQ health explains its own saved login state without WX credentials: ${saved}`, async ({ page }) => {
    await mockApi(page, [{ id: 'qq-health', name: 'QQ 自动取码', platform: 'qq', loginType: 'manual', runtimeState: 'stopped', running: false, qqAutoCodeAvailable: saved }] as any)
    await page.route('**/api/accounts/qq-health/health', route => route.fulfill({ json: { ok: true, data: { supported: false, runtime: { state: 'stopped' } } } }))
    await page.goto('/test/browser/accounts.html')
    await page.getByRole('button', { name: /状态检查/ }).click()
    await expect(page.getByText(saved ? '登录态：已保存' : '登录态：未保存', { exact: true })).toBeVisible()
    await expect(page.getByText('登录失效请重新扫码。', { exact: true })).toHaveCount(0)
    await expect(page.getByText('凭据续期详情仅支持内置应用宝账号', { exact: false })).toHaveCount(0)
    await expectFits(page)
    await page.screenshot({ path: test.info().outputPath(`qq-native-health-${saved}.png`) })
  })
}

for (const retainLoginHistory of [true, false]) {
  test(`QQ connection recovery hides past failures even when health is stale: ${retainLoginHistory}`, async ({ page }) => {
    const failedLogin = { source: 'qq', state: 'failed', kind: 'rescan', durationMs: 3800 }
    const failedPlan = { state: 'needs_rescan', attempt: 0, maxAttempts: 3, nextRetryAt: null }
    let account: any = { id: 'qq-recovered', name: '恢复账号', platform: 'qq', runtimeState: 'failed', connected: false, running: false, qqAutoCodeAvailable: true, runtimeError: '旧登录错误', runtimeLogin: failedLogin, runtimeReconnect: failedPlan }
    await mockApi(page, [account])
    await page.route('**/api/accounts', route => route.fulfill({ json: { ok: true, data: { accounts: [account] } } }))
    await page.route('**/api/accounts/qq-recovered/health', route => route.fulfill({ json: { ok: true, data: { supported: false, runtime: { state: 'failed', error: '旧健康错误', login: failedLogin, reconnect: failedPlan } } } }))
    await page.goto('/test/browser/accounts.html')
    await page.getByRole('button', { name: /状态检查/ }).click()
    expect(await page.locator('html').evaluate(el => el.classList.contains('dark'))).toBe(test.info().project.use.colorScheme === 'dark')
    await expect(page.getByText('登录失效，请扫码', { exact: true })).toBeVisible()
    await expect(page.getByText('请扫码，重试已暂停', { exact: true })).toBeVisible()
    await expect(page.getByText('登录态：已保存', { exact: true })).toBeVisible()

    account = { ...account, runtimeState: 'online', connected: true, running: true, runtimeError: '', runtimeReconnect: null }
    if (!retainLoginHistory) {
      delete account.runtimeLogin
      delete account.runtimeReconnect
    }
    await page.getByTestId('force-fetch').click()
    await expect(page.getByRole('button', { name: /状态检查 · 在线/ })).toBeVisible()
    await expect(page.getByText('登录失效，请扫码', { exact: true })).toHaveCount(0)
    await expect(page.getByText('请扫码，重试已暂停', { exact: true })).toHaveCount(0)
    await expect(page.getByText(/旧登录错误|旧健康错误/)).toHaveCount(0)
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(page.getByRole('button', { name: /状态检查 · 在线/ })).toBeVisible()
    await expect(page.getByText(/登录失效|重试已暂停|旧健康错误/)).toHaveCount(0)
    await expect(page.getByText('自动取码：已启用', { exact: true })).toHaveCount(0)
    await expectFits(page)
    await page.screenshot({ path: test.info().outputPath(`qq-recovered-${retainLoginHistory}.png`) })

    account = { ...account, runtimeState: 'reconnecting', connected: false, runtimeLogin: { state: 'requesting' }, runtimeReconnect: { state: 'scheduled', attempt: 1, maxAttempts: 3, nextRetryAt: Date.now() + 30000 } }
    await page.getByTestId('force-fetch').click()
    await expect(page.getByRole('button', { name: /状态检查 · 等待重连/ })).toBeVisible()
    await expect(page.getByText('正在取码', { exact: true })).toBeVisible()
    await expect(page.locator('.h-2.w-2.bg-green-500')).toHaveCount(0)

    account = { ...account, runtimeState: 'failed', running: false, runtimeError: '', runtimeLogin: failedLogin, runtimeReconnect: failedPlan }
    await page.getByTestId('force-fetch').click()
    await expect(page.getByRole('button', { name: /状态检查 · 连接失败/ })).toBeVisible()
    await expect(page.getByText('登录失效，请扫码', { exact: true })).toBeVisible()
    await expect(page.getByText('请扫码，重试已暂停', { exact: true })).toBeVisible()
  })
}

test('QQ scan update shows a wrong-account error without claiming success or adding an account', async ({ page }) => {
  await mockOfflineDashboard(page)
  const requested: string[] = []
  page.on('request', request => requested.push(new URL(request.url()).pathname))
  await page.route('**/api/qq-login/sessions', route => route.fulfill({ json: { ok: true, data: { sessionId: 'wrong-fixture' } } }))
  await page.route('**/api/qq-login/sessions/wrong-fixture', route => route.fulfill({ json: { ok: true, data: { status: 'success', code: 'fixture_WRONG_QQ_CODE_12345678' } } }))
  await page.route('**/api/qq-login/sessions/wrong-fixture/import', route => route.fulfill({ status: 409, json: { ok: false, error: '扫码账号与原账号不一致；原账号未修改' } }))
  await page.goto('/test/browser/accounts.html?dashboard')
  await page.getByRole('button', { name: 'QQ 扫码更新', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'QQ 扫码更新', exact: true })
  await expect(dialog.getByRole('alert')).toContainText('扫码账号与原账号不一致')
  await expect(dialog.getByRole('status')).not.toContainText('已更新原账号')
  expect(requested.filter(path => path === '/api/accounts/save')).toEqual([])
  await expectFits(page)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).toHaveCount(0)
})

test('QQ update never falls back to direct when the original proxy is missing', async ({ page }) => {
  await mockOfflineDashboard(page)
  let creates = 0
  await page.route('**/api/yyb/proxy-profiles', route => route.fulfill({ json: { ok: true, data: [] } }))
  await page.route('**/api/qq-login/sessions', (route) => {
    creates++
    return route.fulfill({ json: { ok: true } })
  })
  await page.goto('/test/browser/accounts.html?dashboard')
  await page.getByRole('button', { name: 'QQ 扫码更新', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'QQ 扫码更新', exact: true })
  await expect(dialog.getByRole('alert')).toContainText('原账号的代理配置已不可用')
  expect(creates).toBe(0)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
})

test('login dialog keeps manual and YYB login beside native QQ scan without starting it early', async ({ page }) => {
  await mockApi(page, [])
  const requested: string[] = []
  const errors: string[] = []
  page.on('request', request => requested.push(new URL(request.url()).pathname))
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/yyb/proxy-profiles', route => route.fulfill({ json: { ok: true, data: [] } }))
  await page.route('**/api/yyb/qr/create', route => route.fulfill({ json: { ok: true, data: {
    session_id: 'yyb-session',
    image_base64: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  } } }))
  await page.route('**/api/yyb/qr/poll', route => route.fulfill({ json: { ok: true, data: { status: 'pending' } } }))
  await page.goto('/test/browser/accounts.html')
  await page.getByRole('button', { name: '添加账号', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加账号' })
  await expect(dialog.getByRole('tab')).toHaveText(['手动填码', 'QQ 扫码登录', '应用宝扫码'])
  await expect(dialog.getByRole('tab', { name: '手动填码' })).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.getByPlaceholder('请输入登录 Code')).toBeVisible()
  await expect(dialog.getByText('QQ 小程序', { exact: true })).toBeVisible()
  await dialog.getByRole('tab', { name: '应用宝扫码' }).click()
  await expect.poll(() => requested.filter(path => path === '/api/yyb/qr/create').length).toBe(1)
  await expect.poll(() => requested.includes('/api/yyb/qr/poll')).toBe(true)
  await page.screenshot({ path: test.info().outputPath('remaining-login-methods.png') })
  await expectFits(page)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(requested.filter(path => /\/capture|^\/api\/qr\//.test(path))).toEqual([])
  expect(requested.filter(path => path.startsWith('/api/qq-login/'))).toEqual([])
  expect(errors).toEqual([])
})

test('QQ scan imports its real returned Code once and displays a copyable result', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value: string) => { (window as any).__copiedQqCode = value },
    } })
  })
  await mockApi(page, [])
  const imported: any[] = []
  let polls = 0
  let cancelled = 0
  await page.route('**/api/yyb/proxy-profiles', route => route.fulfill({ json: { ok: true, data: [] } }))
  await page.route('**/api/qq-login/sessions', route => route.fulfill({ status: 201, json: { ok: true, data: { sessionId: 'qq-native-fixture', status: 'starting' } } }))
  await page.route('**/api/qq-login/sessions/qq-native-fixture', async (route) => {
    if (route.request().method() === 'DELETE') {
      cancelled++
      await route.fulfill({ json: { ok: true } })
      return
    }
    polls++
    await route.fulfill({ json: { ok: true, data: polls < 2
      ? { sessionId: 'qq-native-fixture', status: 'waiting_scan', message: '请用手机 QQ 扫码并确认登录', image: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' }
      : { sessionId: 'qq-native-fixture', status: 'success', message: '已获取 Code', code: 'fixture_WEB_QQ_CODE_12345678' } } })
  })
  await page.route('**/api/qq-login/sessions/qq-native-fixture/import', async (route) => {
    imported.push(route.request().postDataJSON())
    await route.fulfill({ json: { ok: true, data: { accountId: 'qq-new', updated: false, code: 'fixture_WEB_QQ_CODE_12345678' } } })
  })
  await page.goto('/test/browser/accounts.html')
  await page.getByRole('button', { name: '添加账号', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加账号' })
  await dialog.getByRole('tab', { name: 'QQ 扫码登录' }).click()
  await expect(dialog.getByAltText('QQ 登录二维码')).toBeVisible()
  await expect(dialog.getByRole('status')).toContainText('请用手机 QQ 扫码')
  await expect(dialog.getByRole('status')).toContainText('账号已添加，正在连接', { timeout: 10000 })
  expect(imported).toHaveLength(1)
  expect(imported[0]).toEqual({ name: '' })
  await expect(dialog.getByRole('button', { name: '复制', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '复制', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '已复制', exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as any).__copiedQqCode)).toBe('fixture_WEB_QQ_CODE_12345678')
  const footer = dialog.getByText('作者：nkooe')
  await footer.scrollIntoViewIfNeeded()
  await expect(footer).toBeInViewport({ ratio: 1 })
  await expect.poll(() => cancelled).toBe(1)
  await expectFits(page)
  await page.screenshot({ path: test.info().outputPath('qq-native-scan-success.png') })
})

test('QQ proxy selection recreates the scan and same-account import reports an update with the fresh copyable Code', async ({ page }) => {
  await mockApi(page, [])
  const choices: any[] = []
  await page.route('**/api/yyb/proxy-profiles', route => route.fulfill({ json: { ok: true, data: [{ id: 7, name: '测试代理' }] } }))
  await page.route('**/api/qq-login/sessions', async (route) => {
    choices.push(route.request().postDataJSON())
    await route.fulfill({ status: 201, json: { ok: true, data: { sessionId: `proxy-${choices.length}` } } })
  })
  await page.route('**/api/qq-login/sessions/proxy-*', route => route.fulfill({ json: { ok: true, data: route.request().method() === 'DELETE'
    ? {}
    : choices.length === 1
      ? { status: 'waiting_scan', message: '请扫码' }
      : { status: 'success', code: 'fixture_CONSUMED_CODE_12345678' } } }))
  await page.route('**/api/qq-login/sessions/proxy-2/import', route => route.fulfill({ json: { ok: true, data: { accountId: '10', updated: true, code: 'fixture_FRESH_CODE_12345678' } } }))
  await page.goto('/test/browser/accounts.html')
  await page.getByRole('button', { name: '添加账号', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加账号' })
  await dialog.getByRole('tab', { name: 'QQ 扫码登录' }).click()
  await expect(dialog.getByRole('status')).toHaveText('请扫码')
  await dialog.getByLabel('QQ 连接方式').selectOption('7')
  await expect(dialog.getByRole('status')).toContainText('已更新原账号，正在连接')
  expect(choices).toEqual([{ proxyMode: 'direct', proxyProfileId: null }, { proxyMode: 'static', proxyProfileId: 7 }])
  await expect(dialog.locator('code')).toHaveText('fixture_FRESH_CODE_12345678')
  await expectFits(page)
  await page.screenshot({ path: test.info().outputPath('qq-proxy-existing-account.png') })
})

test('QQ proxy inventory failure pauses scan creation until retry', async ({ page }) => {
  await mockApi(page, [])
  let creates = 0
  await page.route('**/api/yyb/proxy-profiles', route => route.fulfill({ status: 503, json: { ok: false, error: '代理服务暂时不可用' } }))
  await page.route('**/api/qq-login/sessions', (route) => {
    creates++
    return route.fulfill({ json: { ok: true } })
  })
  await page.goto('/test/browser/accounts.html')
  await page.getByRole('button', { name: '添加账号', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加账号' })
  await dialog.getByRole('tab', { name: 'QQ 扫码登录' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('代理服务暂时不可用')
  await expect(dialog.getByRole('button', { name: '重试加载' })).toBeVisible()
  expect(creates).toBe(0)
})

test('switching tabs cancels its QQ scan and never imports a late result', async ({ page }) => {
  await mockApi(page, [])
  let cancelled = 0
  let imported = 0
  await page.route('**/api/yyb/proxy-profiles', route => route.fulfill({ json: { ok: true, data: [] } }))
  await page.route('**/api/qq-login/sessions', route => route.fulfill({ status: 201, json: { ok: true, data: { sessionId: 'qq-cancel-fixture' } } }))
  await page.route('**/api/qq-login/sessions/qq-cancel-fixture', async (route) => {
    if (route.request().method() === 'DELETE') {
      cancelled++
      await route.fulfill({ json: { ok: true } })
    }
    else { await route.fulfill({ json: { ok: true, data: { status: 'waiting_scan', message: '正在等待手机扫码' } } }) }
  })
  await page.route('**/api/qq-login/sessions/*/import', async (route) => {
    imported++
    await route.fulfill({ json: { ok: true, data: {} } })
  })
  await page.goto('/test/browser/accounts.html')
  await page.getByRole('button', { name: '添加账号', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加账号' })
  await dialog.getByRole('tab', { name: 'QQ 扫码登录' }).click()
  await expect(dialog.getByRole('status')).toContainText('正在等待手机扫码')
  await dialog.getByRole('tab', { name: '手动填码' }).click()
  await expect.poll(() => cancelled).toBe(1)
  expect(imported).toBe(0)
})

test('cleanup previews a fixed list and reports accounts whose state changed', async ({ page }) => {
  await mockApi(page)
  const deleted: string[] = []
  await page.route('**/api/accounts/*?onlyStopped=1', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop()!
    deleted.push(id)
    await route.fulfill(id === '1'
      ? { status: 409, json: { ok: false, error: '账号状态已变化，已跳过清理' } }
      : { json: { ok: true } })
  })
  await page.goto('/test/browser/accounts.html')
  await expect(page.getByRole('heading', { name: '已停止账号甲' })).toBeVisible()
  await page.getByRole('button', { name: /清理\s*\(2\)/ }).click()
  const dialog = page.getByRole('dialog', { name: '一键清理已停止账号' })
  await expect(dialog).toContainText('已停止账号甲')
  await expect(dialog).toContainText('已停止账号乙')
  await expect(dialog).not.toContainText('启动中的账号')
  await expect(dialog).not.toContainText('连接失败的账号')
  // A newly stopped account after preview must not be silently included.
  await page.unroute('**/api/accounts')
  await page.route('**/api/accounts', route => route.fulfill({ json: {
    ok: true,
    data: { accounts: [...initialAccounts, { id: '5', name: '新停止账号', runtimeState: 'stopped' }] },
  } }))
  await page.waitForTimeout(3200)
  await dialog.getByRole('button', { name: '确认清理' }).click()
  await expect(page.getByRole('alert')).toContainText('成功清理 1 个账号，跳过或失败 1 个')
  expect(deleted).toEqual(['1', '2'])
  await expectFits(page)
})

test('overlapping list requests merge and stale responses cannot replace newer accounts', async ({ page }) => {
  await mockApi(page)
  const releases: Array<() => Promise<void>> = []
  await page.route('**/api/accounts', (route) => {
    const index = releases.length
    releases.push(async () => {
      await route.fulfill({ json: { ok: true, data: { accounts: [{ id: String(index), name: index ? '最新数据' : '旧数据', runtimeState: 'stopped' }] } } }).catch(() => {})
    })
  })
  await page.goto('/test/browser/accounts.html')
  await expect.poll(() => releases.length).toBe(1)
  await page.getByTestId('fetch').click({ clickCount: 3 })
  expect(releases).toHaveLength(1)
  await page.getByTestId('force-fetch').click()
  await expect.poll(() => releases.length).toBe(2)
  await releases[1]!()
  await expect(page.getByRole('heading', { name: '最新数据' })).toBeVisible()
  await releases[0]!()
  await expect(page.getByRole('heading', { name: '最新数据' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '旧数据', exact: true })).toHaveCount(0)
})

test('list failure retains accounts and task completion reports its separate refresh failure', async ({ page }) => {
  await mockApi(page)
  await page.goto('/test/browser/accounts.html')
  await expect(page.getByRole('heading', { name: '已停止账号甲' })).toBeVisible()
  await page.route('**/api/accounts', route => route.fulfill({ status: 503, json: { ok: false } }))
  await page.getByTestId('force-fetch').click()
  await expect(page.getByRole('status')).toContainText('账号列表更新失败')
  await expect(page.getByRole('heading', { name: '已停止账号甲' })).toBeVisible()
  const job = { jobId: 'done', state: 'completed', total: 1, completed: 1, success: 1, failed: 0, skipped: 0, currentAccount: null, results: [{ accountId: '1', name: '测试账号', ok: true }], error: '', createdAt: 1, updatedAt: 1 }
  await page.route('**/api/accounts/refresh-wx-codes', route => route.fulfill({ status: 202, json: { ok: true, data: job } }))
  await page.route('**/api/accounts/refresh-wx-codes/done', route => route.fulfill({ json: { ok: true, data: job } }))
  await page.getByRole('button', { name: /刷新.*Code/ }).click()
  await expect(page.getByRole('alert')).toContainText('任务已完成，但账号列表更新失败')
  await expectFits(page)
})

test('reload restores interrupted task and retry sends the original job reference', async ({ page }) => {
  await mockApi(page)
  let interrupted = false
  const submissions: any[] = []
  const job = { jobId: 'restart', state: 'running', total: 3, completed: 1, success: 1, failed: 0, skipped: 0, currentAccount: { id: '3', name: '未确认账号' }, results: [{ accountId: '1', name: '成功账号', ok: true }], retryableAccountIds: ['2'], error: '', createdAt: 1, updatedAt: 1 }
  await page.route('**/api/accounts/refresh-wx-codes', async (route) => {
    submissions.push(route.request().postDataJSON())
    await route.fulfill({ status: 202, json: { ok: true, data: { ...job, jobId: submissions.length > 1 ? 'retry' : 'restart' } } })
  })
  await page.route('**/api/accounts/refresh-wx-codes/*', route => route.fulfill({ json: { ok: true, data: {
    ...job,
    state: interrupted ? 'interrupted' : 'running',
    uncertainAccount: interrupted ? { id: '3', name: '未确认账号' } : null,
    error: interrupted ? '服务重启，任务已中断' : '',
  } } }))
  await page.goto('/test/browser/accounts.html')
  await expect(page.getByRole('heading', { name: '已停止账号甲' })).toBeVisible()
  await page.getByRole('button', { name: /刷新.*Code/ }).click()
  await expect(page.getByText('当前账号：未确认账号')).toBeVisible()
  interrupted = true
  await page.reload()
  await expect(page.getByText('未确认账号 的结果未确认', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: '重试失败或未执行账号（1）' })).toBeEnabled()
  // A second page reload must preserve the terminal task and its retry entry.
  await page.reload()
  await expect(page.getByText('未确认账号 的结果未确认', { exact: false })).toBeVisible()
  await expect(page.locator('p[role="alert"]').first()).toBeEmpty()
  expect(submissions).toHaveLength(1)
  await page.screenshot({ path: test.info().outputPath('interrupted-task.png') })
  await page.getByRole('button', { name: '重试失败或未执行账号（1）' }).click()
  await expect.poll(() => submissions.length).toBe(2)
  expect(submissions[1].retryJobId).toBe('restart')
  expect(submissions[1].requestId).not.toBe(submissions[0].requestId)
  await expectFits(page)
})

test('long cleanup list scrolls inside the dialog while confirmation remains reachable', async ({ page }) => {
  await mockApi(page, Array.from({ length: 40 }, (_, index) => ({
    id: String(index),
    name: `账号${index}-${'长名字'.repeat(20)}`,
    runtimeState: 'stopped',
    running: false,
  })))
  await page.goto('/test/browser/accounts.html')
  await page.getByRole('button', { name: /清理\s*\(40\)/ }).click()
  const dialog = page.getByRole('dialog', { name: '一键清理已停止账号' })
  const button = dialog.getByRole('button', { name: '确认清理' })
  await expect(button).toBeInViewport()
  await expectFits(page)
  await expect(dialog.getByRole('button', { name: '取消' })).toBeInViewport()
  await page.screenshot({ path: test.info().outputPath('cleanup-preview.png') })
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toHaveCount(0)
})

test('reconnecting accounts show their retry plan, stay out of cleanup and can cancel recovery', async ({ page }) => {
  const pending = { id: '5', name: '等待重连账号', runtimeState: 'reconnecting', running: false, yybOpenid: 'fixture', runtimeReconnect: { state: 'scheduled', attempt: 2, maxAttempts: 3, nextRetryAt: Date.now() + 300000, reason: 'heartbeat_timeout' } }
  const stale = { id: '6', name: '旧状态恢复账号', runtimeState: 'stopped', running: false, runtimeReconnect: { state: 'waiting_credentials', attempt: 3, maxAttempts: 3, nextRetryAt: null, reason: 'startup_failed' } }
  await mockApi(page, [...initialAccounts, pending, stale])
  const actions: string[] = []
  await page.route('**/api/accounts/5/stop', (route) => {
    actions.push('stop')
    return route.fulfill({ json: { ok: true } })
  })
  await page.goto('/test/browser/accounts.html')
  await expect(page.getByText('状态检查 · 等待重连')).toBeVisible()
  await expect(page.getByText(/重连 2\/3，\d+ 秒后重试/)).toBeVisible()
  await page.getByRole('button', { name: /清理\s*\(2\)/ }).click()
  const dialog = page.getByRole('dialog', { name: '一键清理已停止账号' })
  await expect(dialog).not.toContainText('等待重连账号')
  await expect(dialog).not.toContainText('旧状态恢复账号')
  await dialog.getByRole('button', { name: '取消' }).click()
  await page.getByRole('button', { name: '取消恢复' }).first().click()
  await expect.poll(() => actions).toEqual(['stop'])
  await expectFits(page)
  await page.screenshot({ path: test.info().outputPath('reconnect-plan.png') })
})
