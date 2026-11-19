<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import RanchCubPriority from '@/components/settings/RanchCubPriority.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { useAccountStore } from '@/stores/account'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'

const accounts = useAccountStore()
const status = useStatusStore()
const toast = useToastStore()
const model = ref<Record<string, any>>({})
const options = ref<Array<{ value: number, label: string, kind: string }>>([])
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const loadedId = ref('')
let generation = 0
const ready = computed(() => !!accounts.currentAccountId && loadedId.value === accounts.currentAccountId)
const switches = [
  ['ranch_harvest', '自动收获'],
  ['ranch_produce', '自动生产'],
  ['ranch_buy', '自动补栏（金券）'],
  ['ranch_upgrade', '自动升级（金券）'],
  ['ranch_sell', '自动出售'],
  ['ranch_clean', '自动清理'],
  ['ranch_grass', '自动补草'],
  ['ranch_grass_buy', '缺草时购买（金券）'],
  ['ranch_market_organic_poop', '粑粑兑换有机化肥'],
  ['ranch_market_organic_pinecone', '松果兑换有机化肥'],
  ['ranch_fill_cans', '填充库存罐头'],
  ['ranch_feed_normal', '普通罐头喂养'],
  ['ranch_feed_organic', '有机罐头喂养'],
  ['ranch_task', '任务奖励'],
  ['ranch_share', '每日分享'],
  ['ranch_daily_benefit', '每日福利'],
] as const
const friendSwitches = [['ranch_friend_steal', '偷取产物'], ['ranch_friend_clean', '清理牧场'], ['ranch_stroke', '抚摸动物'], ['ranch_friend_mosquito', '放蚊子']] as const
const strategies = [{ label: '按已解锁等级', value: 'level' }, { label: '指定动物', value: 'preferred' }, { label: '优先背包幼崽', value: 'bag_priority' }]
const preferred = computed(() => model.value.ranch_strategy === 'preferred' || (model.value.ranch_strategy === 'bag_priority' && model.value.ranch_bag_fallback === 'preferred'))

watch(() => accounts.currentAccountId, async (id) => {
  const version = ++generation
  model.value = {}
  loadedId.value = ''
  error.value = ''
  saving.value = false
  loading.value = !!id
  if (!id)
    return
  try {
    const [settings, animals] = await Promise.all([
      api.get('/api/settings', { headers: { 'x-account-id': id } }),
      api.get('/api/ranch/automation-options'),
    ])
    if (version !== generation)
      return
    if (!settings.data?.ok || !animals.data?.ok)
      throw new Error(settings.data?.error || animals.data?.error || '读取失败')
    model.value = Object.fromEntries(Object.entries(settings.data.data.automation).filter(([key]) => key.startsWith('ranch_')))
    options.value = animals.data.data
    loadedId.value = id
  }
  catch (cause) {
    if (version === generation)
      error.value = getApiErrorMessage(cause, '策略读取失败')
  }
  finally {
    if (version === generation)
      loading.value = false
  }
}, { immediate: true, flush: 'sync' })

async function save() {
  const id = accounts.currentAccountId
  const version = generation
  if (!ready.value || saving.value)
    return
  saving.value = true
  error.value = ''
  try {
    const response = await api.post('/api/settings/save', { automation: model.value }, { headers: { 'x-account-id': id } })
    if (version !== generation)
      return
    if (!response.data?.ok)
      throw new Error(response.data?.error || '保存失败')
    if (response.data.data?.unconfirmed)
      throw new Error('已保存，等待账号应用')
    toast.success('已保存')
  }
  catch (cause) {
    if (version === generation)
      error.value = getApiErrorMessage(cause, '保存失败')
  }
  finally {
    if (version === generation)
      saving.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <p v-if="error" role="alert" class="text-sm text-red-600">
      {{ error }}
    </p>
    <p v-if="loading" role="status">
      加载中…
    </p>
    <template v-else-if="ready">
      <section class="farm-card rounded-2xl p-4">
        <h2 class="mb-4 text-base font-bold">
          养殖策略
        </h2>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <BaseSelect v-model="model.ranch_strategy" label="养殖策略" :options="strategies" />
          <BaseSelect v-if="model.ranch_strategy === 'bag_priority'" v-model="model.ranch_bag_fallback" label="库存不足时" :options="strategies.slice(0, 2)" />
          <template v-if="preferred">
            <BaseSelect v-model="model.ranch_coop_animal" label="窝 · 指定动物" :options="[{ value: 0, label: '不购买' }, ...options.filter(a => a.kind === '窝')]" />
            <BaseSelect v-model="model.ranch_shed_animal" label="棚 · 指定动物" :options="[{ value: 0, label: '不购买' }, ...options.filter(a => a.kind === '棚')]" />
          </template>
          <BaseInput v-model.number="model.ranch_grass_threshold_percent" label="牧草低于（%）时补满" type="number" min="1" max="100" step="1" />
          <BaseInput v-model.number="model.ranch_check_minutes" label="巡查间隔（分钟）" type="number" min="1" max="60" step="1" />
        </div>
        <RanchCubPriority v-if="model.ranch_strategy === 'bag_priority'" v-model="model" class="mt-4" :account-id="accounts.currentAccountId" :connected="status.currentStatusReady && !!status.status?.connection?.connected" />
      </section>
      <section class="farm-card rounded-2xl p-4">
        <h2 class="mb-4 text-base font-bold">
          自动经营
        </h2>
        <div class="grid grid-cols-1 gap-3 lg:grid-cols-3 sm:grid-cols-2">
          <BaseSwitch v-for="[key, label] in switches" :key="key" v-model="model[key]" :label="label" :disabled="saving || key === 'ranch_grass_buy' && !model.ranch_grass" />
        </div>
      </section>
      <section class="farm-card rounded-2xl p-4">
        <h2 class="mb-4 text-base font-bold">
          好友互动
        </h2>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <BaseSwitch v-for="[key, label] in friendSwitches" :key="key" v-model="model[key]" :label="label" :disabled="saving" />
        </div>
      </section>
      <div class="flex justify-end">
        <BaseButton :loading="saving" :disabled="saving" @click="save">
          保存策略
        </BaseButton>
      </div>
    </template>
  </div>
</template>
