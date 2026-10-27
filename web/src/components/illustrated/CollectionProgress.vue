<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import { useAccountStore } from '@/stores/account'
import { useToastStore } from '@/stores/toast'
import BaseButton from '@/components/ui/BaseButton.vue'

const props = defineProps<{ type: number }>()
const accounts = useAccountStore()
const toast = useToastStore()
const snapshot = ref<any>(null)
const loading = ref(false)
const claiming = ref(false)
const error = ref('')
const group = ref('all')
let sequence = 0
const book = computed(() => props.type === 2 ? snapshot.value?.mutant : snapshot.value?.crop)
const groups = [{ key: 'all', label: '全部' }, { key: 'gold', label: '普通果实' }, { key: 'decoration', label: '装扮果实' }, { key: 'activity', label: '活动果实' }]
const entries = computed<any[]>(() => (book.value?.items || []).filter((item: any) => group.value === 'all' || item.group === group.value))
const progress = computed(() => Math.min(100, 100 * Number(book.value?.progress || 0) / Math.max(1, Number(book.value?.nextLevelProgress || 1))))
async function load() {
  const id = accounts.currentAccountId
  if (!id || !accounts.currentAccount?.connected) return
  const request = ++sequence
  loading.value = true
  error.value = ''
  try {
    const res = await api.get('/api/illustrated/snapshot', { headers: { 'x-account-id': id }, timeout: 120000, skipErrorToast: true } as any)
    if (request !== sequence || id !== accounts.currentAccountId) return
    if (!res.data.ok) throw new Error(res.data.error)
    snapshot.value = res.data.data
  }
  catch (err) { if (request === sequence) error.value = getApiErrorMessage(err) }
  finally { if (request === sequence) loading.value = false }
}
async function claim() {
  if (claiming.value || !book.value?.claimable) return
  const id = accounts.currentAccountId
  const type = props.type
  const request = sequence
  claiming.value = true
  try {
    const res = await api.post('/api/illustrated/claim', { type }, { headers: { 'x-account-id': id }, timeout: 120000 })
    if (request !== sequence || id !== accounts.currentAccountId) return
    if (!res.data.ok) throw new Error(res.data.error)
    snapshot.value = res.data.data.snapshot
    const rewards = res.data.data.rewards || []
    toast.success(`已领取图鉴奖励${rewards.length ? `：${rewards.map((r: any) => `${r.name} ×${r.count}`).join('、')}` : ''}`)
    if (res.data.data.refreshRequired) { error.value = '奖励已领取，进度刷新失败，请点击刷新确认。'; await load() }
  }
  catch (err) { if (id === accounts.currentAccountId) error.value = getApiErrorMessage(err) }
  finally { claiming.value = false }
}
watch(() => [accounts.currentAccountId, accounts.currentAccount?.connected], () => {
  sequence++
  snapshot.value = null
  error.value = ''
  loading.value = false
  void load()
}, { immediate: true })
</script>

<template>
  <div class="mb-4 rounded-xl border border-gray-200 p-4 dark:border-gray-700">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <strong>收集等级 {{ book ? `Lv.${book.level}` : '' }}</strong>
        <p class="my-1 text-sm text-gray-500">{{ book ? `${book.progress} / ${book.nextLevelProgress || '已满级'} 收集点` : '读取等级奖励与分类收集进度' }}</p>
      </div>
      <div class="flex gap-2">
        <BaseButton size="sm" variant="outline" :loading="loading" :disabled="claiming || !accounts.currentAccount?.connected" @click="load">刷新等级</BaseButton>
        <BaseButton size="sm" :loading="claiming" :disabled="!book?.claimable || loading" @click="claim">领取等级奖励</BaseButton>
      </div>
    </div>
    <progress v-if="book" class="my-2 w-full" :value="progress" max="100" aria-label="图鉴等级进度" />
    <p v-if="error" class="text-sm text-red-500" role="alert">{{ error }}</p>
    <div v-if="book?.currentBuffs?.length" class="my-2 flex flex-wrap gap-2 text-xs">
      <span v-for="(buff, index) in book.currentBuffs" :key="index" class="rounded bg-emerald-50 p-2 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">{{ buff.name || buff.description || buff.desc || `属性加成 ${buff.value ?? ''}` }}</span>
    </div>
    <details v-if="book" class="mt-2">
      <summary class="min-h-11 cursor-pointer py-3 text-sm">查看等级奖励与{{ type === 2 ? '变异分类' : '收集进度' }}</summary>
      <div class="mb-3 flex flex-wrap gap-2 text-xs">
        <span v-for="level in book.levels" :key="level.level" class="rounded bg-gray-50 p-2 dark:bg-gray-900/40">Lv.{{ level.level }} · {{ level.claimed ? '已领取' : level.canClaim ? '可领取' : `${level.progress} 点解锁` }}<span v-for="reward in level.rewards" :key="reward.itemId"> · {{ reward.name }} ×{{ reward.count }}</span></span>
      </div>
      <div v-if="type === 2" class="mb-3 flex flex-wrap gap-2">
        <button v-for="entry in groups" :key="entry.key" class="min-h-11 rounded border px-3 text-sm" :aria-pressed="group === entry.key" :class="group === entry.key ? 'border-emerald-500 text-emerald-600' : 'border-gray-200 dark:border-gray-700'" @click="group = entry.key">{{ entry.label }}</button>
      </div>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(125px,1fr))] gap-2">
        <div v-for="item in entries" :key="item.seedId" class="flex items-center gap-2 rounded bg-gray-50 p-2 dark:bg-gray-900/40">
          <img v-if="item.image" :src="item.image" alt="" class="h-9 w-9 object-contain" loading="lazy">
          <div class="min-w-0 text-xs"><div class="truncate" :title="item.name">{{ item.name }}</div><div class="mt-1 opacity-65">{{ item.unlocked ? '已收集' : '未收集' }} · {{ item.progress }} 点</div></div>
        </div>
      </div>
    </details>
  </div>
</template>
