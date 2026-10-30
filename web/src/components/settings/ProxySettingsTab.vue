<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import { useUserStore } from '@/stores/user'

interface ProxyProfile {
  id: number
  name: string
  protocol: 'http-connect' | 'socks5'
  host: string
  port: number
  username: string
  password_configured: boolean
  redacted?: boolean
  shared_with_users?: boolean
  owner_user_id?: number
}

const props = defineProps<{ accounts: any[] }>()
const userStore = useUserStore()
const emit = defineEmits<{ notify: [message: string, type?: 'primary' | 'danger'] }>()

const loading = ref(false)
const saving = ref(false)
const testingId = ref(0)
const profiles = ref<ProxyProfile[]>([])
const yybAccounts = ref<any[]>([])
const accountSettings = ref<Record<string, { mode: 'direct' | 'static', proxyProfileId: number | null }>>({})
const editingId = ref(0)
const showForm = ref(false)
const form = reactive({
  name: '',
  protocol: 'http-connect' as 'http-connect' | 'socks5',
  host: '',
  port: 0,
  username: '',
  password: '',
  passwordConfigured: false,
  sharedWithUsers: false,
  ownerUserId: 1000,
})

const accountRows = computed(() => yybAccounts.value.map((yyb) => {
  const main = props.accounts.find(account => String(account.yybOpenid || '') === String(yyb.openid || ''))
  return {
    ...yyb,
    displayName: main?.name || yyb.nickname || yyb.alias || `应用宝账号 ${String(yyb.openid || '').slice(-6)}`,
  }
}))

function getAccountSetting(openid: unknown) {
  const key = String(openid || '')
  if (!accountSettings.value[key])
    accountSettings.value[key] = { mode: 'direct', proxyProfileId: null }
  return accountSettings.value[key]
}

function resetForm() {
  editingId.value = 0
  Object.assign(form, { name: '', protocol: 'http-connect', host: '', port: 0, username: '', password: '', passwordConfigured: false, sharedWithUsers: false, ownerUserId: 1000 })
}

function openCreate() {
  resetForm()
  showForm.value = true
}

function openEdit(profile: ProxyProfile) {
  if (profile.redacted)
    return
  editingId.value = profile.id
  Object.assign(form, {
    name: profile.name,
    protocol: profile.protocol,
    host: profile.host,
    port: profile.port,
    username: profile.username || '',
    password: '',
    passwordConfigured: profile.password_configured,
    sharedWithUsers: !!profile.shared_with_users,
    ownerUserId: profile.owner_user_id ?? 1000,
  })
  showForm.value = true
}

async function loadData() {
  loading.value = true
  try {
    const [profilesResponse, accountsResponse] = await Promise.all([
      api.get('/api/yyb/proxy-profiles'),
      api.post('/api/yyb/accounts', {}),
    ])
    if (!profilesResponse.data.ok || !Array.isArray(profilesResponse.data.data) || !accountsResponse.data.ok || !Array.isArray(accountsResponse.data.data))
      throw new Error('代理设置响应格式无效')
    profiles.value = profilesResponse.data.data
    yybAccounts.value = accountsResponse.data.data
    const entries = await Promise.all(yybAccounts.value.map(async (account) => {
      const response = await api.get('/api/yyb/account-proxy', { params: { ref: account.openid } })
      const data = response.data?.data
      if (!response.data.ok || !data || !['static', 'direct'].includes(data.mode))
        throw new Error('账号代理设置响应格式无效')
      return [String(account.openid), {
        mode: data.mode === 'static' ? 'static' : 'direct',
        proxyProfileId: Number(data.proxy_profile_id) || null,
      }] as const
    }))
    accountSettings.value = Object.fromEntries(entries)
  }
  catch (error: any) {
    emit('notify', error.response?.data?.error || error.message || '加载代理设置失败', 'danger')
  }
  finally {
    loading.value = false
  }
}

async function saveProfile() {
  if (!form.name.trim() || !form.host.trim() || !form.port) {
    emit('notify', '请完整填写代理名称、主机和端口', 'danger')
    return
  }
  saving.value = true
  try {
    const payload = {
      ...(editingId.value ? { id: editingId.value } : {}),
      name: form.name.trim(),
      protocol: form.protocol,
      host: form.host.trim(),
      port: Number(form.port),
      username: form.username.trim(),
      password: form.password || (form.passwordConfigured ? '__KEEP__' : ''),
      shared_with_users: userStore.isAdmin && form.ownerUserId === 1000 && form.sharedWithUsers,
    }
    if (editingId.value)
      await api.put('/api/yyb/proxy-profiles', payload)
    else
      await api.post('/api/yyb/proxy-profiles', payload)
    showForm.value = false
    resetForm()
    await loadData()
    emit('notify', '代理配置已保存')
  }
  catch (error: any) {
    emit('notify', error.response?.data?.error || error.message || '保存代理失败', 'danger')
  }
  finally {
    saving.value = false
  }
}

async function deleteProfile(profile: ProxyProfile) {
  if (!window.confirm(`确定删除代理配置“${profile.name}”吗？`))
    return
  try {
    await api.delete(`/api/yyb/proxy-profiles/${profile.id}`)
    await loadData()
    emit('notify', '代理配置已删除')
  }
  catch (error: any) {
    emit('notify', error.response?.data?.error || error.message || '删除失败；请先解除账号绑定', 'danger')
  }
}

async function testProfile(profile: ProxyProfile) {
  testingId.value = profile.id
  try {
    const response = await api.post(`/api/yyb/proxy-profiles/${profile.id}/test`, {}, { timeout: 15000 })
    emit('notify', `代理隧道可用，延迟 ${response.data?.data?.latency_ms ?? '-'} ms`)
  }
  catch (error: any) {
    emit('notify', error.response?.data?.error || error.message || '代理测试失败', 'danger')
  }
  finally {
    testingId.value = 0
  }
}

async function saveAccountProxy(account: any) {
  const key = String(account.openid)
  const setting = accountSettings.value[key] || { mode: 'direct', proxyProfileId: null }
  if (setting.mode === 'static' && !setting.proxyProfileId) {
    emit('notify', '静态代理模式必须选择一项代理配置', 'danger')
    return
  }
  try {
    await api.put('/api/yyb/account-proxy', {
      ref: account.openid,
      mode: setting.mode,
      proxyProfileId: setting.mode === 'static' ? setting.proxyProfileId : null,
    })
    emit('notify', `${account.displayName} 的代理设置已保存`)
  }
  catch (error: any) {
    emit('notify', error.response?.data?.error || error.message || '保存账号代理失败', 'danger')
  }
}

onMounted(loadData)
</script>

<template>
  <div class="space-y-6">
    <section>
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 class="text-lg text-gray-900 font-bold dark:text-gray-100">代理配置库</h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">自建代理私用，共享代理仅显示名称。</p>
        </div>
        <BaseButton variant="primary" size="sm" @click="openCreate">
          <span class="i-carbon-add mr-1" />添加静态代理
        </BaseButton>
      </div>

      <div v-if="showForm" class="mb-4 border border-gray-200 rounded-xl p-4 dark:border-gray-700">
        <div class="grid gap-3 md:grid-cols-2">
          <BaseInput v-model="form.name" label="配置名称" placeholder="例如：上海固定出口" />
          <label class="block">
            <span class="mb-1 block text-sm font-medium">协议</span>
            <select v-model="form.protocol" class="min-h-11 w-full border border-gray-300 rounded-lg bg-transparent px-3 dark:border-gray-600">
              <option value="http-connect">HTTP CONNECT</option>
              <option value="socks5">SOCKS5</option>
            </select>
          </label>
          <BaseInput v-model="form.host" label="主机/IP" placeholder="proxy.example.com" />
          <BaseInput v-model.number="form.port" label="端口" type="number" placeholder="1080" />
          <BaseInput v-model="form.username" label="用户名（可选）" autocomplete="off" />
          <BaseInput v-model="form.password" label="密码（可选）" type="password" autocomplete="new-password" :placeholder="form.passwordConfigured ? '留空保留原密码' : '按需填写'" />
          <label v-if="userStore.isAdmin && form.ownerUserId === 1000" class="flex items-center gap-2 text-sm">
            <input v-model="form.sharedWithUsers" type="checkbox">
            允许用户使用（用户仅可见代理名称）
          </label>
        </div>
        <div class="mt-4 flex justify-end gap-2">
          <BaseButton variant="outline" @click="showForm = false">取消</BaseButton>
          <BaseButton variant="primary" :loading="saving" @click="saveProfile">保存配置</BaseButton>
        </div>
      </div>

      <div v-if="loading" class="py-8 text-center text-gray-500">加载中...</div>
      <div v-else-if="profiles.length === 0" class="border border-dashed border-gray-300 rounded-xl py-8 text-center text-sm text-gray-500 dark:border-gray-700">暂无静态代理配置</div>
      <div v-else class="grid gap-3 lg:grid-cols-2">
        <article v-for="profile in profiles" :key="profile.id" class="border border-gray-200 rounded-xl p-4 dark:border-gray-700">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="truncate font-semibold">{{ profile.name }}</div>
              <template v-if="!profile.redacted">
                <div class="mt-1 break-all text-sm text-gray-500 dark:text-gray-400">{{ profile.protocol === 'socks5' ? 'SOCKS5' : 'HTTP CONNECT' }} · {{ profile.host }}:{{ profile.port }}</div>
                <div class="mt-1 text-xs text-gray-500">认证：{{ profile.username ? `${profile.username} / ${profile.password_configured ? '已配置密码' : '无密码'}` : '无' }}</div>
                <div v-if="userStore.isAdmin" class="mt-1 text-xs text-gray-500">{{ profile.owner_user_id !== 1000 ? `所属用户：${profile.owner_user_id}` : profile.shared_with_users ? '已允许用户使用' : '未共享给用户' }}</div>
              </template>
              <div v-else class="mt-1 text-xs text-gray-500">管理员共享代理</div>
            </div>
            <span class="i-carbon-network-3 text-xl" style="color: var(--theme-primary)" />
          </div>
          <div class="mt-3 flex flex-wrap justify-end gap-2">
            <BaseButton variant="ghost" size="sm" :loading="testingId === profile.id" @click="testProfile(profile)">测试</BaseButton>
            <BaseButton v-if="!profile.redacted" variant="ghost" size="sm" @click="openEdit(profile)">编辑</BaseButton>
            <BaseButton v-if="!profile.redacted" variant="ghost" size="sm" class="text-red-500" @click="deleteProfile(profile)">删除</BaseButton>
          </div>
        </article>
      </div>
    </section>

    <section class="border-t border-gray-200 pt-5 dark:border-gray-700">
      <div class="mb-3">
        <h3 class="text-lg text-gray-900 font-bold dark:text-gray-100">账号出口</h3>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">每个账号独立配置，代理异常即停止。</p>
      </div>
      <div v-if="!loading && accountRows.length === 0" class="border border-dashed border-gray-300 rounded-xl py-8 text-center text-sm text-gray-500 dark:border-gray-700">暂无应用宝账号，请先扫码添加</div>
      <div v-else class="space-y-3">
        <article v-for="account in accountRows" :key="account.openid" class="grid items-end gap-3 border border-gray-200 rounded-xl p-4 md:grid-cols-[minmax(180px,1fr)_160px_minmax(220px,1fr)_auto] dark:border-gray-700">
          <div class="min-w-0 self-center">
            <div class="truncate font-semibold">{{ account.displayName }}</div>
            <div class="truncate text-xs text-gray-500">{{ account.openid }}</div>
          </div>
          <label>
            <span class="mb-1 block text-xs text-gray-500">连接模式</span>
            <select v-model="getAccountSetting(account.openid).mode" class="min-h-11 w-full border border-gray-300 rounded-lg bg-transparent px-3 dark:border-gray-600">
              <option value="direct">直连</option>
              <option value="static">静态代理</option>
            </select>
          </label>
          <label>
            <span class="mb-1 block text-xs text-gray-500">代理配置</span>
            <select v-model.number="getAccountSetting(account.openid).proxyProfileId" :disabled="getAccountSetting(account.openid).mode !== 'static'" class="min-h-11 w-full border border-gray-300 rounded-lg bg-transparent px-3 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600">
              <option :value="null">请选择</option>
              <option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.name }}</option>
            </select>
          </label>
          <BaseButton variant="primary" size="sm" class="min-h-11" @click="saveAccountProxy(account)">保存</BaseButton>
        </article>
      </div>
    </section>
  </div>
</template>
