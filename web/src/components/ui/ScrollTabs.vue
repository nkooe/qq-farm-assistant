<script setup lang="ts" generic="T extends string">
import { nextTick, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  items: readonly { key: T, label: string, icon?: string }[]
  label: string
}>()
const active = defineModel<T>({ required: true })
const nav = ref<HTMLElement | null>(null)

async function revealActive() {
  await nextTick()
  const button = nav.value?.querySelector<HTMLElement>('[aria-selected="true"]')
  if (!button || !nav.value) return
  const left = button.offsetLeft - nav.value.offsetLeft
  nav.value.scrollTo({
    left: left - (nav.value.clientWidth - button.offsetWidth) / 2,
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
  })
}

async function handleKey(event: KeyboardEvent, index: number) {
  let next = index
  if (event.key === 'ArrowRight') next = (index + 1) % props.items.length
  else if (event.key === 'ArrowLeft') next = (index + props.items.length - 1) % props.items.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = props.items.length - 1
  else return
  event.preventDefault()
  active.value = props.items[next]!.key
  await nextTick()
  nav.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true })
}

watch(active, revealActive)
onMounted(revealActive)
</script>

<template>
  <nav ref="nav" class="scroll-tabs" role="tablist" :aria-label="label">
    <button
      v-for="(item, index) in items" :key="item.key" type="button" role="tab"
      :aria-selected="active === item.key" :tabindex="active === item.key ? 0 : -1"
      class="scroll-tab" @click="active = item.key" @keydown="handleKey($event, index)"
    >
      <span v-if="item.icon" :class="item.icon" aria-hidden="true" />
      {{ item.label }}
    </button>
  </nav>
</template>

<style scoped>
.scroll-tabs { position: relative; display: flex; max-width: 100%; min-width: 0; gap: 8px; overflow-x: auto; padding: 8px; scrollbar-width: thin; -webkit-overflow-scrolling: touch; }
.scroll-tab { display: flex; flex: 0 0 auto; align-items: center; justify-content: center; gap: 6px; min-height: 44px; padding: 8px 14px; white-space: nowrap; border-radius: 10px; color: var(--muted-text); font-size: 14px; font-weight: 600; cursor: pointer; transition: background-color 150ms, color 150ms; }
.scroll-tab[aria-selected="true"] { color: white; background: var(--theme-primary); }
.scroll-tab:hover { background: color-mix(in srgb, var(--theme-primary) 12%, transparent); color: var(--theme-text); }
.scroll-tab[aria-selected="true"]:hover { background: var(--theme-primary); color: white; }
.scroll-tab:focus-visible { outline: 2px solid var(--theme-primary); outline-offset: -2px; }
@media (prefers-reduced-motion: reduce) { .scroll-tab { transition: none; } }
</style>
