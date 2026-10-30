<script setup lang="ts">
import { onMounted, ref } from 'vue'
import ProxySettingsTab from '../../src/components/settings/ProxySettingsTab.vue'
import FriendsAddPanel from '../../src/components/friends/FriendsAddPanel.vue'
import { useAppStore } from '../../src/stores/app'
import { useAccountStore } from '../../src/stores/account'
import { useUserStore } from '../../src/stores/user'
import { useSettingStore } from '../../src/stores/setting'
import { useStatusStore } from '../../src/stores/status'
import Dashboard from '../../src/views/Dashboard.vue'

const accountStore = useAccountStore()
const userStore = useUserStore()
const settingStore = useSettingStore()
const statusStore = useStatusStore()
const appStore = useAppStore()
const message = ref('')
const logsLoading = ref(false)
const showProxy = new URLSearchParams(location.search).has('proxy')
const showFriends = new URLSearchParams(location.search).has('friends')
function switchUser() {
  userStore.token = 'fixture-bob-token'
  userStore.userInfo = { id: 1002, username: 'bob', role: 'user', card: null, accountLimit: 2 }
}
function seedPrivateState() {
  statusStore.accountLogs = [{ msg: 'Alice cached private log' }]
  settingStore.settings.offlineReminder.smtpPass = 'Alice cached private password'
}
async function loadLogs() {
  logsLoading.value = true
  try { await accountStore.fetchLogs() }
  finally { logsLoading.value = false }
}
onMounted(() => accountStore.fetchAccounts())
</script>

<template>
  <main class="mx-auto max-w-6xl p-3">
    <div data-testid="selected-account">{{ accountStore.currentAccountId }}</div>
    <div data-testid="loading">{{ accountStore.loading }}</div>
    <div data-testid="account-names">{{ accountStore.accounts.map(a => a.name).join(',') }}</div>
    <button data-testid="switch-user" @click="switchUser">切换用户</button>
    <button data-testid="set-dark-theme" @click="appStore.applyTheme('dark')">深色主题</button>
    <div data-testid="current-theme">{{ appStore.currentTheme }}</div>
    <button data-testid="load-accounts" @click="accountStore.fetchAccounts({ force: true })">加载账号</button>
    <button data-testid="load-logs" @click="loadLogs">加载日志</button>
    <button data-testid="seed-private-state" @click="seedPrivateState">写入测试缓存</button>
    <button data-testid="select-other-account" @click="accountStore.selectAccount('other-account')">切换农场账号</button>
    <div data-testid="account-log-names">{{ accountStore.logs.map(log => log.msg).join(',') }}</div>
    <div data-testid="logs-loading">{{ logsLoading }}</div>
    <div data-testid="private-state">{{ statusStore.accountLogs.map(log => log.msg).join(',') }}{{ settingStore.settings.offlineReminder.smtpPass }}</div>
    <p role="status">{{ message }}</p>
    <ProxySettingsTab v-if="showProxy" :accounts="accountStore.accounts" @notify="text => message = text" />
    <FriendsAddPanel v-else-if="showFriends" account-id="same-account" :account-running="true" />
    <Dashboard v-else />
  </main>
</template>
