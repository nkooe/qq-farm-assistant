<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'

const props = defineProps<{ account: any, defaultExpanded?: boolean }>()
const expanded = ref(!!props.defaultExpanded)
const loading = ref(false)
const health = ref<any>(null)
const error = ref('')
const now = ref(Date.now())
let requestVersion = 0
let controller: AbortController | null = null

const runtimeLabel = computed(() => {
  const state = props.account?.runtimeState || health.value?.runtime?.state
  return ({ online: '游戏已上线', starting: '正在连接游戏', reconnecting: '等待自动重连', failed: '连接失败', stopped: '已停止', stopping: '正在停止' } as Record<string, string>)[state]
    || (props.account?.connected ? '游戏已上线' : props.account?.running ? '正在连接游戏' : '已停止')
})
const reconnect = computed(() => props.account && 'runtimeReconnect' in props.account ? props.account.runtimeReconnect : health.value?.runtime?.reconnect)
const runtimeError = computed(() => props.account?.runtimeState ? props.account.runtimeError || '' : health.value?.runtime?.error)
const loginState = computed(() => props.account && 'runtimeLogin' in props.account ? props.account.runtimeLogin : health.value?.runtime?.login)
const loginLabel = computed(() => {
  const task = loginState.value
  if (!task)
    return ''
  if (task.state === 'queued')
    return '等待取码：正在排队，尚未开始登录'
  if (task.state === 'requesting')
    return '正在恢复登录并获取新 Code'
  if (task.state === 'cancelled')
    return '取码已取消'
  if (task.state === 'success')
    return `最近取码成功，用时 ${Math.ceil((task.durationMs || 0) / 1000)} 秒`
  return ({ rescan: '登录态需要重新验证，请扫码更新', proxy: '代理异常，请检查所选代理', busy: '取码服务忙碌，等待重试', timeout: '取码超时，等待重试', configuration: '登录配置异常，请检查设置' } as Record<string, string>)[task.kind] || '取码暂时失败，请查看连接错误'
})
const reconnectLabel = computed(() => {
  const plan = reconnect.value
  if (!plan)
    return ''
  if (plan.state === 'scheduled') {
    const seconds = Math.max(0, Math.ceil((plan.nextRetryAt - now.value) / 1000))
    return plan.kind === 'busy' ? `取码服务忙碌，约 ${seconds} 秒后重试，不计入失败次数` : `第 ${plan.attempt}/${plan.maxAttempts} 次重连，约 ${seconds} 秒后执行`
  }
  if (plan.state === 'needs_rescan')
    return '需要扫码更新，自动重试已暂停'
  if (plan.state === 'blocked')
    return '请检查登录配置，自动重试已暂停'
  return plan.state === 'waiting_credentials' ? '游戏重试已结束，等待后台凭据恢复后自动启动' : `自动重连已达上限（${plan.attempt}/${plan.maxAttempts}）`
})
const credentialLabel = computed(() => {
  const credentials = health.value?.credentials
  if (!credentials)
    return '暂时无法读取'
  if (credentials.needs_rescan)
    return '凭据被拒绝，需要重扫'
  if (credentials.refresh?.last_error)
    return '续期待重试'
  if (credentials.status === 'alive')
    return '凭据可用'
  return '状态待确认'
})

function formatTime(seconds?: number) {
  return seconds ? new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false }) : '暂无记录'
}

async function loadHealth() {
  if (!expanded.value || !props.account?.id || loading.value)
    return
  const version = ++requestVersion
  controller = new AbortController()
  loading.value = true
  error.value = ''
  try {
    const { data } = await api.get(`/api/accounts/${encodeURIComponent(props.account.id)}/health`, { timeout: 12000, signal: controller.signal })
    if (version !== requestVersion)
      return
    if (data?.ok !== true)
      throw new Error('无法读取账号健康信息')
    health.value = data.data
  }
  catch (err: any) {
    if (version !== requestVersion || err?.code === 'ERR_CANCELED')
      return
    error.value = '健康信息读取失败，请点击刷新重试'
  }
  finally {
    if (version === requestVersion)
      loading.value = false
  }
}

watch([() => props.account?.id, expanded], () => {
  requestVersion++
  controller?.abort()
  loading.value = false
  health.value = null
  error.value = ''
  void loadHealth()
}, { immediate: true })
useIntervalFn(() => void loadHealth(), 30000)
useIntervalFn(() => {
  now.value = Date.now()
}, 1000)
onBeforeUnmount(() => {
  requestVersion++
  controller?.abort()
})
</script>

<template>
  <div class="border border-gray-200 rounded-lg bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-900/30" @click.stop>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <button type="button" class="min-h-11 flex items-center gap-2 text-left font-medium focus-visible:outline-2 focus-visible:outline-blue-500" :aria-expanded="expanded" @click="expanded = !expanded">
        <span class="i-carbon-activity" aria-hidden="true" />
        账号健康 · {{ runtimeLabel }}
        <span class="text-xs opacity-70">{{ expanded ? '收起' : '展开' }}</span>
      </button>
      <BaseButton v-if="expanded" size="sm" variant="outline" :loading="loading" @click="loadHealth">
        刷新状态
      </BaseButton>
    </div>
    <p v-if="reconnectLabel" class="mt-2 text-amber-800 dark:text-amber-300" role="status">
      {{ reconnectLabel }}
    </p>
    <div v-if="expanded" class="mt-2 break-words space-y-2" aria-live="polite">
      <p v-if="loading && !health">
        正在读取健康信息…
      </p>
      <p v-if="error" role="alert" class="text-red-700 dark:text-red-300">
        {{ error }}
      </p>
      <template v-if="health">
        <p v-if="loginLabel" role="status">
          {{ loginLabel }}
        </p>
        <p v-if="loginState?.lastSuccessAt" class="text-xs opacity-70">
          最近取码成功：{{ formatTime(loginState.lastSuccessAt / 1000) }}
        </p>
        <p v-if="runtimeError" class="text-red-700 dark:text-red-300">
          {{ runtimeError }}
        </p>
        <template v-if="account?.platform === 'qq' && account?.loginType !== 'yyb' && !account?.yybOpenid">
          <p>QQ 自动取码：{{ account?.qqAutoCodeAvailable ? '已保存登录态，登录失效后按需重新获取 Code' : '尚未保存登录态，请使用 QQ 扫码更新一次' }}</p>
          <p>QQ 登录态被退出或失效时需要重新扫码；使用原账号代理，不走微信应用宝接口。</p>
        </template>
        <template v-else-if="health.supported">
          <p>应用宝服务：{{ health.yyb?.available ? '正常' : '暂时不可用' }}</p>
          <p>凭据状态：{{ credentialLabel }}</p>
          <template v-if="health.credentials">
            <p>Access token 到期：{{ formatTime(health.credentials.expires_at) }}</p>
            <p>最近续期成功：{{ formatTime(health.credentials.refresh?.last_success_at) }}</p>
            <p>后台续期：{{ health.credentials.keepalive_enabled ? '已开启' : '已关闭' }}</p>
            <p v-if="health.credentials.refresh?.retry_at">
              下次重试：{{ formatTime(health.credentials.refresh.retry_at) }}
            </p>
            <p v-if="health.credentials.refresh?.last_error" class="text-amber-800 dark:text-amber-300">
              {{ health.credentials.refresh.last_error }}
            </p>
          </template>
          <p v-else class="text-amber-800 dark:text-amber-300">
            {{ health.credentialError }}
          </p>
        </template>
        <p v-else class="opacity-70">
          此账号可查看游戏连接状态；凭据续期详情仅支持内置应用宝账号。
        </p>
        <p class="text-xs opacity-70">
          展开时每 30 秒更新；凭据可用与游戏在线分别检测。
        </p>
      </template>
    </div>
  </div>
</template>
