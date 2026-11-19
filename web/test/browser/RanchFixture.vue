<script setup lang="ts">
import FloatingDock from '../../src/components/FloatingDock.vue'
import { useAccountStore } from '../../src/stores/account'
import { useStatusStore } from '../../src/stores/status'
import MugePage from '../../src/views/activity-center/MugePage.vue'
import RanchWorkspace from '../../src/views/RanchWorkspace.vue'

const accounts = useAccountStore()
accounts.accounts = [{ id: '1', name: '测试牧场甲', connected: true, running: true }, { id: '2', name: '测试牧场乙', connected: true, running: true }]
accounts.currentAccountId = '1'
const status = useStatusStore()
if (new URLSearchParams(location.search).has('connected')) {
  status.status = { accountId: '1', connection: { connected: true }, mugeAutomation: { message: '暂无奖励', nextRunAt: Date.now() + 300000 } }
  status.statusAccountId = '1'
}
status.connectRealtime = () => {}
status.disconnectRealtime = () => {}
status.fetchStatus = async () => {}
const muge = new URLSearchParams(location.search).has('muge')
</script>

<template>
  <main style="padding: 12px 12px 120px; min-width: 0">
    <button data-testid="switch" @click="accounts.currentAccountId = accounts.currentAccountId === '1' ? '2' : '1'">
      切换账号
    </button>
    <MugePage v-if="muge" />
    <RanchWorkspace v-else />
  </main>
  <FloatingDock />
</template>
