<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, toRef } from 'vue'
import { useOverlayLayer } from '@/composables/useOverlayLayer'

const props = withDefaults(defineProps<{
  show: boolean
  title: string
  busy?: boolean
}>(), { busy: false })
const emit = defineEmits<{ close: [] }>()
const overlay = ref<HTMLElement | null>(null)
const viewport = ref({ top: 0, left: 0, width: window.innerWidth, height: window.innerHeight })
function close() {
  if (!props.busy)
    emit('close')
}
const { zIndex } = useOverlayLayer(toRef(props, 'show'), overlay, close)
const viewportStyle = computed(() => ({
  top: `${viewport.value.top}px`,
  left: `${viewport.value.left}px`,
  width: `${viewport.value.width}px`,
  height: `${viewport.value.height}px`,
  zIndex: zIndex.value,
}))
function updateViewport() {
  const view = window.visualViewport
  viewport.value = {
    top: view?.offsetTop ?? 0,
    left: view?.offsetLeft ?? 0,
    width: view?.width ?? window.innerWidth,
    height: view?.height ?? window.innerHeight,
  }
}
onMounted(() => {
  updateViewport()
  window.addEventListener('resize', updateViewport)
  window.visualViewport?.addEventListener('resize', updateViewport)
  window.visualViewport?.addEventListener('scroll', updateViewport)
})
onUnmounted(() => {
  window.removeEventListener('resize', updateViewport)
  window.visualViewport?.removeEventListener('resize', updateViewport)
  window.visualViewport?.removeEventListener('scroll', updateViewport)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="show"
      ref="overlay"
      class="ui-modal-overlay"
      :style="viewportStyle"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      :aria-busy="busy"
      tabindex="-1"
      @click.self="close"
      @wheel.self.prevent
      @touchmove.self.prevent
    >
      <slot />
    </div>
  </Teleport>
</template>
