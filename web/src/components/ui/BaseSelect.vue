<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import { useOverlayLayer } from '@/composables/useOverlayLayer'

const props = defineProps<{
  label?: string
  options?: { label: string, value: string | number, disabled?: boolean }[]
  disabled?: boolean
  placeholder?: string
}>()

const emit = defineEmits<{
  (e: 'change', value: string | number): void
}>()

const model = defineModel<string | number>()

const isOpen = ref(false)
const containerRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLButtonElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)
const menuTarget = ref<HTMLElement>(document.body)
const selectId = useId()
const activeIndex = ref(-1)
const position = ref({ top: '0px', left: '0px', width: '0px', maxHeight: '240px' })
const { zIndex } = useOverlayLayer(isOpen, menuRef, () => {
  isOpen.value = false
}, false)

const selectedLabel = computed(() => {
  const selected = props.options?.find(opt => opt.value === model.value)
  return selected ? selected.label : (props.placeholder || '请选择')
})

function updatePosition() {
  if (!triggerRef.value)
    return
  const rect = triggerRef.value.getBoundingClientRect()
  const viewport = window.visualViewport
  let viewTop = viewport?.offsetTop ?? 0
  const viewLeft = viewport?.offsetLeft ?? 0
  let viewBottom = viewTop + (viewport?.height ?? window.innerHeight) - 12
  const dialogBody = triggerRef.value.closest('.ui-dialog-body')
  if (dialogBody) {
    const bodyRect = dialogBody.getBoundingClientRect()
    viewTop = Math.max(viewTop, bodyRect.top)
    viewBottom = Math.min(viewBottom, bodyRect.bottom - 6)
  }
  const dock = document.querySelector<HTMLElement>('[data-floating-dock]')
  if (dock && !triggerRef.value.closest('.ui-modal-overlay, dialog[open]'))
    viewBottom = Math.min(viewBottom, dock.getBoundingClientRect().top - 8)
  const below = Math.max(0, viewBottom - rect.bottom - 6)
  const above = Math.max(0, rect.top - viewTop - 18)
  const desired = Math.min(240, (props.options?.length || 1) * 44 + 10)
  const openAbove = below < desired && above > below
  const height = Math.min(desired, openAbove ? above : below)
  const width = Math.min(rect.width, (viewport?.width ?? window.innerWidth) - 24)
  position.value = {
    top: `${openAbove ? rect.top - height - 6 : rect.bottom + 6}px`,
    left: `${Math.max(viewLeft + 12, Math.min(rect.left, viewLeft + (viewport?.width ?? window.innerWidth) - width - 12))}px`,
    width: `${width}px`,
    maxHeight: `${height}px`,
  }
}

async function openDropdown() {
  if (props.disabled)
    return
  // Native dialogs occupy the browser top layer; keep their selects there too.
  menuTarget.value = triggerRef.value?.closest('dialog[open]') as HTMLElement || document.body
  updatePosition()
  activeIndex.value = props.options?.findIndex(opt => opt.value === model.value && !opt.disabled) ?? -1
  if (activeIndex.value < 0)
    activeIndex.value = props.options?.findIndex(opt => !opt.disabled) ?? -1
  isOpen.value = true
  await nextTick()
  revealActive()
}

function toggleDropdown() {
  if (isOpen.value)
    isOpen.value = false
  else
    openDropdown()
}

function selectOption(value: string | number) {
  model.value = value
  isOpen.value = false
  emit('change', value)
  triggerRef.value?.focus({ preventScroll: true })
}

function closeDropdown(e: PointerEvent) {
  if (!containerRef.value?.contains(e.target as Node) && !menuRef.value?.contains(e.target as Node)) {
    isOpen.value = false
  }
}

function revealActive() {
  menuRef.value?.querySelector<HTMLElement>(`[data-option-index="${activeIndex.value}"]`)?.scrollIntoView({ block: 'nearest' })
}

async function handleKeydown(event: KeyboardEvent) {
  if (props.disabled)
    return
  if (event.key === 'Tab') {
    isOpen.value = false
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key))
    return
  event.preventDefault()
  if (!isOpen.value) {
    await openDropdown()
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    const option = props.options?.[activeIndex.value]
    if (option && !option.disabled)
      selectOption(option.value)
    return
  }
  const enabled = props.options?.map((opt, index) => opt.disabled ? -1 : index).filter(index => index >= 0) || []
  if (!enabled.length)
    return
  const current = enabled.indexOf(activeIndex.value)
  const next = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? enabled.length - 1
      : (current + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length
  activeIndex.value = enabled[next]!
  await nextTick()
  revealActive()
}

function onScroll(event: Event) {
  if (isOpen.value && !menuRef.value?.contains(event.target as Node))
    isOpen.value = false
}
watch(() => props.disabled, (disabled) => {
  if (disabled)
    isOpen.value = false
})
onMounted(() => {
  document.addEventListener('pointerdown', closeDropdown, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', updatePosition)
  window.visualViewport?.addEventListener('resize', updatePosition)
})

onUnmounted(() => {
  document.removeEventListener('pointerdown', closeDropdown, true)
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', updatePosition)
  window.visualViewport?.removeEventListener('resize', updatePosition)
})
</script>

<template>
  <div ref="containerRef" class="flex flex-col gap-1.5">
    <label v-if="label" :id="`${selectId}-label`" :for="selectId" class="text-sm text-gray-700 font-medium dark:text-gray-300">
      {{ label }}
    </label>
    <div class="relative">
      <!-- Trigger -->
      <button
        :id="selectId"
        ref="triggerRef"
        type="button"
        role="combobox"
        :disabled="disabled"
        :aria-expanded="isOpen"
        :aria-controls="`${selectId}-list`"
        :aria-labelledby="label ? `${selectId}-label` : undefined"
        :aria-label="label ? undefined : (placeholder || '请选择')"
        :aria-activedescendant="isOpen && activeIndex >= 0 ? `${selectId}-option-${activeIndex}` : undefined"
        aria-haspopup="listbox"
        class="base-select-trigger w-full flex cursor-pointer items-center justify-between border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none transition-all duration-200 dark:border-gray-700 dark:text-white"
        :class="{
          'bg-gray-50 text-gray-400 cursor-not-allowed dark:bg-gray-800/50': disabled,
          'is-open': isOpen,
        }"
        @click="toggleDropdown"
        @keydown="handleKeydown"
      >
        <span class="truncate">{{ selectedLabel }}</span>
        <div class="i-carbon-chevron-down text-lg text-gray-400 transition-transform duration-200" :class="{ 'rotate-180': isOpen }" />
      </button>

      <!-- Dropdown Menu -->
      <Teleport :to="menuTarget">
        <div
          v-if="isOpen"
          :id="`${selectId}-list`"
          ref="menuRef"
          class="base-select-menu"
          role="listbox"
          :aria-labelledby="label ? `${selectId}-label` : selectId"
          :style="{ ...position, zIndex }"
        >
          <template v-if="options?.length">
            <div
              v-for="(opt, index) in options"
              :id="`${selectId}-option-${index}`"
              :key="opt.value"
              role="option"
              :aria-selected="model === opt.value"
              :aria-disabled="opt.disabled || undefined"
              :data-option-index="index"
              class="base-select-option cursor-pointer px-3 py-2 text-sm transition-colors hover:bg-gray-100 dark:hover:bg-gray-700/50"
              :class="{
                'text-primary': model === opt.value,
                'is-active': activeIndex === index,
                'text-gray-400 cursor-not-allowed hover:bg-transparent dark:text-gray-500': opt.disabled,
                'text-gray-700 dark:text-gray-200': model !== opt.value && !opt.disabled,
              }"
              @click="!opt.disabled && selectOption(opt.value)"
            >
              <slot name="option" :option="opt" :selected="model === opt.value">
                {{ opt.label }}
              </slot>
            </div>
          </template>
          <div v-else class="px-3 py-2 text-center text-sm text-gray-400">
            暂无选项
          </div>
        </div>
      </Teleport>
    </div>
  </div>
</template>

<style scoped>
.base-select-trigger {
  min-height: 44px;
  text-align: left;
  background: var(--input-bg);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.28);
}
.base-select-menu {
  position: fixed;
  overflow-y: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  padding: 4px;
  background: var(--ui-surface);
  color: var(--ui-text);
  box-shadow: 0 12px 32px rgb(15 23 42 / 20%);
}
.base-select-option {
  display: flex;
  align-items: center;
  min-height: 44px;
  border-radius: 6px;
}
.base-select-option.is-active {
  outline: 1px solid var(--theme-primary);
  outline-offset: -1px;
}

.base-select-trigger.is-open {
  border-color: var(--theme-primary);
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--theme-primary) 18%, transparent),
    inset 0 1px 0 rgba(255, 255, 255, 0.32);
}

.text-primary {
  background: color-mix(in srgb, var(--theme-primary) 10%, transparent);
  color: var(--theme-primary);
}
</style>
