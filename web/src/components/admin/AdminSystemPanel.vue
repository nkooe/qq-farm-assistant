<script setup lang="ts">
import type { LoginLinks, SystemConfig } from '@/composables/useAdminSystemConfig'
import { ref, watch } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import ScrollTabs from '@/components/ui/ScrollTabs.vue'
import AdminSiteSettings from './AdminSiteSettings.vue'

const sections = [
  { key: 'access', label: '访问控制', icon: 'i-carbon-security' },
  { key: 'announcement', label: '公告', icon: 'i-carbon-notification' },
  { key: 'login', label: '登录页', icon: 'i-carbon-application-web' },
  { key: 'connection', label: '系统连接', icon: 'i-carbon-network-3' },
] as const
type ConfigSection = typeof sections[number]['key']
const savedSection = localStorage.getItem('admin-config-section')
const activeSection = ref<ConfigSection>(sections.some(s => s.key === savedSection) ? savedSection as ConfigSection : 'access')
watch(activeSection, section => localStorage.setItem('admin-config-section', section))

interface OptionItem {
  label: string
  value: string
}

defineProps<{
  defaultSystemConfig: SystemConfig
  platformOptions: OptionItem[]
  osOptions: OptionItem[]
  systemConfigSaving: boolean
  loginLinksSaving: boolean
  loginLogoUploading: boolean
}>()

const emit = defineEmits<{
  resetSystem: []
  saveSystem: []
  resetLoginLinks: []
  saveLoginLinks: []
  uploadLoginLogo: [file: File]
}>()

const localSystemConfig = defineModel<SystemConfig>('localSystemConfig', { required: true })
const localLoginLinks = defineModel<LoginLinks>('localLoginLinks', { required: true })
const previewLogoFailed = ref(false)
const logoFileInput = ref<HTMLInputElement | null>(null)

watch(() => localLoginLinks.value.logoUrl, () => {
  previewLogoFailed.value = false
})

function openLogoFilePicker() {
  logoFileInput.value?.click()
}

function handleLogoFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file)
    emit('uploadLoginLogo', file)
  input.value = ''
}
</script>

<template>
  <div class="min-w-0 max-w-full space-y-4">
    <div class="min-w-0 rounded-xl bg-gray-50 dark:bg-gray-900/40">
      <ScrollTabs v-model="activeSection" :items="sections" label="配置子菜单" />
    </div>
    <AdminSiteSettings :section="activeSection" />

    <div class="space-y-4">
      <div v-show="activeSection === 'login'" class="border border-gray-200 rounded-lg bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <h4 class="mb-3 flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
          <div class="i-carbon-application-web" />
          登录页设置
        </h4>

        <div class="mb-3 rounded-lg bg-gray-50 px-4 py-3 text-xs text-gray-600 dark:bg-gray-900/40 dark:text-gray-300">
          自定义登录页外观与链接。
        </div>

        <div class="grid gap-3 text-sm">
          <div class="flex items-center gap-3 rounded-lg bg-gray-50 px-3 py-3 dark:bg-gray-900/40">
            <div class="h-12 w-12 flex flex-none items-center justify-center overflow-hidden border border-gray-200 rounded-full bg-white dark:border-gray-700 dark:bg-gray-800">
              <img
                v-if="localLoginLinks.logoUrl && !previewLogoFailed"
                :src="localLoginLinks.logoUrl"
                alt="登录页图标预览"
                class="h-full w-full object-cover"
                @error="previewLogoFailed = true"
              >
              <div v-else class="i-carbon-home text-xl text-green-600" />
            </div>
            <div class="min-w-0">
              <div class="break-words text-sm text-gray-900 font-semibold dark:text-gray-100">
                {{ localLoginLinks.title || 'QQ农场智能助手' }}
              </div>
              <div class="mt-1 break-words text-xs text-gray-500 dark:text-gray-400">
                {{ localLoginLinks.loginSubtitle || '欢迎回来，开启智慧农耕之旅' }}
              </div>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <input
              ref="logoFileInput"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon,image/vnd.microsoft.icon"
              class="hidden"
              @change="handleLogoFileChange"
            >
            <BaseButton
              variant="secondary"
              size="sm"
              :loading="loginLogoUploading"
              @click="openLogoFilePicker"
            >
              <span class="i-carbon-upload" />
              上传本地图片
            </BaseButton>
            <span class="text-xs text-gray-500 dark:text-gray-400">PNG、JPG、WebP、GIF、SVG、ICO，最大 2MB</span>
          </div>
          <BaseInput
            v-model="localLoginLinks.logoUrl"
            label="登录图标地址（可选）"
            type="text"
            placeholder="https://... 或 /icon.png"
          />
          <BaseInput
            v-model="localLoginLinks.title"
            label="主标题"
            type="text"
            placeholder="QQ农场智能助手"
          />
          <BaseInput
            v-model="localLoginLinks.loginSubtitle"
            label="登录欢迎语"
            type="text"
            placeholder="欢迎回来，开启智慧农耕之旅"
          />
          <BaseInput
            v-model="localLoginLinks.registerSubtitle"
            label="注册提示语"
            type="text"
            placeholder="创建账号，开启智慧农耕之旅"
          />
          <BaseInput
            v-model="localLoginLinks.purchaseUrl"
            label="购买链接"
            type="text"
            placeholder="https://... 或 /renewal"
          />
          <BaseInput
            v-model="localLoginLinks.qqGroupUrl"
            label="QQ群链接"
            type="text"
            placeholder="https://qm.qq.com/..."
          />
        </div>

        <div class="mt-3 flex justify-end gap-2">
          <BaseButton
            variant="secondary"
            size="sm"
            :loading="loginLinksSaving"
            @click="$emit('resetLoginLinks')"
          >
            恢复默认
          </BaseButton>
          <BaseButton
            variant="primary"
            size="sm"
            :loading="loginLinksSaving"
            @click="$emit('saveLoginLinks')"
          >
            保存
          </BaseButton>
        </div>
      </div>

      <div v-show="activeSection === 'connection'" class="border border-gray-200 rounded-lg bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <h4 class="mb-3 flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
          <div class="i-carbon-settings" />
          系统配置
        </h4>

        <div class="grid gap-3 md:grid-cols-3">
          <div class="rounded-2xl bg-gray-50 px-4 py-3 text-sm text-gray-700 dark:bg-gray-900/40 dark:text-gray-200">
            <div class="text-xs text-gray-500 dark:text-gray-400">
              当前平台
            </div>
            <div class="mt-1 font-semibold">
              {{ platformOptions.find(option => option.value === localSystemConfig.platform)?.label || '未设置' }}
            </div>
          </div>
          <div class="rounded-2xl bg-gray-50 px-4 py-3 text-sm text-gray-700 dark:bg-gray-900/40 dark:text-gray-200">
            <div class="text-xs text-gray-500 dark:text-gray-400">
              当前系统
            </div>
            <div class="mt-1 font-semibold">
              {{ localSystemConfig.os }}
            </div>
          </div>
          <div class="rounded-2xl bg-gray-50 px-4 py-3 text-sm text-gray-700 dark:bg-gray-900/40 dark:text-gray-200">
            <div class="text-xs text-gray-500 dark:text-gray-400">
              默认版本
            </div>
            <div class="mt-1 font-semibold">
              {{ defaultSystemConfig.clientVersion }}
            </div>
          </div>
        </div>

        <div class="mb-3 rounded-2xl bg-gray-50 px-4 py-3 text-xs text-gray-500 dark:bg-gray-900/40 dark:text-gray-400">
          服务器地址与版本需匹配。
        </div>

        <div class="mb-3 rounded-2xl bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          QQ、微信版本独立，下次登录生效。
        </div>

        <div class="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <BaseInput
            v-model="localSystemConfig.serverUrl"
            label="服务器地址"
            type="text"
            placeholder="wss://..."
            class="col-span-2"
          />
          <BaseInput
            v-model="localSystemConfig.clientVersion"
            label="QQ 客户端版本"
            type="text"
            placeholder="1.15.1.4_20261001"
            class="col-span-2"
          />
          <BaseInput
            v-model="localSystemConfig.wxClientVersion"
            label="微信客户端版本"
            type="text"
            placeholder="1.15.1.4_20261001"
            class="col-span-2"
          />
          <div class="flex flex-col gap-1.5">
            <label class="text-sm text-gray-700 font-medium dark:text-gray-300">平台</label>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="option in platformOptions"
                :key="option.value"
                class="rounded-lg px-3 py-1.5 text-sm transition-all"
                :class="localSystemConfig.platform === option.value
                  ? 'text-white shadow-sm'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'"
                :style="localSystemConfig.platform === option.value ? { backgroundColor: 'var(--theme-primary)' } : {}"
                @click="localSystemConfig.platform = option.value"
              >
                {{ option.label }}
              </button>
            </div>
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-sm text-gray-700 font-medium dark:text-gray-300">系统</label>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="option in osOptions"
                :key="option.value"
                class="rounded-lg px-3 py-1.5 text-sm transition-all"
                :class="localSystemConfig.os === option.value
                  ? 'text-white shadow-sm'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'"
                :style="localSystemConfig.os === option.value ? { backgroundColor: 'var(--theme-primary)' } : {}"
                @click="localSystemConfig.os = option.value"
              >
                {{ option.label }}
              </button>
            </div>
          </div>
        </div>

        <div class="mt-3 flex justify-end gap-2">
          <BaseButton
            variant="secondary"
            size="sm"
            :loading="systemConfigSaving"
            @click="$emit('resetSystem')"
          >
            重置
          </BaseButton>
          <BaseButton
            variant="primary"
            size="sm"
            :loading="systemConfigSaving"
            @click="$emit('saveSystem')"
          >
            保存
          </BaseButton>
        </div>
      </div>

    </div>
  </div>
</template>
