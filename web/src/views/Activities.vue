<script setup lang="ts">
import { NConfigProvider, NNotificationProvider, darkTheme } from 'naive-ui'
import { computed, defineAsyncComponent } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAccountStore } from '@/stores/account'
import { useAppStore } from '@/stores/app'
import { createNaiveThemeOverrides } from '@/ui/naive-theme'
import '@/styles/activities.css'

const ActivityCenter = defineAsyncComponent(() => import('./ActivityCenter.vue'))
const SolarCalendar = defineAsyncComponent(() => import('./SolarCalendar.vue'))
const accounts = useAccountStore()
const app = useAppStore()
const route = useRoute()
const router = useRouter()
const calendar = computed(() => route.path === '/solar-calendar')
const theme = computed(() => createNaiveThemeOverrides(app.isDark))
function selectAccount(event: Event) {
  const id = (event.target as HTMLSelectElement).value
  const account = accounts.accounts.find(a => a.id === id)
  if (account) accounts.setCurrentAccount(account)
}
</script>

<template>
  <section class="activities-root min-w-0 w-full">
    <header class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="m-0 text-xl font-bold">活动与节令</h1>
        <p class="my-1 text-sm opacity-65">活动开放时间和奖励进度以当前账号为准</p>
      </div>
      <select class="activity-account" aria-label="选择活动账号" :value="accounts.currentAccountId" @change="selectAccount">
        <option disabled value="">选择账号</option>
        <option v-for="account in accounts.accounts" :key="account.id" :value="account.id">{{ account.nick || account.name || account.id }}</option>
      </select>
    </header>
    <nav class="activity-tabs" aria-label="活动导航">
      <button :aria-current="!calendar ? 'page' : undefined" @click="router.push('/activity')">活动大厅</button>
      <button :aria-current="calendar ? 'page' : undefined" @click="router.push('/solar-calendar')">节令日历</button>
    </nav>
    <div v-if="!accounts.currentAccount?.connected" class="activity-offline" role="status">{{ accounts.currentAccountId ? '账号离线，请先启动。' : '请选择账号。' }}</div>
    <NConfigProvider v-else :theme="app.isDark ? darkTheme : null" :theme-overrides="theme">
      <NNotificationProvider placement="top-right">
        <div :class="{ 'activity-stage': !calendar }">
          <component :is="calendar ? SolarCalendar : ActivityCenter" :key="`${accounts.currentAccountId}:${calendar}`" />
        </div>
      </NNotificationProvider>
    </NConfigProvider>
  </section>
</template>
