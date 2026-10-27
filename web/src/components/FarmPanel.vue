<script setup lang="ts">
import type { Land } from '@/stores/farm'
import type { SelectedFarmAction, SelectedFarmResult } from '@/utils/farm-selection'
import { useDocumentVisibility } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onUnmounted, ref, watch } from 'vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import FarmLandCard from '@/components/FarmLandCard.vue'
import LandDetailModal from '@/components/LandDetailModal.vue'
import { useFarmClock } from '@/composables/useFarmClock'
import { useAccountStore } from '@/stores/account'
import { useFarmStore } from '@/stores/farm'
import { useStatusStore } from '@/stores/status'
import { landDisabledReason, rootLandId, selectedFarmActions } from '@/utils/farm-selection'

const farmStore = useFarmStore()
const accountStore = useAccountStore()
const statusStore = useStatusStore()
const { lands, loading, snapshotAt } = storeToRefs(farmStore)
const visibility = useDocumentVisibility()
const visible = computed(() => visibility.value === 'visible')
const { expired } = useFarmClock(lands, snapshotAt, visible)
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { status, realtimeConnected, currentStatusReady } = storeToRefs(statusStore)
const operating = ref(false)
const farmLoaded = ref(false)
const message = ref('')
const refreshError = ref('')
const needsRefresh = ref(false)
const action = ref<SelectedFarmAction | null>(null)
const selected = ref<number[]>([])
const confirmVisible = ref(false)
const detailLandId = ref<number | null>(null)
let disposed = false
let operationRevision = 0
const confirmConfig = ref({ title: '', message: '', accountId: '', opType: '', action: null as SelectedFarmAction | null, landIds: [] as number[], removeAll: false, type: 'primary' as 'primary' | 'danger' })
const connected = computed(() => Boolean(currentAccount.value?.running && currentStatusReady.value && status.value?.connection?.connected))
const unavailable = computed(() => operating.value || !connected.value)
const landMap = computed(() => new Map(lands.value.map(land => [land.id, land])))
const detailLand = computed(() => detailLandId.value === null ? null : landMap.value.get(detailLandId.value) || null)
const disabledReasons = computed(() => {
  const reasons = new Map<number, string>()
  if (!action.value)
    return reasons
  for (const land of lands.value) {
    if (land.occupiedByMaster)
      continue
    const candidate = action.value.startsWith('fertilize') && expired.value.has(land.id)
      ? { ...land, matureInSec: 0 }
      : land
    reasons.set(land.id, landDisabledReason(candidate, action.value))
  }
  return reasons
})
const selectableIds = computed(() => [...new Set(lands.value.filter(land => !land.occupiedByMaster
  && action.value && !disabledReasons.value.get(land.id)).map(land => land.id))])
const actionLabel = computed(() => selectedFarmActions.find(item => item.action === action.value)?.label || '')

function disabledReason(land: Land) {
  if (!action.value)
    return ''
  const root = rootLandId(land)
  return disabledReasons.value.get(root) ?? landDisabledReason(landMap.value.get(root), action.value)
}
function startSelection(next: SelectedFarmAction) {
  if (unavailable.value)
    return
  action.value = next
  selected.value = []
  message.value = ''
  confirmVisible.value = false
}
function exitSelection() {
  action.value = null
  selected.value = []
  confirmVisible.value = false
}
function toggleLand(land: Land) {
  if (unavailable.value || disabledReason(land))
    return
  const id = rootLandId(land)
  selected.value = selected.value.includes(id) ? selected.value.filter(value => value !== id) : [...selected.value, id].slice(0, 64)
}
function selectAll() {
  if (!unavailable.value)
    selected.value = selectableIds.value.slice(0, 64)
}
function requestSelected(next = action.value, ids = selected.value) {
  if (unavailable.value || needsRefresh.value || !next || !ids.length)
    return
  const label = selectedFarmActions.find(item => item.action === next)!.label
  confirmConfig.value = { accountId: currentAccountId.value, action: next, landIds: [...ids], title: `确认所选土地${label}`, message: `账号：${currentAccount.value?.name || currentAccountId.value}\n仅对主地 ${ids.map(id => `#${id}`).join('、')} 执行${label}（${ids.length} 株作物，合种按一株计算）。\n${next === 'remove' ? '铲除不可恢复。' : next.startsWith('fertilize') ? '每株施肥一次，不会循环消耗肥料。' : ''}`, opType: '', removeAll: false, type: next === 'remove' ? 'danger' : 'primary' }
  confirmVisible.value = true
}
function requestSingle(land: Land, next: SelectedFarmAction) {
  requestSelected(next, [rootLandId(land)])
}

const operations = [
  { type: 'harvest', label: '收获', message: '收获所有成熟作物' },
  { type: 'clear', label: '一键务农', message: '为全场作物浇水、除草、除虫' },
  { type: 'plant', label: '种植', message: '根据策略配置种植全场空地' },
  { type: 'upgrade', label: '升级土地', message: '消耗金币升级所有可升级土地' },
  { type: 'all', label: '一键全收', message: '对全场依次执行务农、收获、种植与升级' },
]
function requestFullFarm(opType: string) {
  if (unavailable.value || needsRefresh.value)
    return
  confirmConfig.value = { accountId: currentAccountId.value, action: null, landIds: [], opType, title: opType === 'removeAll' ? '确认全场铲除' : '确认全场操作', message: `账号：${currentAccount.value?.name || currentAccountId.value}\n${opType === 'removeAll' ? '铲除全场已种植作物，此操作不可恢复。' : `${operations.find(op => op.type === opType)?.message}。`}`, removeAll: opType === 'removeAll', type: opType === 'removeAll' ? 'danger' : 'primary' }
  confirmVisible.value = true
}
function resultMessage(result: SelectedFarmResult) {
  const parts = [`确认成功 ${result.successLandIds.length} 株`, `跳过 ${result.skipped.length} 株`]
  if (result.failedLandIds.length)
    parts.push(`失败 ${result.failedLandIds.length} 株`)
  if (result.unconfirmedLandIds.length)
    parts.push(`结果未确认 ${result.unconfirmedLandIds.length} 株`)
  if (result.fertilizerConsumedSec != null)
    parts.push(`消耗肥料 ${result.fertilizerConsumedSec} 秒`)
  if (result.fertilizerRemainingSec != null)
    parts.push(`剩余肥料 ${result.fertilizerRemainingSec} 秒`)
  return `${parts.join('，')}。${result.skipped.map(item => `#${item.id}：${item.reason}`).join('；')}${result.error ? ` ${result.error}` : ''}${result.uncertain ? ' 请刷新土地并核对结果后再操作。' : ''}`
}
async function executeOperate() {
  const config = { ...confirmConfig.value, landIds: [...confirmConfig.value.landIds] }
  if (!visible.value || !confirmVisible.value || operating.value || needsRefresh.value || !connected.value || config.accountId !== currentAccountId.value)
    return
  confirmVisible.value = false
  operating.value = true
  operationRevision++
  message.value = ''
  try {
    if (config.action) {
      const result = await farmStore.operateSelectedLands(config.accountId, config.action, config.landIds)
      if (config.accountId !== currentAccountId.value)
        return
      message.value = resultMessage(result)
      needsRefresh.value = result.uncertain
      selected.value = selected.value.filter(id => !result.successLandIds.includes(id))
    }
    else if (config.removeAll) {
      await farmStore.removeAllPlants(config.accountId)
      if (config.accountId === currentAccountId.value)
        message.value = '全场铲除请求已完成，请核对土地状态。'
    }
    else {
      await farmStore.operate(config.accountId, config.opType)
      if (config.accountId === currentAccountId.value)
        message.value = '全场操作请求已完成，请核对土地状态。'
    }
  }
  catch (error: any) {
    if (config.accountId === currentAccountId.value) {
      const detail = error?.response?.data?.error || error?.message || '操作失败'
      const timedOut = /timeout|超时|network error/i.test(detail) || (!error.response && Boolean(error.request))
      needsRefresh.value = true
      message.value = timedOut ? '请求中断或超时，结果尚未确认。请刷新土地并核对结果后再操作。' : `${detail}。请刷新土地后再操作。`
    }
  }
  finally {
    if (!disposed && config.accountId === currentAccountId.value && visible.value) {
      try {
        await farmStore.fetchLands(config.accountId, { force: true })
      }
      catch {
        if (config.accountId === currentAccountId.value) {
          refreshError.value = '操作后的土地刷新失败，请手动刷新后核对。'
          needsRefresh.value = true
        }
      }
    }
    else if (config.accountId === currentAccountId.value) {
      needsRefresh.value = true
    }
    operating.value = false
    scheduleRefresh()
  }
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined
let activeRefresh: { id: string, manual: boolean, rerun: boolean, revision: number, promise: Promise<void> } | undefined

function stopRefreshTimer() {
  clearTimeout(refreshTimer)
  refreshTimer = undefined
}
function scheduleRefresh() {
  stopRefreshTimer()
  if (disposed || !visible.value || !currentAccountId.value)
    return
  refreshTimer = setTimeout(() => {
    if (operating.value)
      scheduleRefresh()
    else
      void refresh()
  }, 60000)
}
async function refresh(manual = false, waking = false) {
  const id = currentAccountId.value
  if (disposed || !visible.value || !id || !currentAccount.value)
    return
  if (activeRefresh?.id === id) {
    activeRefresh.manual ||= manual
    activeRefresh.rerun ||= waking
    return activeRefresh.promise
  }
  stopRefreshTimer()
  const task = { id, manual, rerun: false, revision: operationRevision, promise: Promise.resolve() }
  activeRefresh = task
  task.promise = (async () => {
    try {
      if (!realtimeConnected.value)
        await statusStore.fetchStatus(id)
      if (disposed || !visible.value || currentAccountId.value !== id)
        return
      if (currentAccount.value?.running) {
        const applied = await farmStore.fetchLands(id, { force: waking })
        if (applied && !disposed && activeRefresh === task) {
          refreshError.value = ''
          if (task.manual && task.revision === operationRevision)
            needsRefresh.value = false
        }
      }
    }
    catch {
      if (!disposed && activeRefresh === task && id === currentAccountId.value) {
        refreshError.value = '土地刷新失败，当前数据可能已过期。'
        needsRefresh.value = true
      }
    }
    finally {
      if (!disposed && activeRefresh === task && id === currentAccountId.value)
        farmLoaded.value = true
      if (activeRefresh === task) {
        activeRefresh = undefined
        if (task.rerun && !disposed && visible.value && id === currentAccountId.value)
          void refresh(task.manual && task.revision === operationRevision, true)
        else
          scheduleRefresh()
      }
    }
  })()
  return task.promise
}
watch(currentAccountId, (newId, oldId) => {
  detailLandId.value = null
  exitSelection()
  message.value = ''
  refreshError.value = ''
  needsRefresh.value = false
  if (oldId !== undefined && newId !== oldId) {
    activeRefresh = undefined
    farmLoaded.value = false
    farmStore.clearFarmData()
    statusStore.clearAccountScopedData()
  }
  void refresh()
}, { immediate: true })
watch(() => currentAccount.value?.running, () => {
  void refresh()
})
watch(connected, (value) => {
  if (!value)
    detailLandId.value = null
  if (!value)
    exitSelection()
})
watch(selectableIds, (ids) => {
  const eligible = new Set(ids)
  const next = selected.value.filter(id => eligible.has(id))
  if (next.length !== selected.value.length)
    selected.value = next
})

watch(visible, (value) => {
  stopRefreshTimer()
  if (value) {
    void refresh(false, true)
  }
  else {
    confirmVisible.value = false
    detailLandId.value = null
  }
})
onUnmounted(() => {
  disposed = true
  stopRefreshTimer()
})
</script>

<template>
  <div class="farm-panel">
    <div class="farm-section-head">
      <span>全场操作</span>
      <button type="button" class="act-btn" :disabled="operating || loading" @click="refresh(true)">
        刷新土地
      </button>
    </div>
    <div class="farm-actions" aria-label="全场操作">
      <button v-for="op in operations" :key="op.type" type="button" class="act-btn" :disabled="unavailable || needsRefresh" @click="requestFullFarm(op.type)">
        {{ op.label }}
      </button>
      <button type="button" class="act-btn danger" :disabled="unavailable || needsRefresh" @click="requestFullFarm('removeAll')">
        全场铲除
      </button>
    </div>
    <div class="farm-section-head">
      <span>选地操作</span><span class="hint">合种主副地同步选择，按一株操作</span>
    </div>
    <div class="farm-actions" aria-label="选地操作">
      <button
        v-for="item in selectedFarmActions" :key="item.action" type="button" class="act-btn"
        :class="{ active: action === item.action, danger: item.action === 'remove' }"
        :aria-pressed="action === item.action" :disabled="unavailable" @click="startSelection(item.action)"
      >
        选地{{ item.label }}
      </button>
    </div>
    <p v-if="message" role="status" class="operation-message">
      {{ message }}
    </p>
    <p v-if="refreshError" role="alert" class="operation-message">
      {{ refreshError }}
    </p>
    <div v-if="!farmLoaded && loading" class="farm-empty">
      加载土地中…
    </div>
    <div v-else-if="!currentAccountId" class="farm-empty">
      请选择账号
    </div>
    <div v-else-if="!connected" class="farm-empty">
      账号未连接，请先运行账号或检查网络连接
    </div>
    <div v-else-if="!lands.length" class="farm-empty">
      暂无土地数据
    </div>
    <div v-else class="land-grid" :aria-busy="operating">
      <FarmLandCard
        v-for="land in lands" :key="land.id" :land="land" :selecting="Boolean(action)"
        :selected="selected.includes(rootLandId(land))" :disabled-reason="disabledReason(land)" :busy="unavailable || needsRefresh"
        @toggle="toggleLand" @fertilize="requestSingle($event, 'fertilizeOrganic')" @remove="requestSingle($event, 'remove')"
        @detail="detailLandId = $event.id"
      />
    </div>
    <div v-if="action" class="selection-toolbar" aria-label="所选土地操作">
      <div class="selection-summary" aria-live="polite">
        <strong>{{ actionLabel }} · 已选 {{ selected.length }} 株</strong><span class="hint">可选 {{ selectableIds.length }} 株</span>
      </div>
      <div class="selection-controls">
        <button type="button" class="act-btn" :disabled="unavailable || !selectableIds.length" @click="selectAll">
          全选可用
        </button>
        <button type="button" class="act-btn" :disabled="operating || !selected.length" @click="selected = []">
          清空
        </button>
        <button type="button" class="act-btn" :disabled="operating" @click="exitSelection">
          退出选地
        </button>
        <button type="button" class="act-btn execute" :class="{ danger: action === 'remove' }" :disabled="unavailable || needsRefresh || !selected.length" @click="requestSelected()">
          {{ operating ? '执行中…' : `对所选${actionLabel}` }}
        </button>
      </div>
      <p v-if="needsRefresh" class="hint">
        请先刷新土地并核对操作结果。
      </p>
    </div>
    <LandDetailModal :land="detailLand" :player="status?.status" :connected="connected" @close="detailLandId = null" />
    <ConfirmModal :show="confirmVisible" :title="confirmConfig.title" :message="confirmConfig.message" :type="confirmConfig.type" :loading="operating" @confirm="executeOperate" @close="confirmVisible = false" @cancel="confirmVisible = false" />
  </div>
</template>

<style scoped>
.farm-panel {
  --farm-muted: #56685e;
  --farm-accent-text: #167c45;
  --farm-danger: #c62828;
  display: flex;
  flex-direction: column;
  gap: 12px;
  color: var(--theme-text);
}
.dark .farm-panel {
  --farm-muted: #acb9b1;
  --farm-accent-text: #4ade80;
  --farm-danger: #fca5a5;
}
.farm-section-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}
.hint {
  font-size: 11px;
  color: var(--farm-muted);
  font-weight: 400;
}
.farm-actions,
.selection-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.act-btn {
  min-height: 44px;
  min-width: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 8px 14px;
  border: 1px solid var(--theme-border);
  border-radius: 10px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  background: var(--ui-surface);
  color: var(--theme-text);
  touch-action: manipulation;
}
.act-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.act-btn:focus-visible {
  outline: 3px solid var(--theme-primary);
  outline-offset: 3px;
}
.act-btn.active,
.execute {
  border-color: var(--farm-accent-text);
  color: var(--farm-accent-text);
  background: color-mix(in srgb, var(--theme-primary) 10%, var(--ui-surface));
}
.danger {
  color: var(--farm-danger);
}
.land-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, max(156px, calc((100% - 48px) / 7))), 1fr));
  gap: 8px;
}
.farm-empty {
  text-align: center;
  padding: 40px 12px;
  color: var(--farm-muted);
  font-size: 14px;
}
.operation-message {
  padding: 12px;
  border: 1px solid var(--theme-border);
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.selection-toolbar {
  position: sticky;
  bottom: calc(5rem + env(safe-area-inset-bottom, 0px));
  z-index: 15;
  padding: 12px;
  border: 1px solid var(--theme-border);
  border-radius: 14px;
  background: var(--ui-surface);
  box-shadow: 0 4px 22px rgb(0 0 0 / 12%);
}
.selection-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  font-size: 13px;
}
.selection-controls .execute {
  margin-left: auto;
}
@media (max-width: 480px) {
  .land-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .selection-controls {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .selection-controls .act-btn {
    padding: 8px;
  }
  .selection-controls .execute {
    grid-column: 1 / -1;
    width: 100%;
  }
}
</style>
