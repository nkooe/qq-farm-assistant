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
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: {} } }))
  await page.route('**/api/accounts', route => route.fulfill({ json: { ok: true, data: { accounts } } }))
}

async function expectFits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

test('login dialog keeps manual and YYB login without QQ QR or capture requests', async ({ page }) => {
  await mockApi(page, [])
  const requested: string[] = []
  const errors: string[] = []
  page.on('request', request => requested.push(new URL(request.url()).pathname))
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/yyb/proxy-profiles', route => route.fulfill({ json: { ok: true, data: [] } }))
  await page.route('**/api/yyb/qr/create', route => route.fulfill({ json: { ok: true, data: {
    session_id: 'yyb-session', image_base64: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  } } }))
  await page.route('**/api/yyb/qr/poll', route => route.fulfill({ json: { ok: true, data: { status: 'pending' } } }))
  await page.goto('/test/browser/accounts.html')
  await page.getByRole('button', { name: '添加账号', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加账号' })
  await expect(dialog.getByRole('tab')).toHaveText(['手动填码', '应用宝扫码'])
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
  expect(errors).toEqual([])
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
  await expect(page.getByText('账号健康 · 等待自动重连')).toBeVisible()
  await expect(page.getByText(/第 2\/3 次重连，约 \d+ 秒后执行/)).toBeVisible()
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
