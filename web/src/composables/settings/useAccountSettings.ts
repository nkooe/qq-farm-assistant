import type { RefreshWxCodesJob, RefreshWxCodesResult } from '@/stores/account'
import { useDocumentVisibility } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onScopeDispose, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { getApiErrorMessage } from '@/api'
import { hasPendingAccountRecovery, useAccountStore } from '@/stores/account'
import { useUserStore } from '@/stores/user'

type AlertType = 'primary' | 'danger'

export function useAccountSettings(showAlert: (message: string, type?: AlertType) => void) {
  const router = useRouter()
  const accountStore = useAccountStore()
  const userStore = useUserStore()
  const { accounts, loading: accountsLoading, accountsError, currentAccountId } = storeToRefs(accountStore)

  const showModal = ref(false)
  const showDeleteConfirm = ref(false)
  const deleteLoading = ref(false)
  const editingAccount = ref<any>(null)
  const accountToDelete = ref<any>(null)
  const showClearStoppedConfirm = ref(false)
  const clearStoppedLoading = ref(false)
  const clearStoppedCandidates = ref<Array<{ id: string, name: string }>>([])
  const clearStoppedMessage = computed(() => `确定清理以下 ${clearStoppedCandidates.value.length} 个已停止账号吗？此操作不可恢复。\n${clearStoppedCandidates.value.map(account => account.name).join('\n')}\n执行时状态发生变化的账号会自动跳过。`)
  const refreshWxCodesLoading = ref(false)
  const refreshWxCodesProgress = ref<RefreshWxCodesJob | null>(null)
  const refreshWxCodesPollWarning = ref('')
  let refreshPollGeneration = 0
  let refreshPollTimer: ReturnType<typeof setTimeout> | null = null
  const refreshPollsInFlight = new Set<number>()

  const userIsAdmin = computed(() => userStore.isAdmin)
  const isAccountOpsDisabled = computed(() => !userStore.isAdmin && userStore.isExpired)
  const quotaLimit = computed(() => {
    const limit = userStore.accountLimit
    if (limit === undefined || limit === null)
      return 3
    return limit
  })
  const isOverQuota = computed(() => {
    if (userStore.isAdmin)
      return false
    const limit = quotaLimit.value
    if (limit === -1)
      return false
    return accounts.value.length >= limit
  })
  const isAddAccountDisabled = computed(() => isAccountOpsDisabled.value || isOverQuota.value)
  const addAccountDisabledReason = computed(() => {
    if (isAccountOpsDisabled.value)
      return '账号已到期，无法添加账号'
    if (isOverQuota.value)
      return '已超过配额，无法添加账号'
    return ''
  })

  const stoppedAccounts = computed(() => accounts.value.filter(acc => acc.runtimeState === 'stopped' && !acc.running && !acc.connected && !hasPendingAccountRecovery(acc)))
  const stoppedAccountsCount = computed(() => stoppedAccounts.value.length)
  const currentAccountName = computed(() => {
    const acc = accounts.value.find((item: any) => item.id === currentAccountId.value)
    return acc ? (acc.name || acc.nick || acc.id) : null
  })

  const visibility = useDocumentVisibility()
  let accountsPollTimer: ReturnType<typeof setTimeout> | null = null
  let accountsPollDisposed = false
  let accountsPollFailures = 0
  let accountsPollInFlight = false

  function scheduleAccountsPoll(delay = 3000) {
    if (accountsPollTimer !== null)
      clearTimeout(accountsPollTimer)
    accountsPollTimer = null
    if (!accountsPollDisposed && visibility.value === 'visible')
      accountsPollTimer = setTimeout(() => void pollAccounts(), delay)
  }

  async function pollAccounts() {
    if (accountsPollDisposed || visibility.value !== 'visible' || accountsPollInFlight)
      return
    accountsPollInFlight = true
    try {
      const ok = await accountStore.fetchAccounts()
      accountsPollFailures = ok ? 0 : accountsPollFailures + 1
    }
    finally {
      accountsPollInFlight = false
      scheduleAccountsPoll(Math.min(30000, 3000 * 2 ** Math.min(accountsPollFailures, 4)))
    }
  }

  watch(visibility, () => scheduleAccountsPoll(0))
  scheduleAccountsPoll()

  async function fetchAccounts() {
    await accountStore.fetchAccounts()
  }

  function selectFirstAccountIfNeeded() {
    if (!currentAccountId.value && accounts.value.length > 0 && accounts.value[0]) {
      accountStore.selectAccount(String(accounts.value[0].id))
    }
  }

  function openSettings(account: any) {
    accountStore.selectAccount(account.id)
    router.push('/settings')
  }

  function openAddModal() {
    editingAccount.value = null
    showModal.value = true
  }

  function openEditModal(account: any) {
    editingAccount.value = { ...account }
    showModal.value = true
  }

  function handleDelete(account: any) {
    accountToDelete.value = account
    showDeleteConfirm.value = true
  }

  async function confirmDelete() {
    if (accountToDelete.value) {
      try {
        deleteLoading.value = true
        await accountStore.deleteAccount(accountToDelete.value.id)
        accountToDelete.value = null
        showDeleteConfirm.value = false
      }
      finally {
        deleteLoading.value = false
      }
    }
  }

  async function toggleAccount(account: any) {
    if (account.running || account.runtimeState === 'starting' || hasPendingAccountRecovery(account)) {
      await accountStore.stopAccount(account.id)
    }
    else {
      await accountStore.startAccount(account.id)
    }
  }

  function refreshJobStorageKey() {
    return `refresh-wx-codes-job:${userStore.userId || 'unknown'}`
  }

  function clearRefreshPollTimer() {
    if (refreshPollTimer !== null) {
      clearTimeout(refreshPollTimer)
      refreshPollTimer = null
    }
  }

  function clearSavedRefreshTask() {
    sessionStorage.removeItem(refreshJobStorageKey())
    sessionStorage.removeItem(`${refreshJobStorageKey()}:retry`)
  }

  function createRefreshRequestId() {
    return globalThis.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }

  function showRefreshSummary(job: RefreshWxCodesJob) {
    if (job.state === 'failed' || job.state === 'interrupted') {
      showAlert(job.error || '批量刷新任务失败，请查看账号状态后重试', 'danger')
      return
    }
    if (job.failed > 0) {
      const failures = job.results.filter(result => !result.ok)
        .map(result => `${result.name}：${result.error || '刷新失败'}`)
        .join('\n')
      showAlert(`微信 Code 刷新完成：成功 ${job.success} 个，失败 ${job.failed} 个。失败账号保持原运行状态。${failures ? `\n${failures}` : ''}`, 'danger')
      return
    }
    const yybCount = job.results.filter(item => item.ok && item.source === 'yyb').length
    const wxidCount = job.results.filter(item => item.ok && item.source === 'wxid').length
    const sourceText = [yybCount ? `应用宝 ${yybCount} 个` : '', wxidCount ? `微信授权 ${wxidCount} 个` : '']
      .filter(Boolean)
      .join('，')
    const skippedText = job.skipped > 0 ? `；跳过 ${job.skipped} 个非微信账号` : ''
    showAlert(`微信 Code 刷新完成：成功 ${job.success} 个${sourceText ? `（${sourceText}）` : ''}${skippedText}`, 'primary')
  }

  function scheduleRefreshPoll(generation: number, delayMs: number, failedAttempts = 0) {
    clearRefreshPollTimer()
    refreshPollTimer = setTimeout(() => {
      refreshPollTimer = null
      void pollRefreshJob(generation, failedAttempts)
    }, delayMs)
  }

  function scheduleRefreshRequestRetry(requestId: string, generation: number, failedAttempts: number) {
    clearRefreshPollTimer()
    const delayMs = Math.min(10000, 1000 * 2 ** Math.min(failedAttempts, 4))
    refreshPollTimer = setTimeout(() => {
      refreshPollTimer = null
      void startOrResumeRefreshRequest(requestId, generation, failedAttempts)
    }, delayMs)
  }

  async function finishRefreshJob(job: RefreshWxCodesJob, generation: number) {
    if (generation !== refreshPollGeneration)
      return
    refreshWxCodesProgress.value = job
    clearRefreshPollTimer()
    clearSavedRefreshTask()
    const lastShownJobKey = `${refreshJobStorageKey()}:last-shown`
    const shouldShowSummary = sessionStorage.getItem(lastShownJobKey) !== job.jobId
    sessionStorage.setItem(`${refreshJobStorageKey()}:last`, job.jobId)
    refreshWxCodesPollWarning.value = ''
    const accountRefreshFailed = !await accountStore.fetchAccounts({ force: true })
    if (generation !== refreshPollGeneration)
      return
    refreshWxCodesLoading.value = false
    if (!shouldShowSummary)
      return
    sessionStorage.setItem(lastShownJobKey, job.jobId)
    if (accountRefreshFailed) {
      const outcome = job.state === 'completed' ? '已完成' : job.state === 'interrupted' ? '已中断' : '异常中止'
      showAlert(`Code 刷新任务${outcome}，但账号列表更新失败；请重新加载账号列表。`, 'danger')
      return
    }
    showRefreshSummary(job)
  }

  async function pollRefreshJob(generation: number, failedAttempts = 0) {
    if (generation !== refreshPollGeneration || refreshPollsInFlight.has(generation))
      return
    const savedTask = sessionStorage.getItem(refreshJobStorageKey()) || ''
    if (!savedTask.startsWith('job:'))
      return
    refreshPollsInFlight.add(generation)
    try {
      const response = await accountStore.getWxCodeRefreshJob(savedTask.slice(4))
      if (generation !== refreshPollGeneration)
        return
      const job = response.data
      if (!response.ok || !job)
        throw new Error(response.error || '读取刷新进度失败')
      refreshWxCodesProgress.value = job
      refreshWxCodesPollWarning.value = ''
      if (job.state === 'completed' || job.state === 'failed' || job.state === 'interrupted') {
        await finishRefreshJob(job, generation)
        return
      }
      scheduleRefreshPoll(generation, 1000, 0)
    }
    catch (error: any) {
      if (generation !== refreshPollGeneration)
        return
      if (error.response?.status === 404) {
        clearSavedRefreshTask()
        sessionStorage.removeItem(`${refreshJobStorageKey()}:last`)
        refreshWxCodesLoading.value = false
        refreshWxCodesPollWarning.value = ''
        refreshWxCodesProgress.value = null
        await accountStore.fetchAccounts()
        showAlert('刷新任务已中断或过期，账号状态已更新；请确认后重新发起刷新。', 'danger')
        return
      }
      if (error.response?.status === 401 || error.response?.status === 403) {
        refreshWxCodesLoading.value = false
        refreshWxCodesPollWarning.value = '登录状态暂不可用，请重新登录后回到本页继续查看任务'
        return
      }
      refreshWxCodesPollWarning.value = '连接暂时中断，正在重试查询进度'
      const nextDelay = Math.min(10000, 1000 * 2 ** Math.min(failedAttempts, 4))
      scheduleRefreshPoll(generation, nextDelay, failedAttempts + 1)
    }
    finally {
      refreshPollsInFlight.delete(generation)
    }
  }

  async function startOrResumeRefreshRequest(requestId: string, generation: number, failedAttempts = 0) {
    refreshWxCodesLoading.value = true
    refreshWxCodesPollWarning.value = ''
    try {
      const retryJobId = sessionStorage.getItem(`${refreshJobStorageKey()}:retry`) || undefined
      const response = await accountStore.startWxCodeRefresh(requestId, retryJobId)
      if (generation !== refreshPollGeneration)
        return
      const job = response.data as RefreshWxCodesJob | RefreshWxCodesResult | undefined
      if (job && 'jobId' in job) {
        sessionStorage.setItem(refreshJobStorageKey(), `job:${job.jobId}`)
        refreshWxCodesProgress.value = job
        void pollRefreshJob(generation)
      }
      else {
        clearSavedRefreshTask()
        refreshWxCodesLoading.value = false
        showAlert(response.error || '没有可刷新的微信账号', 'danger')
      }
    }
    catch (error: any) {
      if (generation !== refreshPollGeneration)
        return
      const status = Number(error.response?.status || 0)
      const transient = !status || status === 408 || status === 429 || status >= 500
      if (!transient) {
        if (status !== 401 && status !== 403)
          clearSavedRefreshTask()
        refreshWxCodesLoading.value = false
        refreshWxCodesPollWarning.value = status === 401 || status === 403
          ? '登录状态暂不可用，请重新登录后回到本页继续查看任务'
          : ''
        showAlert(getApiErrorMessage(error, '刷新任务提交失败'), 'danger')
        return
      }
      refreshWxCodesLoading.value = true
      refreshWxCodesPollWarning.value = '提交结果未确认，正在重试'
      scheduleRefreshRequestRetry(requestId, generation, failedAttempts + 1)
    }
  }

  async function refreshWxCodesNow() {
    if (refreshWxCodesLoading.value)
      return
    clearRefreshPollTimer()
    const generation = ++refreshPollGeneration
    const savedTask = sessionStorage.getItem(refreshJobStorageKey()) || ''
    if (savedTask.startsWith('job:')) {
      refreshWxCodesLoading.value = true
      void pollRefreshJob(generation)
      return
    }
    refreshWxCodesProgress.value = null
    const requestId = savedTask.startsWith('request:') ? savedTask.slice(8) : createRefreshRequestId()
    sessionStorage.setItem(refreshJobStorageKey(), `request:${requestId}`)
    await startOrResumeRefreshRequest(requestId, generation)
  }

  async function retryFailedRefresh() {
    const job = refreshWxCodesProgress.value
    if (refreshWxCodesLoading.value || !job?.retryableAccountIds?.length)
      return
    sessionStorage.setItem(`${refreshJobStorageKey()}:retry`, job.jobId)
    await refreshWxCodesNow()
  }

  function resumeSavedRefreshTask() {
    let savedTask = sessionStorage.getItem(refreshJobStorageKey()) || ''
    if (!savedTask) {
      const lastJobId = sessionStorage.getItem(`${refreshJobStorageKey()}:last`)
      if (lastJobId) {
        savedTask = `job:${lastJobId}`
        sessionStorage.setItem(refreshJobStorageKey(), savedTask)
      }
    }
    if (!savedTask)
      return
    const generation = ++refreshPollGeneration
    refreshWxCodesLoading.value = true
    if (savedTask.startsWith('job:')) {
      void pollRefreshJob(generation)
      return
    }
    if (savedTask.startsWith('request:'))
      void startOrResumeRefreshRequest(savedTask.slice(8), generation)
  }

  resumeSavedRefreshTask()
  onScopeDispose(() => {
    accountsPollDisposed = true
    if (accountsPollTimer !== null)
      clearTimeout(accountsPollTimer)
    refreshPollGeneration++
    clearRefreshPollTimer()
  })

  function handleSaved() {
    accountStore.fetchAccounts()
  }

  // 应用宝账号保存或启动后刷新列表并选中账号，保持弹窗打开
  async function handleAccountRefreshed(accountId?: string) {
    await accountStore.fetchAccounts()
    if (accountId)
      accountStore.selectAccount(String(accountId))
  }

  function selectAccount(account: any) {
    if (!account || !account.id)
      return
    accountStore.selectAccount(String(account.id))
  }

  function openClearStoppedConfirm() {
    if (stoppedAccountsCount.value === 0) {
      showAlert('没有已停止的账号需要清理', 'primary')
      return
    }
    clearStoppedCandidates.value = stoppedAccounts.value.map(acc => ({ id: String(acc.id), name: acc.name || acc.nick || String(acc.id) }))
    showClearStoppedConfirm.value = true
  }

  async function confirmClearStopped() {
    if (clearStoppedLoading.value)
      return
    clearStoppedLoading.value = true
    try {
      const candidates = [...clearStoppedCandidates.value]
      let deletedCount = 0
      const failures: string[] = []
      for (const account of candidates) {
        try {
          await accountStore.deleteAccount(account.id, { onlyStopped: true, refresh: false })
          deletedCount++
        }
        catch (error) {
          failures.push(`${account.name}：${getApiErrorMessage(error, '清理失败')}`)
        }
      }
      showClearStoppedConfirm.value = false
      const updated = await accountStore.fetchAccounts({ force: true })
      showAlert(`成功清理 ${deletedCount} 个账号${failures.length ? `，跳过或失败 ${failures.length} 个\n${failures.join('\n')}` : ''}${updated ? '' : '\n账号列表更新失败，已保留上次数据。'}`, failures.length || !updated ? 'danger' : 'primary')
    }
    finally {
      clearStoppedLoading.value = false
    }
  }

  return {
    accounts,
    accountsLoading,
    accountsError,
    currentAccountId,
    currentAccountName,
    userIsAdmin,
    showModal,
    showDeleteConfirm,
    deleteLoading,
    editingAccount,
    accountToDelete,
    showClearStoppedConfirm,
    clearStoppedLoading,
    clearStoppedMessage,
    refreshWxCodesLoading,
    refreshWxCodesProgress,
    refreshWxCodesPollWarning,
    stoppedAccountsCount,
    isAddAccountDisabled,
    addAccountDisabledReason,
    isAccountOpsDisabled,
    fetchAccounts,
    selectFirstAccountIfNeeded,
    openSettings,
    openAddModal,
    openEditModal,
    handleDelete,
    confirmDelete,
    toggleAccount,
    refreshWxCodesNow,
    retryFailedRefresh,
    handleSaved,
    handleAccountRefreshed,
    selectAccount,
    openClearStoppedConfirm,
    confirmClearStopped,
  }
}
