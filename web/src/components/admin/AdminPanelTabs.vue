<script setup lang="ts">
import ScrollTabs from '@/components/ui/ScrollTabs.vue'
export type AdminTabKey = 'card' | 'user' | 'log' | 'system'

export interface AdminTabItem {
  key: AdminTabKey
  label: string
  icon: string
}

defineProps<{
  tabs: readonly AdminTabItem[]
}>()

const activeTab = defineModel<AdminTabKey>('activeTab', { required: true })
</script>

<template>
  <div class="min-w-0 max-w-full border border-gray-200 rounded-lg bg-white shadow dark:border-gray-700 dark:bg-gray-800">
    <div class="border-b border-gray-200 dark:border-gray-700">
      <ScrollTabs v-model="activeTab" :items="tabs" label="后台管理菜单" />
    </div>

    <div class="p-4">
      <slot />
    </div>
  </div>
</template>
