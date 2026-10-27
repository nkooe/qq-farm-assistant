<script setup lang="ts">
import FarmPanel from '../../src/components/FarmPanel.vue'
import { useAccountStore } from '../../src/stores/account'
import { useFarmStore } from '../../src/stores/farm'
import { useStatusStore } from '../../src/stores/status'

const account = useAccountStore()
const farm = useFarmStore()
const status = useStatusStore()
const metrics = { panelUpdates: 0 }
;(window as any).__farmMetrics = metrics
function recordPanelUpdate() {
  metrics.panelUpdates++
}
account.accounts = [{ id: '1', name: '农场甲', running: true }, { id: '2', name: '农场乙', running: true }]
account.currentAccountId = '1'
function switchAccount() {
  account.currentAccountId = account.currentAccountId === '1' ? '2' : '1'
}
</script>

<template>
  <main data-page-scroll class="fixture-scroll">
    <div class="fixture-tools">
      <button data-testid="switch" @click="switchAccount">
        切换账号
      </button>
      <button data-testid="fetch" @click="farm.fetchLands(account.currentAccountId, { force: true })">
        强制刷新
      </button>
      <button data-testid="merge-fetch" @click="farm.fetchLands(account.currentAccountId)">
        合并刷新
      </button>
      <button data-testid="disconnect" @click="status.status = { connection: { connected: false } }">
        模拟断线
      </button>
    </div>
    <FarmPanel @vue:updated="recordPanelUpdate" />
    <div class="fixture-dock">
      底部导航
    </div>
  </main>
</template>

<style>
.fixture-scroll {
  height: 100dvh;
  overflow-y: auto;
  padding: 12px 12px calc(7rem + env(safe-area-inset-bottom));
}
.fixture-tools {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.fixture-tools button {
  min-height: 44px;
  padding: 8px;
}
.fixture-dock {
  position: fixed;
  bottom: 12px;
  left: 25%;
  width: 50%;
  height: 52px;
  border-radius: 18px;
  background: var(--ui-surface);
  border: 1px solid var(--theme-border);
  display: grid;
  place-items: center;
  z-index: 30;
}
</style>
