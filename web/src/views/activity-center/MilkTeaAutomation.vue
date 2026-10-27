<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onUnmounted, ref, watch } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'
import { useStatusStore } from '@/stores/status'

const props = defineProps<{ snapshot?: any }>()
const { currentAccountId } = storeToRefs(useAccountStore())
const { status, currentStatusReady } = storeToRefs(useStatusStore())
const state = computed(() => (currentStatusReady.value && status.value?.milkTeaAutomation) || props.snapshot)
const enabled = ref(false)
const saving = ref(false)
const error = ref('')
let generation = 0
watch(currentAccountId, () => {
  generation++
  saving.value = false
  error.value = ''
  enabled.value = false
})
watch([currentAccountId, () => state.value?.enabled], ([, value]) => enabled.value = !!value, { immediate: true })
function time(value: number) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
async function toggle(event: Event) {
  const next = (event.target as HTMLInputElement).checked
  const id = String(currentAccountId.value)
  const token = ++generation
  enabled.value = next
  saving.value = true
  error.value = ''
  try {
    const { data } = await api.post('/api/automation', { milk_tea: next }, { headers: { 'x-account-id': id } })
    if (!data?.ok)
      throw new Error(data?.error || '保存失败')
    if (token === generation)
      enabled.value = data.data?.automation?.milk_tea ?? next
  }
  catch {
    if (token === generation) {
      enabled.value = !next
      error.value = '自动领取设置保存失败，请重试。'
    }
  }
  finally {
    if (token === generation)
      saving.value = false
  }
}
onUnmounted(() => generation++)
</script>

<template>
  <section v-if="currentAccountId" class="tea-automation" aria-label="奶茶自动领取">
    <label><input type="checkbox" :checked="enabled" :disabled="saving || !state" @change="toggle"><strong>自动领取</strong><span v-if="saving">保存中…</span></label>
    <p>每5分钟领取营业收益、工作工资和已解锁基金奖励，关闭页面后继续运行。需先手动开业；制作、雇佣、爆单等操作由你决定。</p>
    <p role="status">
      {{ error || (!enabled && state ? '自动领取已关闭' : state?.message || '等待账号同步自动领取状态') }}
    </p>
    <div v-if="enabled && state" class="check-times">
      <span v-if="state.lastRunAt">上次检查 {{ time(state.lastRunAt) }}</span><span v-if="state.nextRunAt">下次检查 {{ time(state.nextRunAt) }}</span>
    </div>
  </section>
</template>

<style scoped>
.tea-automation {
  margin: 12px;
  padding: 12px 16px;
  border: 1px solid #c7d9bd;
  border-radius: 14px;
  background: #f5faef;
  color: #354a2d;
  font-size: 13px;
  line-height: 1.7;
}
@container (min-width: 960px) {
  .tea-automation {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    column-gap: 24px;
    padding: 12px 18px;
  }
  label {
    grid-column: 1;
    grid-row: 1;
  }
  p:first-of-type {
    grid-column: 1;
    grid-row: 2;
  }
  p[role='status'] {
    grid-column: 2;
    grid-row: 1;
    align-self: center;
  }
  .check-times {
    grid-column: 2;
    grid-row: 2;
    align-self: center;
    justify-content: flex-end;
  }
}
label {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  cursor: pointer;
}
input {
  width: 22px;
  height: 22px;
  accent-color: #427736;
}
input:focus-visible {
  outline: 3px solid #427736;
  outline-offset: 4px;
}
p {
  margin: 4px 0;
}
.check-times {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  font-size: 12px;
}
</style>
