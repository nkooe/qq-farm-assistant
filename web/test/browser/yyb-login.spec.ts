import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

async function mockYybLogin(page: Page, initialState = 'failed') {
  const state = { runtime: initialState, saves: [] as any[], starts: 0, checks: 0, codeError: false }
  await page.addInitScript(() => {
    localStorage.setItem('ui_theme:1000', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  })
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: {} } }))
  await page.route('**/api/yyb/proxy-profiles', route => route.fulfill({ json: { ok: true, data: [] } }))
  await page.route('**/api/yyb/qr/create', route => route.fulfill({ json: { ok: true, data: {
    session_id: 'yyb-state-fixture',
    image_base64: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  } } }))
  await page.route('**/api/yyb/qr/poll', route => route.fulfill({ json: { ok: true, data: { status: 'authorized' } } }))
  await page.route('**/api/yyb/qr/confirm', route => route.fulfill({ json: { ok: true, data: { openid: 'yyb-fixture', nickname: '测试应用宝' } } }))
  await page.route('**/api/yyb/getcode', route => route.fulfill(state.codeError
    ? { status: 503, json: { ok: false, error: '登录取码失败' } }
    : { json: { ok: true, data: { code: 'fixture_YYB_CODE_12345678' } } }))
  const account = { id: 'yyb-new', name: '测试应用宝', autoStart: true, platform: 'wx', loginType: 'yyb', yybOpenid: 'yyb-fixture' }
  await page.route('**/api/accounts', async (route) => {
    if (route.request().method() === 'POST')
      state.saves.push(route.request().postDataJSON())
    await route.fulfill({ json: { ok: true, data: { accounts: state.saves.length ? [account] : [] } } })
  })
  await page.route('**/api/accounts/yyb-new/start', (route) => {
    state.starts++
    state.runtime = 'online'
    return route.fulfill({ status: 202, json: { ok: true, data: { state: 'starting' } } })
  })
  await page.route('**/api/accounts/yyb-new/runtime', (route) => {
    state.checks++
    return route.fulfill(state.runtime === 'query-error'
      ? { status: 503, json: { ok: false, error: '状态服务暂时不可用' } }
      : { json: { ok: true, data: {
          state: state.runtime, connected: state.runtime === 'online',
          error: state.runtime === 'failed' ? '取码已取消' : '',
        } } })
  })
  return state
}

async function openYybLogin(page: Page) {
  await page.goto('/test/browser/accounts.html')
  await page.getByRole('button', { name: '添加账号', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加账号' })
  await dialog.getByRole('tab', { name: '应用宝扫码' }).click()
  return dialog
}

test('YYB saved account reports cancelled startup and retries without adding it again', async ({ page }) => {
  const state = await mockYybLogin(page)
  const dialog = await openYybLogin(page)
  await expect(dialog.getByRole('status')).toHaveText('添加成功，启动失败')
  await expect(dialog.getByRole('alert')).toHaveText('原因：取码已取消')
  await expect(dialog.locator('.i-carbon-checkmark-filled')).toHaveCount(0)
  expect(state.saves).toHaveLength(1)
  expect(state.saves[0].autoStart).toBe(true)
  expect(state.starts).toBe(0)
  await page.screenshot({ path: test.info().outputPath('yyb-saved-start-failed.png') })
  await dialog.getByRole('button', { name: '重试启动', exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveText('添加成功，已上线')
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expect(dialog.locator('.i-carbon-checkmark-filled')).toBeVisible()
  expect(state.saves).toHaveLength(1)
  expect(state.starts).toBe(1)
})

test('YYB initial import observes the existing startup until it really connects', async ({ page }) => {
  const state = await mockYybLogin(page, 'starting')
  const dialog = await openYybLogin(page)
  await expect(dialog.getByRole('status')).toHaveText('添加成功，正在启动')
  await expect(dialog.locator('.i-carbon-checkmark-filled')).toHaveCount(0)
  state.runtime = 'online'
  await expect(dialog.getByRole('status')).toHaveText('添加成功，已上线')
  expect(state.saves).toHaveLength(1)
  expect(state.starts).toBe(0)
  await expect(dialog.getByRole('button', { name: '完成', exact: true })).toBeVisible()
})

test('YYB scheduled recovery is shown as waiting for reconnection', async ({ page }) => {
  const state = await mockYybLogin(page, 'reconnecting')
  const dialog = await openYybLogin(page)
  await expect(dialog.getByRole('status')).toHaveText('添加成功，等待重连')
  await expect(dialog.getByRole('button', { name: '立即重试', exact: true })).toBeVisible()
  await expect(dialog.locator('.i-carbon-checkmark-filled')).toHaveCount(0)
  expect(state.starts).toBe(0)
  await page.screenshot({ path: test.info().outputPath('yyb-waiting-reconnect.png') })
})

test('YYB status read failure stays unconfirmed and refreshing never restarts the account', async ({ page }) => {
  const state = await mockYybLogin(page, 'query-error')
  const dialog = await openYybLogin(page)
  await expect(dialog.getByRole('status')).toHaveText('添加成功，状态待确认')
  await expect(dialog.getByRole('alert')).toContainText('状态服务暂时不可用')
  state.runtime = 'online'
  await dialog.getByRole('button', { name: '刷新状态', exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveText('添加成功，已上线')
  expect(state.saves).toHaveLength(1)
  expect(state.starts).toBe(0)
})

test('YYB startup observation timeout does not claim that saving or connecting failed', async ({ page }) => {
  const state = await mockYybLogin(page, 'starting')
  await page.clock.install()
  const dialog = await openYybLogin(page)
  await expect(dialog.getByRole('status')).toHaveText('添加成功，正在启动')
  await page.clock.fastForward(91000)
  await expect(dialog.getByRole('status')).toHaveText('添加成功，状态待确认')
  await expect(dialog.getByRole('alert')).toContainText('连接超时')
  expect(state.starts).toBe(0)
})

test('YYB code failure before saving never shows an added account', async ({ page }) => {
  const state = await mockYybLogin(page)
  state.codeError = true
  const dialog = await openYybLogin(page)
  await expect(dialog.getByRole('alert')).toHaveText('登录取码失败')
  await expect(dialog.getByText(/添加成功/)).toHaveCount(0)
  expect(state.saves).toHaveLength(0)
  expect(state.starts).toBe(0)
})
