<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ forecast: any, connected: boolean }>()
const text = computed(() => {
  const f = props.forecast
  if (!props.connected)
    return '账号上线后显示预测'
  if (!f?.estimatedAt)
    return f?.plotCount ? '本轮作物不足升级' : '等待作物或经验数据'
  if (f.source === 'ready')
    return '收获后可升级'
  const minutes = Math.max(1, Math.ceil((f.estimatedAt - f.generatedAt) / 60000))
  const duration = minutes < 60 ? `${minutes} 分钟` : `${(minutes / 60).toFixed(1)} 小时`
  return f.source === 'planted' ? `约 ${duration}后收获可升级` : `约 ${duration}后升级`
})
const basis = computed(() => {
  if (!props.connected)
    return ''
  return ({ ready: '按当前作物', planted: '按当前作物', mixed: '作物排期 + 历史均值', history: '按本次运行历史均值' } as Record<string, string>)[props.forecast?.source] || ''
})
</script>

<template>
  <div class="border-t border-gray-100 px-5 py-3 text-xs leading-relaxed dark:border-gray-700" aria-label="升级预测">
    <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <span class="font-medium text-gray-700 dark:text-gray-200">升级预测 · {{ text }}</span>
      <span v-if="basis" class="text-gray-600 dark:text-gray-400">{{ basis }}</span>
    </div>
    <div v-if="connected && forecast?.plotCount" class="mt-1 text-gray-600 dark:text-gray-400">
      当前季 {{ forecast.plotCount }} 处作物，预计 {{ Number(forecast.scheduledExp).toLocaleString('zh-CN') }} 经验；实际经验以收获为准。
    </div>
    <div v-if="connected && forecast?.plotCount && !forecast.automatic" class="mt-1 text-amber-700 dark:text-amber-400">
      自动农场已暂停，需手动收获或恢复自动农场。
    </div>
  </div>
</template>
