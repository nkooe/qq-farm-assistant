import type { InjectionKey, Ref } from 'vue'
import type { Land } from '@/stores/farm'
import { useIntervalFn } from '@vueuse/core'
import { computed, inject, provide, ref, shallowRef, watch } from 'vue'

interface FarmClock {
  now: Ref<number>
  snapshotAt: Ref<number>
}
const farmClockKey: InjectionKey<FarmClock> = Symbol('farm-clock')

export function useFarmClock(lands: Ref<Land[]>, snapshotAt: Ref<number>, visible: Ref<boolean>) {
  const now = ref(performance.now())
  const expired = shallowRef<ReadonlySet<number>>(new Set())
  let deadlines: Array<{ id: number, at: number }> = []
  let cursor = 0

  function sync() {
    now.value = performance.now()
    if (!deadlines[cursor] || deadlines[cursor]!.at > now.value)
      return
    const next = new Set(expired.value)
    while (deadlines[cursor] && deadlines[cursor]!.at <= now.value)
      next.add(deadlines[cursor++]!.id)
    expired.value = next
  }
  watch([lands, snapshotAt], () => {
    deadlines = lands.value.filter(land => land.status === 'growing' && land.matureInSec > 0)
      .map(land => ({ id: land.id, at: snapshotAt.value + land.matureInSec * 1000 }))
      .sort((a, b) => a.at - b.at)
    cursor = 0
    expired.value = new Set()
    sync()
  }, { immediate: true })

  const { pause, resume } = useIntervalFn(sync, 1000, { immediate: false })
  watch(visible, (value) => {
    if (value) {
      sync()
      resume()
    }
    else {
      pause()
    }
  }, { immediate: true })
  provide(farmClockKey, { now, snapshotAt })
  return { expired }
}

export function useLandCountdown(land: () => Land) {
  const clock = inject(farmClockKey, null)
  return computed(() => {
    const seconds = Math.max(0, Number(land().matureInSec) || 0)
    if (!clock || land().status !== 'growing')
      return seconds
    return Math.max(0, Math.ceil(seconds - Math.max(0, clock.now.value - clock.snapshotAt.value) / 1000))
  })
}
