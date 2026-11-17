<script setup lang="ts">
import { NConfigProvider, NNotificationProvider, darkTheme } from 'naive-ui'
import { computed, defineAsyncComponent, onBeforeUnmount, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useAccountStore } from '@/stores/account'
import { useAppStore } from '@/stores/app'
import { useRanchStore } from '@/stores/ranch'
import { useStatusStore } from '@/stores/status'
import { createNaiveThemeOverrides } from '@/ui/naive-theme'
import '@/styles/activities.css'
import '@/styles/overview.css'

const Ranch = defineAsyncComponent(() => import('./Ranch.vue'))
const Overview = defineAsyncComponent(() => import('./RanchOverview.vue'))
const Strategy = defineAsyncComponent(() => import('./RanchStrategy.vue'))
const accounts = useAccountStore()
const app = useAppStore()
const ranch = useRanchStore()
const status = useStatusStore()
const route = useRoute()
const theme = computed(() => createNaiveThemeOverrides(app.isDark))
const strategy = computed(() => route.path === '/ranch/strategy')
const panel = computed(() => strategy.value ? Strategy : route.path === '/ranch' ? Overview : Ranch)
const links: Array<[string, string]> = [
  ['/ranch', '总览'], ['/ranch/personal', '我的牧场'], ['/ranch/illustrated', '图鉴'],
  ['/ranch/mall', '商城'], ['/ranch/friends', '好友'], ['/ranch/activity', '活动'], ['/ranch/strategy', '策略'],
]
function selectAccount(event: Event) {
  const account = accounts.accounts.find(a => a.id === (event.target as HTMLSelectElement).value)
  if (account) accounts.setCurrentAccount(account)
}
watch(() => accounts.currentAccountId, (id) => {
  ranch.reset()
  status.disconnectRealtime()
  if (id) {
    status.connectRealtime(id)
    void status.fetchStatus(id)
  }
}, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => { ranch.reset(); status.disconnectRealtime() })
</script>

<template>
  <section class="activities-root min-w-0 w-full">
    <header class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 class="m-0 text-xl font-bold">牧场</h1>
      <select class="activity-account" aria-label="选择牧场账号" :value="accounts.currentAccountId" @change="selectAccount">
        <option disabled value="">选择账号</option>
        <option v-for="account in accounts.accounts" :key="account.id" :value="account.id">{{ account.nick || account.name || account.id }}</option>
      </select>
    </header>
    <nav class="ranch-nav" aria-label="牧场导航">
      <RouterLink v-for="[path, label] in links" :key="path" :to="path" :aria-current="route.path === path ? 'page' : undefined">{{ label }}</RouterLink>
    </nav>
    <div v-if="!accounts.currentAccountId || (!accounts.currentAccount?.connected && !strategy)" class="activity-offline" role="status">{{ accounts.currentAccountId ? '账号离线，请先启动' : '请选择账号' }}</div>
    <NConfigProvider v-else :theme="app.isDark ? darkTheme : null" :theme-overrides="theme">
      <NNotificationProvider placement="top-right">
        <component :is="panel" :key="`${accounts.currentAccountId}:${route.path}`" />
      </NNotificationProvider>
    </NConfigProvider>
  </section>
</template>

<style scoped>
.ranch-nav { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
.ranch-nav a { padding: 8px 12px; color: var(--ui-muted); border-radius: 8px; text-decoration: none; }
.ranch-nav a[aria-current="page"] { color: var(--ui-ink); background: var(--ui-surface-strong); box-shadow: inset 0 0 0 1px var(--ui-border); }
.ranch-nav a:focus-visible { outline: 2px solid var(--theme-primary, #22c55e); outline-offset: 2px; }
</style>
