import { StorageSerializers, useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import api from '@/api'
import { useUserStore } from '@/stores/user'

export interface Account {
  id: string
  name: string
  nick?: string
  uin?: number
  qq?: string | number
  wxid?: string
  gid?: string | number
  openId?: string
  avatar?: string
  avatarUrl?: string
  userId: number
  platform?: string
  loginType?: string
  proxyMode?: 'direct' | 'static'
  proxyProfileId?: number | null
  qqAutoCodeAvailable?: boolean
  qqAutoReconnect?: boolean
  yybOpenid?: string
  autoStart?: boolean
  running?: boolean
  connected?: boolean
  runtimeState?: 'online' | 'starting' | 'reconnecting' | 'failed' | 'stopped' | 'stopping'
  runtimeError?: string
  runtimeReconnect?: { state: 'scheduled' | 'exhausted' | 'waiting_credentials' | 'needs_rescan' | 'blocked', attempt: number, maxAttempts: number, nextRetryAt: number | null, reason: string, kind?: string }
  runtimeLogin?: { source: string, state: 'queued' | 'requesting' | 'success' | 'failed' | 'cancelled', kind: string, startedAt: number, lastSuccessAt: number | null, durationMs: number | null } | null
  // Add other fields as discovered
}

export interface RefreshWxCodesResult {
  total: number
  success: number
  failed: number
  skipped: number
  results: Array<{
    accountId: string
    name: string
    ok: boolean
    source?: 'yyb' | 'wxid'
    error?: string
  }>
}

export function hasPendingAccountRecovery(account: Pick<Account, 'runtimeState' | 'runtimeReconnect'>) {
  return account.runtimeState === 'reconnecting' || ['scheduled', 'waiting_credentials'].includes(account.runtimeReconnect?.state || '')
}

export interface RefreshWxCodesJob {
  jobId: string
  state: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted'
  total: number
  completed: number
  success: number
  failed: number
  skipped: number
  currentAccount: { id: string, name: string } | null
  results: RefreshWxCodesResult['results']
  error: string
  createdAt: number
  updatedAt: number
  uncertainAccount?: { id: string, name: string } | null
  retryableAccountIds?: string[]
}

export interface AccountLog {
  time: string
  action: string
  msg: string
  reason?: string
}

export function getPlatformLabel(p?: string) {
  if (p === 'qq')
    return 'QQ'
  if (p === 'wx')
    return '微信'
  return ''
}

export function getPlatformClass(p?: string) {
  if (p === 'qq')
    return 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
  if (p === 'wx')
    return 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400'
  return ''
}

export const useAccountStore = defineStore('account', () => {
  const accounts = ref<Account[]>([])
  const currentAccountId = useStorage('current_account_id', '')
  const accountOwner = useStorage<number | null>('current_account_owner', null, undefined, { serializer: StorageSerializers.object })
  const userStore = useUserStore()
  const loading = ref(false)
  const logs = ref<AccountLog[]>([])
  const accountsError = ref('')
  let accountsRequest: Promise<boolean> | null = null
  let accountsGeneration = 0
  let accountsAbort: AbortController | null = null

  watch([() => userStore.token, () => userStore.userId], ([, userId], previous) => {
    if (accountOwner.value !== userId || previous.length > 0) {
      accountsGeneration++
      accountsAbort?.abort()
      accountsAbort = null
      accountsRequest = null
      accounts.value = []
      logs.value = []
      loading.value = false
      accountsError.value = ''
      currentAccountId.value = ''
      accountOwner.value = null
    }
  }, { immediate: true, flush: 'sync' })

  function applyAccounts(nextAccounts: Account[]) {
    accountOwner.value = userStore.userId
    accounts.value = nextAccounts

    if (accounts.value.length === 0) {
      currentAccountId.value = ''
      return
    }

    const found = accounts.value.find(a => String(a.id) === currentAccountId.value)
    if (!found && accounts.value[0]) {
      currentAccountId.value = String(accounts.value[0].id)
    }
  }

  const currentAccount = computed(() =>
    accounts.value.find(a => String(a.id) === currentAccountId.value),
  )

  function fetchAccounts(options: { force?: boolean } = {}): Promise<boolean> {
    if (accountsRequest && !options.force)
      return accountsRequest
    accountsAbort?.abort()
    const controller = new AbortController()
    accountsAbort = controller
    const generation = ++accountsGeneration
    loading.value = true
    accountsRequest = (async () => {
      try {
        const res = await api.get('/api/accounts', { signal: controller.signal, skipErrorToast: true } as any)
        if (generation !== accountsGeneration)
          return false
        if (!res.data.ok || !Array.isArray(res.data.data?.accounts))
          throw new Error('账号列表响应格式异常')
        applyAccounts(res.data.data.accounts)
        accountsError.value = ''
        return true
      }
      catch {
        if (generation === accountsGeneration)
          accountsError.value = '账号列表更新失败，已保留上次数据；正在等待重试'
        return false
      }
      finally {
        if (generation === accountsGeneration) {
          loading.value = false
          accountsRequest = null
          accountsAbort = null
        }
      }
    })()
    return accountsRequest
  }

  function selectAccount(id: string) {
    currentAccountId.value = id
  }

  function setCurrentAccount(acc: Account) {
    selectAccount(acc.id)
  }

  async function startAccount(id: string) {
    await api.post(`/api/accounts/${id}/start`)
    await fetchAccounts({ force: true })
  }

  async function stopAccount(id: string) {
    await api.post(`/api/accounts/${id}/stop`)
    await fetchAccounts({ force: true })
  }

  async function startWxCodeRefresh(requestId: string, retryJobId?: string) {
    const res = await api.post('/api/accounts/refresh-wx-codes', { requestId, retryJobId }, {
      timeout: 15000,
      // 页面会按批量结果显示成功/失败明细，避免拦截器再弹一个重复的通用 Toast。
      skipErrorToast: true,
    } as any)
    return res.data as { ok: boolean, error?: string, data?: RefreshWxCodesJob | RefreshWxCodesResult }
  }

  async function getWxCodeRefreshJob(jobId: string) {
    const res = await api.get(`/api/accounts/refresh-wx-codes/${encodeURIComponent(jobId)}`, {
      timeout: 10000,
      skipErrorToast: true,
    } as any)
    return res.data as { ok: boolean, error?: string, data?: RefreshWxCodesJob }
  }

  async function deleteAccount(id: string, options: { onlyStopped?: boolean, refresh?: boolean } = {}) {
    const res = await api.delete(`/api/accounts/${id}`, {
      params: options.onlyStopped ? { onlyStopped: '1' } : undefined,
      skipErrorToast: options.onlyStopped,
    } as any)
    if (!res.data.ok)
      throw new Error(res.data.error || '删除账号失败')
    // Invalidate any list fetched before the deletion.
    accountsGeneration++
    accountsAbort?.abort()
    accountsRequest = null
    accountsAbort = null
    loading.value = false
    applyAccounts(accounts.value.filter(account => String(account.id) !== String(id)))
    if (currentAccountId.value === id) {
      currentAccountId.value = ''
    }
    if (options.refresh !== false)
      await fetchAccounts({ force: true })
  }

  async function fetchLogs() {
    try {
      const res = await api.get('/api/account-logs?limit=100')
      if (Array.isArray(res.data)) {
        logs.value = res.data
      }
    }
    catch (e) {
      console.error('获取账号日志失败', e)
    }
  }

  async function addAccount(payload: any) {
    try {
      await api.post('/api/accounts', payload)
      await fetchAccounts({ force: true })
    }
    catch (e) {
      console.error('添加账号失败', e)
      throw e
    }
  }

  async function updateAccount(id: string, payload: any) {
    try {
      // core uses POST /api/accounts for both add and update (if id is present)
      await api.post('/api/accounts', { ...payload, id })
      await fetchAccounts({ force: true })
    }
    catch (e) {
      console.error('更新账号失败', e)
      throw e
    }
  }

  return {
    accounts,
    currentAccountId,
    currentAccount,
    loading,
    accountsError,
    logs,
    fetchAccounts,
    selectAccount,
    startAccount,
    stopAccount,
    startWxCodeRefresh,
    getWxCodeRefreshJob,
    deleteAccount,
    fetchLogs,
    addAccount,
    updateAccount,
    setCurrentAccount,
  }
})
