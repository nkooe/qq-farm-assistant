<script setup lang="ts">
import { onMounted, ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { useToastStore } from '@/stores/toast'
import { useUserStore } from '@/stores/user'

defineProps<{ section: string }>()
const toast = useToastStore()
const userStore = useUserStore()
const accessReady = ref(false)
const announcementReady = ref(false)
const accessError = ref('')
const announcementError = ref('')
const accessSaving = ref(false)
const announcementSaving = ref(false)
const cardVerificationEnabled = ref(true)
const savedCardVerificationEnabled = ref(true)
const showAccessConfirm = ref(false)
const pendingVerification = ref(true)
const announcement = ref({ enabled: false, title: '系统公告', content: '', showOnce: true, updatedAt: 0 })

async function loadAccess() {
  accessError.value = ''
  try {
    const { data } = await api.get('/api/admin/access-policy')
    if (!data?.ok) throw new Error(data?.error || '加载失败')
    cardVerificationEnabled.value = savedCardVerificationEnabled.value = data.data.cardVerificationEnabled
    accessReady.value = true
  } catch (error) { accessError.value = getApiErrorMessage(error, '加载访问控制失败') }
}

async function loadAnnouncement() {
  announcementError.value = ''
  try {
    const { data } = await api.get('/api/admin/announcement')
    if (!data?.ok) throw new Error(data?.error || '加载失败')
    announcement.value = { ...data.data }
    announcementReady.value = true
  } catch (error) { announcementError.value = getApiErrorMessage(error, '加载公告失败') }
}

function requestSaveAccess() {
  pendingVerification.value = cardVerificationEnabled.value
  showAccessConfirm.value = true
}

async function saveAccess() {
  accessSaving.value = true
  try {
    const { data } = await api.post('/api/admin/access-policy', {
      cardVerificationEnabled: pendingVerification.value, confirmed: true,
    })
    if (!data?.ok) throw new Error(data?.error || '保存失败')
    cardVerificationEnabled.value = savedCardVerificationEnabled.value = data.data.cardVerificationEnabled
    showAccessConfirm.value = false
    await userStore.fetchUserInfo()
    toast.success('卡密验证配置已保存')
  } catch (error) { toast.error(getApiErrorMessage(error)) }
  finally { accessSaving.value = false }
}

async function saveAnnouncement() {
  if (announcement.value.enabled && !announcement.value.content.trim()) {
    toast.warning('启用公告前请填写公告内容')
    return
  }
  announcementSaving.value = true
  try {
    const { data } = await api.post('/api/admin/announcement', { ...announcement.value, confirmed: true })
    if (!data?.ok) throw new Error(data?.error || '保存失败')
    announcement.value = { ...data.data }
    toast.success(announcement.value.enabled ? '公告已发布' : '公告已关闭，内容已保留')
  } catch (error) { toast.error(getApiErrorMessage(error)) }
  finally { announcementSaving.value = false }
}

onMounted(() => Promise.allSettled([loadAccess(), loadAnnouncement()]))
</script>

<template>
  <section v-show="section === 'access'" class="space-y-4">
    <h3 class="text-lg font-bold">访问控制</h3>
    <div v-if="accessError" class="text-sm text-red-700 dark:text-red-300" role="alert">
      {{ accessError }} <BaseButton size="sm" variant="secondary" @click="loadAccess">重新加载</BaseButton>
    </div>
    <fieldset :disabled="!accessReady || accessSaving" class="min-w-0 space-y-4 border border-gray-200 rounded-xl p-4 dark:border-gray-700">
      <div class="text-sm text-gray-600 dark:text-gray-300">
        当前生效：{{ accessReady ? (savedCardVerificationEnabled ? '启用卡密验证' : '关闭卡密验证') : '加载中…' }}。保存后生效。
      </div>
      <BaseSwitch v-model="cardVerificationEnabled" label="启用卡密验证" class="min-h-11" />
      <div class="rounded-lg bg-gray-50 p-3 text-sm leading-relaxed dark:bg-gray-900/40">
        <p>开启：注册需卡密，到期需续费。</p>
        <p class="mt-2">关闭：免卡密和到期检查，封禁与额度仍有效。</p>
        <p class="mt-2">管理员不受卡密限制。</p>
      </div>
      <p v-if="cardVerificationEnabled && !savedCardVerificationEnabled" class="text-sm text-amber-800 dark:text-amber-200">
        开启后，未激活或已到期用户将退出登录。
      </p>
      <div class="flex justify-end">
        <BaseButton :loading="accessSaving" :disabled="!accessReady || cardVerificationEnabled === savedCardVerificationEnabled" @click="requestSaveAccess">保存访问控制</BaseButton>
      </div>
    </fieldset>
  </section>

  <section v-show="section === 'announcement'" class="space-y-4">
    <h3 class="text-lg font-bold">公告配置</h3>
    <div v-if="announcementError" class="text-sm text-red-700 dark:text-red-300" role="alert">
      {{ announcementError }} <BaseButton size="sm" variant="secondary" @click="loadAnnouncement">重新加载</BaseButton>
    </div>
    <fieldset :disabled="!announcementReady || announcementSaving" class="min-w-0 space-y-4 border border-gray-200 rounded-xl p-4 dark:border-gray-700">
      <BaseSwitch v-model="announcement.enabled" label="启用公告" class="min-h-11" />
      <div class="space-y-2">
        <label for="site-announcement-title" class="text-sm font-medium">公告标题</label>
        <input id="site-announcement-title" v-model="announcement.title" type="text" maxlength="120" class="announcement-input" placeholder="系统公告">
      </div>
      <div class="space-y-2">
        <label for="site-announcement-content" class="text-sm font-medium">公告内容</label>
        <textarea id="site-announcement-content" v-model="announcement.content" rows="7" maxlength="10000" class="announcement-input" placeholder="填写要向用户展示的通知，支持换行" />
        <p class="text-xs text-gray-500 dark:text-gray-400">{{ announcement.content.length }} / 10000 字，以纯文本展示。</p>
      </div>
      <BaseSwitch v-model="announcement.showOnce" label="每版只显示一次" class="min-h-11" />
      <p class="text-sm leading-relaxed text-gray-600 dark:text-gray-300">
        开启：每版只提醒一次；关闭：每次登录提醒。
      </p>
      <div class="flex justify-end">
        <BaseButton :loading="announcementSaving" :disabled="!announcementReady" @click="saveAnnouncement">{{ announcement.enabled ? '保存并发布公告' : '保存公告配置' }}</BaseButton>
      </div>
    </fieldset>
  </section>

  <ConfirmModal :show="showAccessConfirm" title="保存卡密验证配置" :loading="accessSaving"
    :message="pendingVerification ? '开启后，无卡密或已到期的普通用户需要先激活或续费，相关登录状态会被撤销。确定保存？' : '关闭后将允许免卡密注册，并跳过到期验证。账号封禁和数量限制继续生效。确定保存？'"
    @confirm="saveAccess" @cancel="showAccessConfirm = false" @close="showAccessConfirm = false" />
</template>

<style scoped>
.announcement-input { display: block; width: 100%; min-width: 0; border: 1px solid var(--surface-border-strong); border-radius: 10px; padding: 12px; background: var(--input-bg); color: var(--theme-text); font-size: 16px; line-height: 1.6; resize: vertical; }
.announcement-input:focus-visible { outline: 2px solid var(--theme-primary); outline-offset: 2px; }
</style>
