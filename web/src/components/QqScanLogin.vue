<script setup lang="ts">
import type { Account } from '@/stores/account'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'

const props = defineProps<{ account?: Account }>()
const emit = defineEmits<{ saved: [accountId: string], close: [], saving: [value: boolean] }>()
const accountName = ref('')
const image = ref('')
const stage = ref('starting')
const message = ref('正在生成 QQ 二维码…')
const error = ref('')
const sessionId = ref('')
const currentCode = ref('')
const saving = ref(false)
const saved = ref(false)
const proxyProfiles = ref<Array<{ id: number, name: string }>>([])
const proxySelection = ref(props.account?.proxyMode === 'static' ? String(props.account.proxyProfileId || '') : 'direct')
const proxyReady = ref(false)
const records = ref<Array<{ code: string, time: string, copied: boolean }>>([])
let generation = 0
let stopped = false
let controller: AbortController | null = null
let delayTimer: ReturnType<typeof setTimeout> | null = null
let releaseDelay: (() => void) | null = null
const busy = computed(() => ['starting', 'scanned', 'initializing', 'requesting'].includes(stage.value) || saving.value)
const newestCode = computed(() => currentCode.value)
watch(saving, value => emit('saving', value))

const requestOptions = { timeout: 12000, skipErrorToast: true } as any
function requestError(value: any, fallback: string) {
  return String(value?.response?.data?.error || fallback)
}
async function cancelSession(id: string) {
  if (!id)
    return
  try {
    await api.delete(`/api/qq-login/sessions/${encodeURIComponent(id)}`, requestOptions)
  }
  catch { /* Server expires abandoned sessions independently. */ }
}
function stopWaiting() {
  controller?.abort()
  controller = null
  if (delayTimer)
    clearTimeout(delayTimer)
  delayTimer = null
  releaseDelay?.()
  releaseDelay = null
}
async function pause() {
  await new Promise<void>((resolve) => {
    releaseDelay = resolve
    delayTimer = setTimeout(resolve, 1200)
  })
  delayTimer = null
  releaseDelay = null
}

async function saveCode(version = generation) {
  if (saving.value || !newestCode.value || saved.value)
    return
  saving.value = true
  error.value = ''
  message.value = '正在保存账号…'
  try {
    const { data } = await api.post(`/api/qq-login/sessions/${encodeURIComponent(sessionId.value)}/import`, {
      name: accountName.value.trim(),
      ...(props.account ? { targetAccountId: String(props.account.id) } : {}),
    }, { ...requestOptions, timeout: 100000 })
    if (data?.ok !== true)
      throw new Error(data?.error || '账号保存失败')
    if (stopped || version !== generation)
      return
    saved.value = true
    stage.value = 'success'
    message.value = data.data?.updated
      ? '已更新原账号，正在连接'
      : '账号已添加，正在连接'
    const finalCode = String(data.data?.code || newestCode.value)
    if (finalCode !== newestCode.value) {
      // The identity check can consume the initial credential. Display only
      // the fresh Code actually stored for this login.
      const record = records.value.find(item => item.code === newestCode.value)
      if (record) {
        record.code = finalCode
        record.copied = false
      }
      currentCode.value = finalCode
    }
    emit('saved', String(data.data?.accountId || ''))
    await cancelSession(sessionId.value)
    sessionId.value = ''
  }
  catch (value: any) {
    if (stopped || version !== generation)
      return
    error.value = requestError(value, '保存未确认，请检查账号列表')
    message.value = '待确认保存'
  }
  finally { saving.value = false }
}

async function poll(version: number, signal: AbortSignal) {
  let failures = 0
  for (;;) {
    if (stopped || version !== generation || signal.aborted || !sessionId.value)
      return
    try {
      const { data } = await api.get(`/api/qq-login/sessions/${encodeURIComponent(sessionId.value)}`, { ...requestOptions, signal })
      if (stopped || version !== generation || signal.aborted)
        return
      if (data?.ok !== true)
        throw new Error('无法读取 QQ 扫码状态')
      const state = data.data || {}
      failures = 0
      stage.value = String(state.status || 'starting')
      message.value = String(state.message || '正在等待扫码…')
      image.value = String(state.image || '')
      if (stage.value === 'success') {
        const code = String(state.code || '')
        if (!/^[\w.~+/=%-]{8,2048}$/.test(code) || /^[-+]?\d+$/.test(code)) {
          error.value = 'QQ 未返回有效 Code，请刷新二维码'
          stage.value = 'error'
          return
        }
        if (!records.value.some(item => item.code === code)) {
          records.value.unshift({ code, time: new Date().toLocaleTimeString(), copied: false })
          records.value = records.value.slice(0, 20)
        }
        currentCode.value = code
        await saveCode(version)
        return
      }
      if (['expired', 'error', 'login_failed', 'offline'].includes(stage.value)) {
        error.value = message.value
        return
      }
    }
    catch (value: any) {
      if (signal.aborted || stopped || version !== generation)
        return
      if ([404, 410].includes(value?.response?.status) || ++failures >= 4) {
        error.value = requestError(value, '查询 QQ 扫码状态失败，请刷新二维码')
        stage.value = 'error'
        return
      }
      message.value = '网络暂时中断，正在重新查询扫码状态…'
    }
    await pause()
  }
}

async function start() {
  if (!proxyReady.value || saving.value)
    return
  const version = ++generation
  stopWaiting()
  const previous = sessionId.value
  sessionId.value = ''
  image.value = ''
  currentCode.value = ''
  error.value = ''
  saved.value = false
  stage.value = 'starting'
  message.value = '正在生成 QQ 二维码…'
  const current = controller = new AbortController()
  await cancelSession(previous)
  try {
    // Do not abort creation: if the dialog closes during this request, its
    // eventual response still supplies the id needed to cancel the native host.
    const { data } = await api.post('/api/qq-login/sessions', {
      proxyMode: proxySelection.value === 'direct' ? 'direct' : 'static',
      proxyProfileId: proxySelection.value === 'direct' ? null : Number(proxySelection.value),
      ...(props.account ? { targetAccountId: String(props.account.id) } : {}),
    }, { ...requestOptions, timeout: 25000 })
    const id = String(data?.data?.sessionId || '')
    if (stopped || version !== generation) {
      await cancelSession(id)
      return
    }
    if (data?.ok !== true || !id)
      throw new Error('未能创建 QQ 扫码会话')
    sessionId.value = id
    await poll(version, current.signal)
  }
  catch (value: any) {
    if (stopped || version !== generation)
      return
    stage.value = 'error'
    error.value = requestError(value, '生成 QQ 二维码失败，请检查扫码组件是否已启动')
  }
}

async function copyRecord(record: { code: string, copied: boolean }) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(record.code)
    }
    else {
      const input = document.createElement('textarea')
      input.value = record.code
      input.style.position = 'fixed'
      input.style.opacity = '0'
      document.body.append(input)
      try {
        input.select()
        if (!document.execCommand('copy'))
          throw new Error('Copy failed')
      }
      finally { input.remove() }
    }
    record.copied = true
  }
  catch {
    error.value = '复制失败，请选中 Code 文本手动复制'
  }
}
async function loadProxyOptions() {
  proxyReady.value = false
  error.value = ''
  try {
    const { data } = await api.get('/api/yyb/proxy-profiles', requestOptions)
    if (stopped)
      return
    if (data?.ok !== true || !Array.isArray(data.data))
      throw new Error('代理配置读取失败')
    proxyProfiles.value = data.data
    if (proxySelection.value !== 'direct' && !proxyProfiles.value.some(profile => String(profile.id) === proxySelection.value))
      throw new Error('原账号的代理配置已不可用，请先修复该代理配置')
    proxyReady.value = true
    await start()
  }
  catch (value: any) {
    if (!stopped) {
      stage.value = 'error'
      error.value = requestError(value, value?.message || '代理配置读取失败，请重试')
      message.value = '等待读取代理配置'
    }
  }
}
onMounted(() => {
  void loadProxyOptions()
})
onBeforeUnmount(() => {
  stopped = true
  generation++
  stopWaiting()
  void cancelSession(sessionId.value)
})
</script>

<template>
  <div class="space-y-4">
    <BaseInput v-if="!account" v-model="accountName" label="账号备注（可选）" placeholder="留空则使用默认账号名" :disabled="saving" />
    <label class="block text-sm" :style="{ color: 'var(--theme-text)' }">
      连接方式
      <select v-model="proxySelection" aria-label="QQ 连接方式" class="mt-1 block w-full border border-gray-300 rounded-lg p-2 dark:border-gray-600" :style="{ background: 'var(--theme-bg)', color: 'var(--theme-text)' }" :disabled="!proxyReady || busy" @change="start">
        <option value="direct">直连</option>
        <option v-for="profile in proxyProfiles" :key="profile.id" :value="String(profile.id)">{{ profile.name }}</option>
      </select>
    </label>
    <p v-if="!saved" class="text-sm opacity-70" :style="{ color: 'var(--theme-text)' }">
      <template v-if="account">
        请用原 QQ 扫码。
      </template>
      <template v-else>
        请用手机 QQ 扫码。
      </template>
    </p>
    <div v-if="image && !saved" class="mx-auto max-w-60 w-full border border-gray-200 rounded-lg bg-white p-3">
      <img :src="image" alt="QQ 登录二维码" class="aspect-square w-full object-contain" width="224" height="224">
    </div>
    <div v-else-if="!saved && stage !== 'success'" class="mx-auto aspect-square max-w-60 w-full flex items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800">
      <span class="text-5xl" :class="busy ? 'i-svg-spinners-ring-resize animate-spin' : 'i-carbon-qr-code'" :style="{ color: 'var(--theme-primary)' }" />
    </div>
    <div role="status" class="rounded-lg px-3 py-3 text-center text-sm leading-6" :style="{ color: 'var(--theme-text)', background: 'color-mix(in srgb, var(--theme-primary) 10%, transparent)' }">
      {{ message }}
    </div>
    <p v-if="error" role="alert" class="break-words text-sm text-red-600 dark:text-red-400">
      {{ error }}
    </p>
    <div v-if="records.length" class="space-y-2">
      <div v-for="record in records" :key="record.code" class="min-w-0 flex items-start gap-2 border border-gray-200 rounded-lg p-2 dark:border-gray-700">
        <div class="min-w-0 flex-1">
          <div class="text-xs opacity-60" :style="{ color: 'var(--theme-text)' }">
            {{ record.time }}
          </div>
          <code class="select-all break-all text-xs" :style="{ color: 'var(--theme-text)' }">{{ record.code }}</code>
        </div>
        <BaseButton variant="outline" class="shrink-0" @click="copyRecord(record)">
          {{ record.copied ? '已复制' : '复制' }}
        </BaseButton>
      </div>
    </div>
    <div class="flex flex-wrap justify-end gap-2">
      <BaseButton variant="outline" :disabled="saving" @click="emit('close')">
        {{ saved ? '完成' : '取消' }}
      </BaseButton>
      <BaseButton v-if="newestCode && !saved" variant="primary" :loading="saving" @click="saveCode()">
        重试保存
      </BaseButton>
      <BaseButton v-if="!account || !saved" variant="primary" :disabled="saving" :loading="stage === 'starting'" @click="proxyReady ? start() : loadProxyOptions()">
        {{ !proxyReady ? '重试加载' : saved ? '再扫一个账号' : '刷新二维码' }}
      </BaseButton>
    </div>
    <div class="text-right text-xs opacity-50" :style="{ color: 'var(--theme-text)' }">
      作者：nkooe
    </div>
  </div>
</template>
