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

// Connection and recovery details must come from the same runtime snapshot.
const runtime = computed(() => props.account?.runtimeState
  ? { state: props.account.runtimeState, error: props.account.runtimeError, reconnect: props.account.runtimeReconnect, login: props.account.runtimeLogin }
  : health.value?.runtime)
const online = computed(() => runtime.value?.state === 'online')
const runtimeLabel = computed(() => ({ online: '在线', starting: '连接中', reconnecting: '等待重连', failed: '连接失败', stopped: '已停止', stopping: '停止中' } as Record<string, string>)[runtime.value?.state] || '状态未知')
const reconnect = computed(() => online.value ? null : runtime.value?.reconnect)
const runtimeError = computed(() => online.value ? '' : runtime.value?.error)
const loginState = computed(() => runtime.value?.login)
const loginLabel = computed(() => {
  // A completed login attempt is history once the game has connected.
  if (online.value)
    return ''
  const task = loginState.value
  if (!task)
    return ''
  if (task.state === 'queued')
    return '排队取码中'
  if (task.state === 'requesting')
    return '正在取码'
  if (task.state === 'cancelled')
    return '取码已取消'
  if (task.state === 'success')
    return `取码成功，用时 ${Math.ceil((task.durationMs || 0) / 1000)} 秒`
  return ({ rescan: '登录失效，请扫码', proxy: '代理异常，请检查', busy: '服务繁忙，等待重试', timeout: '取码超时，等待重试', configuration: '登录配置异常' } as Record<string, string>)[task.kind] || '取码失败，请查看错误'
})
const reconnectLabel = computed(() => {
  const plan = reconnect.value
  if (!plan)
    return ''
  if (plan.state === 'scheduled') {
    const seconds = Math.max(0, Math.ceil((plan.nextRetryAt - now.value) / 1000))
    return plan.kind === 'busy' ? `服务繁忙，${seconds} 秒后重试` : `重连 ${plan.attempt}/${plan.maxAttempts}，${seconds} 秒后重试`
  }
  if (plan.state === 'needs_rescan')
    return '请扫码，重试已暂停'
  if (plan.state === 'blocked')
    return '配置异常，重试已暂停'
  return plan.state === 'waiting_credentials' ? '等待登录恢复' : `重连已达上限（${plan.attempt}/${plan.maxAttempts}）`
})
const credentialLabel = computed(() => {
  const credentials = health.value?.credentials
  if (!credentials)
    return '读取失败'
  if (credentials.needs_rescan)
    return '已失效，请扫码'
  if (credentials.refresh?.last_error)
    return '续期待重试'
  if (credentials.status === 'alive')
    return '有效'
  return '待确认'
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
      throw new Error('状态读取失败')
    health.value = data.data
  }
  catch (err: any) {
    if (version !== requestVersion || err?.code === 'ERR_CANCELED')
      return
    error.value = '读取失败，请刷新'
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
        状态检查 · {{ runtimeLabel }}
        <span class="text-xs opacity-70">{{ expanded ? '收起' : '展开' }}</span>
      </button>
      <BaseButton v-if="expanded" size="sm" variant="outline" :loading="loading" @click="loadHealth">
        刷新
      </BaseButton>
    </div>
    <p v-if="reconnectLabel" class="mt-2 text-amber-800 dark:text-amber-300" role="status">
      {{ reconnectLabel }}
    </p>
    <div v-if="expanded" class="mt-2 break-words space-y-2" aria-live="polite">
      <p v-if="loading && !health">
        检查中…
      </p>
      <p v-if="error" role="alert" class="text-red-700 dark:text-red-300">
        {{ error }}
      </p>
      <template v-if="health">
        <p v-if="loginLabel" role="status">
          {{ loginLabel }}
        </p>
        <p v-if="loginState?.lastSuccessAt" class="text-xs opacity-70">
          最近取码：{{ formatTime(loginState.lastSuccessAt / 1000) }}
        </p>
        <p v-if="runtimeError" class="text-red-700 dark:text-red-300">
          {{ runtimeError }}
        </p>
        <template v-if="account?.platform === 'qq' && account?.loginType !== 'yyb' && !account?.yybOpenid">
          <p>登录态：{{ account?.qqAutoCodeAvailable ? '已保存' : '未保存' }}</p>
        </template>
        <template v-else-if="health.supported">
          <p>应用宝服务：{{ health.yyb?.available ? '正常' : '不可用' }}</p>
          <p>登录凭据：{{ credentialLabel }}</p>
          <template v-if="health.credentials">
            <p>凭据到期：{{ formatTime(health.credentials.expires_at) }}</p>
            <p>最近续期：{{ formatTime(health.credentials.refresh?.last_success_at) }}</p>
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
      </template>
    </div>
  </div>
</template>
