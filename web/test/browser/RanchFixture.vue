<script setup lang="ts">
import RanchWorkspace from '../../src/views/RanchWorkspace.vue'
import MugePage from '../../src/views/activity-center/MugePage.vue'
import FloatingDock from '../../src/components/FloatingDock.vue'
import { useAccountStore } from '../../src/stores/account'
import { useStatusStore } from '../../src/stores/status'
const accounts = useAccountStore()
accounts.accounts = [{ id: '1', name: '测试牧场甲', connected: true, running: true }, { id: '2', name: '测试牧场乙', connected: true, running: true }]
accounts.currentAccountId = '1'
const status = useStatusStore()
status.connectRealtime = () => {}
status.disconnectRealtime = () => {}
status.fetchStatus = async () => {}
const muge = new URLSearchParams(location.search).has('muge')
</script>
<template>
  <main style="padding: 12px 12px 120px; min-width: 0">
    <button data-testid="switch" @click="accounts.currentAccountId = accounts.currentAccountId === '1' ? '2' : '1'">切换账号</button>
    <MugePage v-if="muge" />
    <RanchWorkspace v-else />
  </main>
  <FloatingDock />
</template>
