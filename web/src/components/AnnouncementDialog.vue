<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useAnnouncementStore } from '@/stores/announcement'

const announcement = useAnnouncementStore()
const error = ref('')
const dialog = ref<HTMLDialogElement | null>(null)
const { pause } = useIntervalFn(() => announcement.refresh(), 60000)
onMounted(() => announcement.refresh())
onUnmounted(pause)

watch([() => announcement.visible, dialog], ([visible, element]) => {
  if (visible && element && !element.open) element.showModal()
  else if (!visible && element?.open) element.close()
}, { flush: 'post', immediate: true })

async function acknowledge() {
  error.value = ''
  try { await announcement.acknowledge() }
  catch { error.value = '记录已读失败，请重试' }
}
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" aria-labelledby="announcement-title" class="announcement-dialog" @cancel.prevent="acknowledge">
      <div v-if="announcement.current">
        <div class="flex items-center gap-2 text-sm font-medium text-gray-500 dark:text-gray-400">
          <span class="i-carbon-notification" aria-hidden="true" /> 系统通知
        </div>
        <h2 id="announcement-title" class="mt-3 break-words text-xl font-bold">{{ announcement.current.title }}</h2>
        <p class="announcement-body">{{ announcement.current.content }}</p>
        <p v-if="error" class="mb-3 text-sm text-red-700 dark:text-red-300" role="alert">{{ error }}</p>
        <div class="flex justify-end">
          <BaseButton autofocus :loading="announcement.saving" @click="acknowledge">我知道了</BaseButton>
        </div>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.announcement-dialog { position: fixed; inset: 0; margin: auto; width: min(calc(100% - 32px), 540px); max-height: 85dvh; overflow-y: auto; padding: 24px; border: 1px solid var(--surface-border); border-radius: 20px; background: var(--surface-1); color: var(--theme-text); box-shadow: var(--surface-shadow); }
.announcement-dialog::backdrop { background: rgb(0 0 0 / 55%); }
.announcement-body { margin: 20px 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 16px; line-height: 1.7; }
</style>
