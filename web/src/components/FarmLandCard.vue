<script setup lang="ts">
import type { Land } from '@/stores/farm'
import { computed } from 'vue'
import { useLandCountdown } from '@/composables/useFarmClock'

const props = defineProps<{
  land: Land
  selecting: boolean
  selected: boolean
  disabledReason: string
  busy: boolean
}>()
const emit = defineEmits<{
  toggle: [land: Land]
  fertilize: [land: Land]
  remove: [land: Land]
  detail: [land: Land]
}>()
const remaining = useLandCountdown(() => props.land)
const progress = computed(() => Math.max(0, Math.min(100, 100 - remaining.value / props.land.totalGrowTime * 100)))
const canFertilize = computed(() => props.land.status === 'growing' && remaining.value > 0
  && (props.land.organicFertilizerRemaining == null || props.land.organicFertilizerRemaining > 0))
const canRemove = computed(() => props.land.unlocked && !['empty', 'locked'].includes(props.land.status))
const effects = computed(() => (props.land.mutantEffects || []).filter((effect: any) => /^[\w-]+$/.test(effect.icon)))
const imageUrl = computed(() => props.land.seedImage?.replace(/^http:\/\//, 'https://'))
const timeText = computed(() => {
  const sec = Math.floor(remaining.value)
  const h = Math.floor(sec / 3600)
  const m = Math.floor(sec % 3600 / 60)
  return `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`
})
function toggle() {
  if (props.selecting && !props.busy && !props.disabledReason)
    emit('toggle', props.land)
}
function onKeydown(event: KeyboardEvent) {
  if (props.selecting && event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) {
    event.preventDefault()
    toggle()
  }
}
</script>

<template>
  <article
    class="farm-land" :class="{ selected, selecting, unavailable: selecting && disabledReason, slave: land.occupiedByMaster }"
    :data-land-id="land.id" :data-level="land.level" :data-status="land.status"
    :role="selecting ? 'checkbox' : undefined" :tabindex="selecting ? 0 : undefined"
    :aria-checked="selecting ? selected : undefined" :aria-disabled="selecting ? Boolean(busy || disabledReason) : undefined"
    :aria-label="`#${land.id} ${land.plantName || (land.status === 'locked' ? '未解锁' : '空地')}`"
    :aria-describedby="selecting ? `land-hint-${land.id}` : undefined"
    @click="toggle" @keydown="onKeydown"
  >
    <header class="land-header">
      <span class="land-id">#{{ land.id }}</span>
      <button v-if="!selecting" class="detail-button" type="button" :aria-label="`土地 #${land.id} 详情`" @click.stop="emit('detail', land)">
        详情
      </button>
      <span v-if="selecting" class="selection-mark" aria-hidden="true">{{ selected ? '✓' : '○' }}</span>
      <span v-else-if="land.occupiedByMaster" class="merge-label">副地</span>
      <span v-else-if="land.plantSize > 1" class="merge-label">合种主地</span>
    </header>
    <div class="crop-image">
      <img v-if="imageUrl" :src="imageUrl" alt="" loading="lazy" referrerpolicy="no-referrer" width="36" height="36">
      <span v-else class="i-carbon-sprout" aria-hidden="true" />
    </div>
    <strong class="crop-name" :title="land.plantName">{{ land.plantName || (land.status === 'locked' ? '未解锁' : '空地') }}</strong>
    <div class="land-meta">
      <span>{{ land.landTypeName || '普通地' }}</span>
      <span v-if="land.occupiedByMaster" class="merge-info">关联主地 #{{ land.masterLandId }}</span>
      <span v-else-if="land.plantSize > 1" class="merge-info">合种 {{ land.plantSize }}×{{ land.plantSize }}</span>
      <span v-else>季数 {{ land.totalSeason ? `${land.currentSeason}/${land.totalSeason}` : '—' }}</span>
    </div>
    <div class="phase-text" :class="{ ready: land.status === 'harvestable' }">
      {{ land.status === 'growing' ? remaining > 0 ? `${timeText} 后成熟` : '待刷新确认成熟' : land.phaseName || '—' }}
    </div>
    <div v-if="land.totalGrowTime > 0 && land.status === 'growing'" class="crop-progress" aria-hidden="true">
      <div :style="{ width: `${progress}%` }" />
    </div>
    <div v-if="effects.length || land.needWater || land.needWeed || land.needBug || land.needGoldenBug" class="crop-effects">
      <img v-for="effect in effects" :key="effect.id" :src="`/game-config/seed_images_named/mutant/${effect.icon}.png`" :alt="effect.name" :title="effect.name" width="18" height="18" loading="lazy">
      <span v-if="land.needWater">缺水</span><span v-if="land.needWeed">草</span><span v-if="land.needBug">虫</span>
      <span v-if="land.needGoldenBug">黄金虫</span>
    </div>
    <p v-if="selecting" :id="`land-hint-${land.id}`" class="selection-hint">
      {{ disabledReason || (land.occupiedByMaster ? '与主地同步选择' : selected ? '已选择' : '点击选择') }}
    </p>
    <div v-else-if="canFertilize || canRemove" class="land-buttons">
      <button v-if="canFertilize" type="button" :disabled="busy" :aria-label="`催熟 #${land.id}`" @click.stop="emit('fertilize', land)">
        催熟
      </button>
      <button v-if="canRemove" type="button" class="remove-button" :disabled="busy" :aria-label="`铲除 #${land.id}`" @click.stop="emit('remove', land)">
        铲除
      </button>
    </div>
  </article>
</template>

<style scoped>
.farm-land {
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px;
  border: 1px solid var(--theme-border);
  border-radius: 10px;
  background: var(--theme-card-bg, var(--ui-surface));
  color: var(--theme-text);
}
.farm-land[data-level='2'] {
  border-top: 3px solid #df6464;
}
.farm-land[data-level='3'] {
  border-top: 3px solid #64748b;
}
.farm-land[data-level='4'] {
  border-top: 3px solid #d9a62c;
}
.farm-land[data-level='5'] {
  border-top: 3px solid #a78bfa;
}
.farm-land[data-status='locked'] {
  border-style: dashed;
}
.farm-land[data-status='harvestable'] .phase-text {
  font-weight: 700;
  color: var(--farm-accent-text);
}
.land-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: 22px;
  gap: 4px;
}
.detail-button {
  margin-left: auto;
  min-width: 44px;
  min-height: 44px;
  border-radius: 8px;
  background: transparent;
  color: var(--farm-accent-text);
  font-size: 12px;
  cursor: pointer;
}
.land-id,
.land-meta {
  font-size: 11px;
  color: var(--farm-muted);
}
.land-meta {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  column-gap: 6px;
}
.merge-label,
.merge-info {
  color: var(--farm-accent-text);
  font-size: 11px;
}
.slave {
  background: color-mix(in srgb, var(--theme-primary) 4%, var(--ui-surface));
}
.crop-image {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 40px;
  font-size: 24px;
  color: var(--farm-muted);
}
.crop-image img {
  object-fit: contain;
}
.crop-name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.land-meta,
.merge-info,
.phase-text {
  line-height: 1.65;
}
.phase-text {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--farm-muted);
}
.crop-progress {
  width: 100%;
  height: 4px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--theme-border);
  margin: 4px 0;
}
.crop-progress > div {
  height: 100%;
  background: var(--theme-primary);
}
.crop-effects {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 4px;
  min-height: 20px;
  font-size: 11px;
  color: var(--farm-muted);
}
.land-buttons {
  display: flex;
  width: 100%;
  gap: 8px;
  margin-top: auto;
  padding-top: 4px;
}
.land-buttons button {
  min-height: 44px;
  min-width: 44px;
  flex: 1;
  border-radius: 8px;
  font: inherit;
  font-size: 12px;
  color: var(--farm-accent-text);
  background: color-mix(in srgb, var(--theme-primary) 8%, transparent);
  cursor: pointer;
}
.land-buttons .remove-button {
  color: var(--farm-danger);
  background: color-mix(in srgb, #ef4444 8%, transparent);
}
.land-buttons button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.selecting {
  cursor: pointer;
}
.selected {
  border-color: var(--farm-accent-text);
  box-shadow: inset 0 0 0 2px var(--theme-primary);
}
.unavailable {
  cursor: not-allowed;
  border-style: dashed;
}
.unavailable .crop-image {
  opacity: 0.5;
}
.selection-mark {
  font-size: 20px;
  line-height: 1;
  color: var(--farm-accent-text);
}
.selection-hint {
  margin: auto 0 0;
  padding-top: 8px;
  min-height: 32px;
  font-size: 11px;
  color: var(--farm-muted);
  text-align: center;
}
.farm-land:focus-visible,
button:focus-visible {
  outline: 3px solid var(--theme-primary);
  outline-offset: 3px;
}
</style>
