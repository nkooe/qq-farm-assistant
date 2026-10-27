<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseTextarea from '@/components/ui/BaseTextarea.vue'
import ModalOverlay from '@/components/ui/ModalOverlay.vue'

const props = defineProps<{
  show: boolean
  editData?: any
  // 打开时默认选中的登录方式
  defaultTab?: 'manual' | 'yyb'
  // 更新已有应用宝账号时，禁止扫码后误新增其他微信身份
  yybUpdateOnly?: boolean
}>()

const emit = defineEmits(['close', 'saved', 'refresh'])
const CODE_QUERY_RE = /[?&]code=([^&]+)/i

type AccountTab = 'manual' | 'yyb'
type YybLoginStage = 'idle' | 'creating' | 'pending' | 'scanned' | 'unknown' | 'authorized' | 'importing' | 'starting' | 'success' | 'expired' | 'error'

interface YybAccountResult {
  openid: string
  nickname?: string
  alias?: string
  status?: string
}

interface YybProxyProfile {
  id: number
  name: string
  protocol: 'http-connect' | 'socks5'
  host: string
  port: number
}

const activeTab = ref<AccountTab>('manual')
const loading = ref(false)
const errorMessage = ref('')
const yybAccountName = ref('')
const yybStage = ref<YybLoginStage>('idle')
const yybQrImage = ref('')
const yybError = ref('')
const yybPollErrCode = ref<number | null>(null)
const yybSuccess = ref<{ accountId: string, name: string, isUpdate: boolean, status: 'saved' | 'starting' | 'online' | 'failed' } | null>(null)
const yybStartError = ref('')
const yybProxyProfiles = ref<YybProxyProfile[]>([])
const yybProxyMode = ref<'direct' | 'static'>('direct')
const yybProxyProfileId = ref<number | null>(null)
const yybProxyLoading = ref(false)
const yybProxyReady = ref(false)
const yybProxyError = ref('')
let yybPollVersion = 0
let yybPollController: AbortController | null = null
let yybProxyLoadVersion = 0
let yybAutoStartVersion = 0
let yybProxyOptionsReady: Promise<void> = Promise.resolve()
let yybCreateController: AbortController | null = null
let yybRuntimeController: AbortController | null = null
let yybProxyChangeTimer: ReturnType<typeof setTimeout> | null = null

const form = reactive({
  name: '',
  code: '',
  platform: 'qq' as 'qq' | 'wx',
})

const yybStatusText = computed(() => {
  const labels: Record<YybLoginStage, string> = {
    idle: '准备扫码',
    creating: '正在生成二维码',
    pending: '请使用微信扫码',
    scanned: '已扫码，请在手机确认',
    unknown: yybPollErrCode.value === null
      ? '暂时无法识别扫码状态，仍在查询；也可重新生成'
      : `暂时无法识别扫码状态（${yybPollErrCode.value}），仍在查询；也可重新生成`,
    authorized: '授权成功，正在获取账号',
    importing: '正在写入 Code 并启动账号',
    starting: '账号已保存，正在连接游戏',
    success: '游戏已上线',
    expired: '二维码已失效',
    error: '扫码登录失败',
  }
  return labels[yybStage.value]
})

const yybBusy = computed(() => ['creating', 'authorized', 'importing', 'starting'].includes(yybStage.value))
const yybProxyLocked = computed(() => ['authorized', 'importing', 'starting'].includes(yybStage.value))

function getRequestError(error: any, fallback: string) {
  return String(error?.response?.data?.error || error?.response?.data?.message || error?.message || fallback)
}

function stopYybPolling() {
  yybPollVersion += 1
  yybPollController?.abort()
  yybPollController = null
}

function resetYybLogin() {
  if (yybProxyChangeTimer !== null)
    clearTimeout(yybProxyChangeTimer)
  yybProxyChangeTimer = null
  yybCreateController?.abort()
  yybRuntimeController?.abort()
  yybAutoStartVersion += 1
  stopYybPolling()
  yybStage.value = 'idle'
  yybQrImage.value = ''
  yybError.value = ''
  yybPollErrCode.value = null
  yybSuccess.value = null
  yybStartError.value = ''
}

async function loadYybProxyOptions() {
  const version = ++yybProxyLoadVersion
  yybProxyLoading.value = true
  yybProxyReady.value = false
  yybProxyError.value = ''
  try {
    const response = await api.get('/api/yyb/proxy-profiles')
    if (version !== yybProxyLoadVersion)
      return
    if (response.data?.ok === false || !Array.isArray(response.data?.data))
      throw new Error('代理配置列表读取失败')
    let mode: 'direct' | 'static' = 'direct'
    let profileId: number | null = null
    const openid = String(props.editData?.yybOpenid || '').trim()
    if (openid) {
      const settingResponse = await api.get('/api/yyb/account-proxy', { params: { ref: openid } })
      if (version !== yybProxyLoadVersion)
        return
      const setting = settingResponse.data?.data || {}
      if (settingResponse.data?.ok === false || !['direct', 'static'].includes(setting.mode))
        throw new Error('账号代理设置读取失败')
      mode = setting.mode
      profileId = Number(setting.proxy_profile_id) || null
    }
    yybProxyProfiles.value = response.data.data
    yybProxyMode.value = mode
    yybProxyProfileId.value = profileId
    yybProxyReady.value = true
  }
  catch (error: any) {
    if (version !== yybProxyLoadVersion)
      return
    yybProxyError.value = getRequestError(error, '代理设置读取失败，请重试；扫码已暂停')
  }
  finally {
    if (version === yybProxyLoadVersion)
      yybProxyLoading.value = false
  }
}

async function startYybLoginWhenReady(version: number) {
  await yybProxyOptionsReady
  if (version !== yybAutoStartVersion || !props.show || activeTab.value !== 'yyb' || yybStage.value !== 'idle' || !yybProxyReady.value)
    return
  void startYybLogin()
}

function scheduleYybLogin() {
  void startYybLoginWhenReady(yybAutoStartVersion)
}

async function retryYybProxyOptions() {
  yybProxyOptionsReady = loadYybProxyOptions()
  await yybProxyOptionsReady
  scheduleYybLogin()
}

function changeYybProxy() {
  if (yybProxyLocked.value || !yybProxyReady.value)
    return
  resetYybLogin()
  yybProxyChangeTimer = setTimeout(() => {
    yybProxyChangeTimer = null
    scheduleYybLogin()
  }, 300)
}

function waitYybRetry(signal: AbortSignal, delay: number) {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout>
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    timer = setTimeout(finish, delay)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted)
      finish()
  })
}

async function startSavedYybAccount(version = yybPollVersion) {
  const saved = yybSuccess.value
  if (!saved || saved.status === 'starting')
    return
  yybRuntimeController?.abort()
  const controller = new AbortController()
  yybRuntimeController = controller
  saved.status = 'starting'
  yybStage.value = 'starting'
  yybStartError.value = ''
  try {
    const response = await api.post(`/api/accounts/${encodeURIComponent(saved.accountId)}/start`, {}, { timeout: 15000, signal: controller.signal })
    if (response.data?.ok !== true)
      throw new Error(response.data?.error || '启动请求失败')
    const deadline = Date.now() + 90000
    while (true) {
      if (controller.signal.aborted || version !== yybPollVersion || !props.show)
        return
      try {
        const { data } = await api.get(`/api/accounts/${encodeURIComponent(saved.accountId)}/runtime`, { timeout: 8000, signal: controller.signal })
        if (controller.signal.aborted || version !== yybPollVersion)
          return
        if (data?.ok !== true)
          throw new Error(data?.error || '无法读取启动状态')
        const runtime = data.data || {}
        if (runtime.connected === true) {
          saved.status = 'online'
          yybStage.value = 'success'
          emit('refresh', saved.accountId)
          return
        }
        if (['failed', 'stopped'].includes(runtime.state))
          throw new Error(runtime.error || '账号未能启动，请重试启动')
        if (runtime.state === 'reconnecting')
          throw new Error(`${runtime.error || '启动暂未成功'}；已安排自动重连，可在账号管理查看进度`)
      }
      catch (error: any) {
        if (error?.code === 'ERR_CANCELED' || controller.signal.aborted)
          return
        // Transport failures may hide a successful background startup. Recheck
        // until the bounded deadline rather than claiming the account is online.
        if (error?.response || !error?.request)
          throw error
      }
      if (Date.now() >= deadline)
        throw new Error('等待游戏上线超时，账号已保存；可重试启动或在账号管理查看状态')
      await waitYybRetry(controller.signal, 2000)
    }
  }
  catch (error: any) {
    if (controller.signal.aborted || version !== yybPollVersion)
      return
    saved.status = 'failed'
    yybStage.value = 'error'
    yybStartError.value = getRequestError(error, '账号已保存，启动失败，请重试启动')
    emit('refresh', saved.accountId)
  }
}

async function importYybAccount(sessionId: string, version: number) {
  if (version !== yybPollVersion)
    return
  yybStage.value = 'authorized'

  const confirmResponse = await api.post('/api/yyb/qr/confirm', { sessionId }, { timeout: 60000 })
  if (version !== yybPollVersion)
    return
  const yybAccount = confirmResponse.data?.data as YybAccountResult | undefined
  const openid = String(yybAccount?.openid || '').trim()
  if (!openid)
    throw new Error('应用宝未返回 openid')
  const expectedOpenid = String(props.editData?.yybOpenid || '').trim()
  if (props.yybUpdateOnly && expectedOpenid && openid !== expectedOpenid)
    throw new Error('扫码微信与当前应用宝账号不一致，请使用原微信重新扫码')

  yybStage.value = 'importing'
  const codeResponse = await api.post('/api/yyb/getcode', { openid }, { timeout: 60000 })
  if (version !== yybPollVersion)
    return
  const code = String(codeResponse.data?.data?.code || '').trim()
  if (!code)
    throw new Error('应用宝未返回登录 Code')

  const accountsResponse = await api.get('/api/accounts')
  if (version !== yybPollVersion)
    return
  const accounts = Array.isArray(accountsResponse.data?.data?.accounts)
    ? accountsResponse.data.data.accounts
    : []
  // Match the scanned identity, never the record currently open for editing.
  const matchedAccount = accounts.find((account: any) =>
    account.provider !== 'thirdparty' && String(account.yybOpenid || '').trim() === openid,
  )
  const enteredName = yybAccountName.value.trim()
  const inheritedEditName = props.editData
    && enteredName === String(props.editData.name || '').trim()
    && String(matchedAccount?.id || '') !== String(props.editData.id)
  const accountName = (inheritedEditName ? '' : enteredName)
    || String(matchedAccount?.name || yybAccount?.nickname || yybAccount?.alias || '').trim()
    || `应用宝账号 ${openid.slice(-6)}`

  const saveResponse = await api.post('/api/accounts', {
    ...(matchedAccount?.id ? { id: matchedAccount.id } : {}),
    name: accountName,
    code,
    platform: 'wx',
    loginType: 'yyb',
    provider: 'builtin',
    yybOpenid: openid,
  })
  if (!saveResponse.data?.ok)
    throw new Error(saveResponse.data?.error || '保存应用宝账号失败')
  if (version !== yybPollVersion)
    return

  const savedAccounts = Array.isArray(saveResponse.data?.data?.accounts)
    ? saveResponse.data.data.accounts
    : []
  const savedAccount = matchedAccount?.id
    ? savedAccounts.find((account: any) => String(account.id) === String(matchedAccount.id))
    : savedAccounts.find((account: any) =>
        account.provider !== 'thirdparty' && String(account.yybOpenid || '').trim() === openid,
      )
  const accountId = String(savedAccount?.id || matchedAccount?.id || '')
  if (!accountId)
    throw new Error('账号已保存，但未能确认账号 ID')

  yybSuccess.value = {
    accountId,
    name: accountName,
    isUpdate: !!matchedAccount,
    status: 'saved',
  }
  yybQrImage.value = ''
  emit('refresh', accountId)
  await startSavedYybAccount(version)
}

async function pollYybLogin(sessionId: string, version: number) {
  let failures = 0
  while (true) {
    if (version !== yybPollVersion || !props.show || activeTab.value !== 'yyb')
      return

    const controller = new AbortController()
    yybPollController = controller
    try {
      const response = await api.post('/api/yyb/qr/poll', { sessionId }, {
        timeout: 70000,
        signal: controller.signal,
      })
      if (version !== yybPollVersion)
        return
      failures = 0
      yybError.value = ''

      const status = String(response.data?.data?.status || 'unknown')
      const rawErrCode = response.data?.data?.errcode
      yybPollErrCode.value = typeof rawErrCode === 'number' ? rawErrCode : null
      if (status === 'authorized' || status === 'confirmed') {
        await importYybAccount(sessionId, version)
        return
      }
      if (status === 'expired' || status === 'cancelled') {
        yybStage.value = 'expired'
        yybError.value = status === 'cancelled' ? '已在手机端取消，请重新生成二维码' : '微信确认二维码已过期，请重新生成'
        return
      }
      yybStage.value = status === 'scanned' ? 'scanned' : status === 'pending' ? 'pending' : 'unknown'
    }
    catch (error: any) {
      if (error?.code === 'ERR_CANCELED' || version !== yybPollVersion)
        return
      const transient = !error?.response || error.response.status >= 500
      if (!['authorized', 'importing'].includes(yybStage.value) && transient && ++failures <= 3) {
        yybStage.value = 'unknown'
        yybPollErrCode.value = null
      }
      else {
        yybStage.value = 'error'
        yybError.value = getRequestError(error, '查询扫码状态失败，请重试')
        return
      }
    }
    // Long polls can also return immediately; pace retries and cancel the delay
    // when closing the modal or replacing the QR session.
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>
      const finish = () => {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', finish)
        resolve()
      }
      timer = setTimeout(finish, 1500 * Math.max(1, failures))
      controller.signal.addEventListener('abort', finish, { once: true })
      if (controller.signal.aborted)
        finish()
    })
  }
}

async function startYybLogin() {
  if (!yybProxyReady.value || yybProxyLoading.value)
    return
  if (yybProxyMode.value === 'static' && !yybProxyProfileId.value) {
    yybStage.value = 'error'
    yybError.value = '请选择静态代理配置后再生成二维码'
    return
  }
  resetYybLogin()
  yybStage.value = 'creating'
  const controller = new AbortController()
  yybCreateController = controller
  const version = yybPollVersion
  try {
    const response = await api.post('/api/yyb/qr/create', {
      proxyMode: yybProxyMode.value,
      proxyProfileId: yybProxyMode.value === 'static' ? yybProxyProfileId.value : null,
    }, { timeout: 60000, signal: controller.signal })
    const sessionId = String(response.data?.data?.session_id || '').trim()
    const image = String(response.data?.data?.image_base64 || '').trim()
    if (!sessionId || !image)
      throw new Error('应用宝未返回有效二维码')
    if (version !== yybPollVersion)
      return
    yybQrImage.value = image
    yybStage.value = 'pending'
    void pollYybLogin(sessionId, version)
  }
  catch (error: any) {
    if (error?.code === 'ERR_CANCELED' || version !== yybPollVersion)
      return
    yybStage.value = 'error'
    yybError.value = getRequestError(error, '生成应用宝二维码失败，请确认服务已启动')
  }
}

async function addAccount(data: any) {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await api.post('/api/accounts', data)
    if (res.data.ok) {
      emit('saved')
      close()
    }
    else {
      errorMessage.value = `保存失败: ${res.data.error}`
    }
  }
  catch (e: any) {
    errorMessage.value = `保存失败: ${e.response?.data?.error || e.message}`
  }
  finally {
    loading.value = false
  }
}

async function submitManual() {
  errorMessage.value = ''
  if (!form.code) {
    errorMessage.value = '请输入 Code'
    return
  }

  let code = form.code.trim()
  const match = code.match(CODE_QUERY_RE)
  if (match && match[1]) {
    code = decodeURIComponent(match[1])
    form.code = code
  }

  let payload: any = {}
  if (props.editData) {
    const onlyNameChanged = form.name !== props.editData.name
      && form.code === (props.editData.code || '')
      && form.platform === (props.editData.platform || 'qq')

    if (onlyNameChanged) {
      payload = { id: props.editData.id, name: form.name }
    }
    else {
      payload = {
        id: props.editData.id,
        name: form.name,
        code,
        platform: form.platform,
        loginType: 'manual',
      }
    }
  }
  else {
    payload = {
      name: form.name,
      code,
      platform: form.platform,
      loginType: 'manual',
    }
  }

  await addAccount(payload)
}

function close() {
  resetYybLogin()
  emit('close')
}

watch(() => props.show, (newVal) => {
  if (newVal) {
    errorMessage.value = ''
    yybAccountName.value = props.editData?.name || ''
    resetYybLogin()
    yybProxyOptionsReady = loadYybProxyOptions()
    form.name = props.editData?.name || ''
    form.code = props.editData?.code || ''
    form.platform = props.editData?.platform || 'qq'
    activeTab.value = props.defaultTab || 'manual'
    if (activeTab.value === 'yyb')
      scheduleYybLogin()
  }
  else {
    resetYybLogin()
  }
})

watch(activeTab, (tab) => {
  if (tab === 'yyb')
    scheduleYybLogin()
  else
    resetYybLogin()
})

onBeforeUnmount(() => {
  resetYybLogin()
  yybProxyLoadVersion += 1
})
</script>

<template>
  <ModalOverlay :show="show" :title="editData ? '编辑账号' : '添加账号'" :busy="loading" @close="close">
    <div class="ui-dialog-panel max-w-md w-full">
      <div class="flex items-center justify-between border-b p-4" :style="{ borderColor: 'color-mix(in srgb, var(--theme-text) 10%, transparent)' }">
        <h3 class="text-lg font-semibold" :style="{ color: 'var(--theme-text)' }">
          {{ editData ? '编辑账号' : '添加账号' }}
        </h3>
        <BaseButton variant="ghost" class="!h-11 !w-11 !p-0" title="关闭账号窗口" @click="close">
          <div class="i-carbon-close text-xl" :style="{ color: 'var(--theme-text)' }" />
        </BaseButton>
      </div>

      <div class="ui-dialog-body">
        <div v-if="errorMessage" class="mb-4 rounded p-3 text-sm" :style="{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444' }">
          {{ errorMessage }}
        </div>

        <div class="mb-4 flex border-b" role="tablist" aria-label="账号登录方式" :style="{ borderColor: 'color-mix(in srgb, var(--theme-text) 10%, transparent)' }">
          <button
            type="button"
            role="tab"
            :aria-selected="activeTab === 'manual'"
            class="min-h-11 flex-1 px-1 text-center text-sm font-medium transition-colors"
            :class="activeTab === 'manual' ? 'border-b-2' : 'opacity-60'"
            :style="{
              color: activeTab === 'manual' ? 'var(--theme-primary)' : 'var(--theme-text)',
              borderColor: 'var(--theme-primary)',
            }"
            @click="activeTab = 'manual'"
          >
            手动填码
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="activeTab === 'yyb'"
            class="min-h-11 flex-1 px-1 text-center text-sm font-medium transition-colors"
            :class="activeTab === 'yyb' ? 'border-b-2' : 'opacity-60'"
            :style="{
              color: activeTab === 'yyb' ? 'var(--theme-primary)' : 'var(--theme-text)',
              borderColor: 'var(--theme-primary)',
            }"
            @click="activeTab = 'yyb'"
          >
            应用宝扫码
          </button>
        </div>

        <div v-if="activeTab === 'yyb'" class="space-y-4">
          <template v-if="yybSuccess">
            <div class="flex flex-col items-center gap-3 py-4">
              <div class="h-16 w-16 flex items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
                <span class="i-carbon-checkmark-filled text-4xl text-green-600 dark:text-green-400" />
              </div>
              <div class="text-center">
                <div class="text-base font-semibold" :style="{ color: 'var(--theme-text)' }">
                  {{ yybSuccess.isUpdate ? '应用宝账号已更新' : '应用宝账号已添加' }}
                </div>
                <div class="mt-1 break-all text-sm opacity-70" :style="{ color: 'var(--theme-text)' }">
                  {{ yybSuccess.name }}
                </div>
              </div>
            </div>

            <div class="flex items-start gap-2 border border-green-200 rounded-lg bg-green-50 px-3 py-3 text-sm text-green-800 leading-6 dark:border-green-800 dark:bg-green-900/20 dark:text-green-200">
              <span class="i-carbon-renew mt-1 flex-none" />
              <span aria-live="polite">
                {{ yybSuccess.status === 'online' ? '游戏已上线；后续启动和断线重连会自动刷新 Code。' : yybSuccess.status === 'starting' ? '账号和 Code 已保存，正在连接游戏，请稍候…' : '账号和 Code 已保存，可直接重试启动，无需重新扫码。' }}
              </span>
            </div>

            <div v-if="yybStartError" role="alert" class="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
              {{ yybStartError }}
            </div>

            <div class="flex flex-wrap justify-end gap-2 pt-1">
              <BaseButton v-if="yybSuccess.status !== 'online'" variant="primary" :loading="yybSuccess.status === 'starting'" @click="startSavedYybAccount()">
                {{ yybSuccess.status === 'starting' ? '正在连接游戏' : '重试启动' }}
              </BaseButton>
              <BaseButton :variant="yybSuccess.status === 'online' ? 'primary' : 'outline'" @click="close">
                {{ yybSuccess.status === 'online' ? '完成' : yybSuccess.status === 'starting' ? '关闭（后台继续启动）' : '关闭' }}
              </BaseButton>
            </div>
          </template>

          <template v-else>
            <div
              v-if="yybUpdateOnly"
              class="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-200"
            >
              此操作只更新当前应用宝账号。请使用原微信扫码；若扫码身份不匹配，不会新增账号。
            </div>
            <BaseInput
              v-model="yybAccountName"
              label="账号备注（可选）"
              placeholder="留空则使用微信昵称"
              :disabled="yybProxyLocked"
            />

            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label class="block">
                <span class="mb-1.5 block text-sm font-medium" :style="{ color: 'var(--theme-text)' }">连接模式</span>
                <select
                  v-model="yybProxyMode"
                  :disabled="yybProxyLoading || !yybProxyReady || yybProxyLocked"
                  @change="changeYybProxy"
                  class="min-h-11 w-full border border-gray-200 rounded-lg bg-transparent px-3 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700"
                >
                  <option value="direct">直连</option>
                  <option value="static">静态代理</option>
                </select>
              </label>
              <label class="block">
                <span class="mb-1.5 block text-sm font-medium" :style="{ color: 'var(--theme-text)' }">代理配置</span>
                <select
                  v-model.number="yybProxyProfileId"
                  :disabled="yybProxyMode !== 'static' || yybProxyLoading || !yybProxyReady || yybProxyLocked"
                  @change="changeYybProxy"
                  class="min-h-11 w-full border border-gray-200 rounded-lg bg-transparent px-3 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700"
                >
                  <option :value="null">{{ yybProxyProfiles.length ? '请选择代理' : '请先到代理设置添加' }}</option>
                  <option v-for="profile in yybProxyProfiles" :key="profile.id" :value="profile.id">
                    {{ profile.name }}（{{ profile.host }}:{{ profile.port }}）
                  </option>
                </select>
              </label>
            </div>

            <div v-if="yybProxyError" role="alert" class="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
              <p>{{ yybProxyError }}。为避免出口改变，暂不生成二维码。</p>
              <BaseButton variant="outline" class="mt-2" :loading="yybProxyLoading" @click="retryYybProxyOptions">重新读取代理设置</BaseButton>
            </div>
            <div class="rounded-lg px-3 py-2 text-xs leading-5" style="background-color: color-mix(in srgb, var(--theme-primary) 8%, transparent); color: var(--theme-text);">
              扫码、凭据刷新、Code 获取和协议连接均使用此账号出口；静态代理故障时不会自动回退直连。
              切换代理会自动更换二维码，请扫描新码。
            </div>

            <div
              v-if="yybError"
              role="alert"
              class="rounded-lg bg-red-50 p-3 text-sm text-red-700 leading-6 dark:bg-red-900/20 dark:text-red-300"
            >
              {{ yybError }}
            </div>

            <div v-if="yybQrImage" class="mx-auto aspect-square max-w-60 w-full overflow-hidden border border-gray-200 rounded-lg bg-white p-2 dark:border-gray-700">
              <img
                :src="yybQrImage"
                alt="应用宝微信登录二维码"
                class="h-full w-full object-contain"
                width="224"
                height="224"
              >
            </div>
            <div v-else class="mx-auto aspect-square max-w-60 w-full flex items-center justify-center border border-gray-200 rounded-lg bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
              <span
                class="text-5xl"
                :class="yybBusy ? 'i-svg-spinners-ring-resize animate-spin' : 'i-carbon-qr-code'"
                :style="{ color: 'var(--theme-primary)' }"
              />
            </div>

            <div
              aria-live="polite"
              class="min-h-11 flex items-center justify-center gap-2 rounded-lg px-3 text-center text-sm font-medium"
              :style="{
                backgroundColor: yybStage === 'unknown'
                  ? 'color-mix(in srgb, #d97706 12%, transparent)'
                  : 'color-mix(in srgb, var(--theme-primary) 10%, transparent)',
                color: 'var(--theme-text)',
              }"
            >
              <span v-if="yybStage === 'scanned'" class="i-carbon-mobile-check" :style="{ color: 'var(--theme-primary)' }" />
              <span v-else-if="yybStage === 'unknown'" class="i-carbon-warning-alt" style="color: #b45309" />
              <span v-else-if="yybBusy" class="i-svg-spinners-ring-resize animate-spin" :style="{ color: 'var(--theme-primary)' }" />
              <span v-else class="i-carbon-scan" :style="{ color: 'var(--theme-primary)' }" />
              <span>{{ yybStatusText }}</span>
            </div>

            <div class="flex flex-wrap justify-end gap-2 pt-1">
              <BaseButton variant="outline" @click="close">
                取消
              </BaseButton>
              <BaseButton
                variant="primary"
                :loading="yybBusy || yybProxyLoading"
                :disabled="!yybProxyReady"
                @click="startYybLogin"
              >
                <span v-if="yybStage !== 'idle'" class="i-carbon-renew mr-1" />
                {{ yybStage === 'idle' ? '准备二维码…' : '重新生成' }}
              </BaseButton>
            </div>
          </template>
        </div>

        <div v-if="activeTab === 'manual'" class="space-y-4">
          <BaseInput
            v-model="form.name"
            label="账号备注（可选）"
            placeholder="留空则使用默认账号名"
          />

          <BaseTextarea
            v-model="form.code"
            label="Code"
            placeholder="请输入登录 Code"
            :rows="3"
          />

          <div v-if="!editData" class="flex gap-4">
            <label class="flex cursor-pointer items-center gap-2">
              <input
                v-model="form.platform"
                type="radio"
                value="qq"
                class="h-4 w-4"
                :style="{ accentColor: 'var(--theme-primary)' }"
              >
              <span class="text-sm" :style="{ color: 'var(--theme-text)' }">QQ 小程序</span>
            </label>
            <label class="flex cursor-pointer items-center gap-2">
              <input
                v-model="form.platform"
                type="radio"
                value="wx"
                class="h-4 w-4"
                :style="{ accentColor: 'var(--theme-primary)' }"
              >
              <span class="text-sm" :style="{ color: 'var(--theme-text)' }">微信小程序</span>
            </label>
          </div>

          <div class="flex justify-end gap-2 pt-4">
            <BaseButton variant="outline" @click="close">
              取消
            </BaseButton>
            <BaseButton variant="primary" :loading="loading" @click="submitManual">
              {{ editData ? '保存' : '添加' }}
            </BaseButton>
          </div>
        </div>
      </div>
    </div>
  </ModalOverlay>
</template>
