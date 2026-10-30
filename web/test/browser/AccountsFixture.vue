<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import AccountSettingsTab from '../../src/components/settings/AccountSettingsTab.vue'
import { useAccountSettings } from '../../src/composables/settings/useAccountSettings'
import { useAccountStore } from '../../src/stores/account'
import { useUserStore } from '../../src/stores/user'
import Dashboard from '../../src/views/Dashboard.vue'

const showDashboard = new URLSearchParams(location.search).has('dashboard')

// Mount production components and composable; Playwright intercepts every API request.
useUserStore().userInfo = { id: 1000, username: 'test-admin', role: 'admin', card: null, accountLimit: -1 }
const alert = ref('')
const state = reactive(useAccountSettings(message => alert.value = message))
const accountStore = useAccountStore()
onMounted(() => state.fetchAccounts())
</script>

<template>
  <main class="mx-auto max-w-6xl p-3">
    <button data-testid="fetch" @click="state.fetchAccounts">
      更新列表
    </button>
    <button data-testid="force-fetch" @click="accountStore.fetchAccounts({ force: true })">
      强制更新
    </button>
    <p role="alert" class="whitespace-pre-line break-words">
      {{ alert }}
    </p>
    <Dashboard v-if="showDashboard" />
    <AccountSettingsTab
      v-else
      v-bind="state" default-plan-applying-id=""
      @clear-stopped="state.openClearStoppedConfirm" @confirm-clear-stopped="state.confirmClearStopped"
      @close-clear-stopped-confirm="state.showClearStoppedConfirm = false"
      @refresh-wx-codes="state.refreshWxCodesNow" @retry-refresh="state.retryFailedRefresh"
      @select="state.selectAccount" @add="state.openAddModal" @close-modal="state.showModal = false"
      @toggle="state.toggleAccount"
      @saved="state.handleSaved" @refresh="state.handleAccountRefreshed"
    />
  </main>
</template>
