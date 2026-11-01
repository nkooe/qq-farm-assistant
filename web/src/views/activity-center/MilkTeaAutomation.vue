<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useAccountStore } from '@/stores/account'
import { useStatusStore } from '@/stores/status'

const props = defineProps<{ snapshot?: any }>()
const { currentAccountId } = storeToRefs(useAccountStore())
const { status, currentStatusReady } = storeToRefs(useStatusStore())
const state = computed(() => (currentStatusReady.value && status.value?.milkTeaAutomation) || props.snapshot)
function time(value: number) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <section v-if="currentAccountId" class="tea-automation" aria-label="奶茶自动经营">
    <strong>全自动经营</strong>
    <p role="status">
      {{ state?.message || '等待账号连接' }}
    </p>
    <div v-if="state" class="check-times">
      <span v-if="state.lastRunAt">上次 {{ time(state.lastRunAt) }}</span><span v-if="state.nextRunAt">下次 {{ time(state.nextRunAt) }}</span>
    </div>
  </section>
</template>

<style scoped>
.tea-automation {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin: 12px;
  padding: 12px 16px;
  border: 1px solid #c7d9bd;
  border-radius: 14px;
  background: #f5faef;
  color: #354a2d;
  font-size: 13px;
  line-height: 1.7;
}
p {
  margin: 0;
}
.check-times {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  font-size: 12px;
}
</style>
