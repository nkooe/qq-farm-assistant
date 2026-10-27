import type { Ref } from 'vue'
import { computed, nextTick, onScopeDispose, shallowReactive, watch } from 'vue'

interface Layer {
  modal: boolean
  element: Ref<HTMLElement | null>
  close: () => void
  previousFocus: HTMLElement | null
}

// All portalled surfaces share one stack, including selects inside a modal.
const layers = shallowReactive<Layer[]>([])
const originalInert = new Map<HTMLElement, boolean>()
const focusableSelector = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

function focusable(element: HTMLElement) {
  return [...element.querySelectorAll<HTMLElement>(focusableSelector)]
    .filter(el => el.getClientRects().length && !el.closest('[inert]'))
}

function updateBackground() {
  for (const [element, inert] of originalInert)
    element.inert = inert
  originalInert.clear()
  let modalIndex = layers.length - 1
  while (modalIndex >= 0 && !layers[modalIndex]?.modal)
    modalIndex -= 1
  document.documentElement.classList.toggle('ui-modal-open', modalIndex >= 0)
  if (modalIndex < 0)
    return
  const app = document.getElementById('app')
  const targets = [app, ...layers.slice(0, modalIndex).map(layer => layer.element.value)]
  for (const target of targets) {
    if (target) {
      originalInert.set(target, target.inert)
      target.inert = true
    }
  }
}

function handleKeydown(event: KeyboardEvent) {
  const top = layers[layers.length - 1]
  if (!top)
    return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopImmediatePropagation()
    top.close()
  }
  else if (event.key === 'Tab' && top.modal && top.element.value) {
    const elements = focusable(top.element.value)
    const first = elements[0]
    const last = elements[elements.length - 1]
    if (!first) {
      event.preventDefault()
      top.element.value.focus({ preventScroll: true })
    }
    else if (event.shiftKey && (document.activeElement === first || document.activeElement === top.element.value || !top.element.value.contains(document.activeElement))) {
      event.preventDefault()
      last?.focus()
    }
    else if (!event.shiftKey && (document.activeElement === last || !top.element.value.contains(document.activeElement))) {
      event.preventDefault()
      first.focus()
    }
  }
}

export function useOverlayLayer(show: Ref<boolean>, element: Ref<HTMLElement | null>, close: () => void, modal = true) {
  const layer: Layer = { modal, element, close, previousFocus: null }
  const zIndex = computed(() => 2000 + Math.max(0, layers.indexOf(layer)) * 2)

  function remove() {
    const index = layers.indexOf(layer)
    if (index < 0)
      return
    const wasTop = index === layers.length - 1
    layers.splice(index, 1)
    updateBackground()
    if (!layers.length)
      document.removeEventListener('keydown', handleKeydown, true)
    if (wasTop && modal) {
      if (layer.previousFocus?.isConnected && !layer.previousFocus.closest('[inert]'))
        layer.previousFocus.focus({ preventScroll: true })
      else
        layers[layers.length - 1]?.element.value?.focus({ preventScroll: true })
    }
  }

  watch(show, async (open) => {
    if (!open) {
      remove()
      return
    }
    layer.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previous = layers[layers.length - 1]
    if (previous && !previous.modal)
      previous.close()
    if (!layers.length)
      document.addEventListener('keydown', handleKeydown, true)
    layers.push(layer)
    updateBackground()
    await nextTick()
    if (!show.value)
      return
    updateBackground()
    if (modal && layers[layers.length - 1] === layer)
      element.value?.focus({ preventScroll: true })
  }, { immediate: true, flush: 'sync' })

  onScopeDispose(remove)
  return { zIndex }
}
