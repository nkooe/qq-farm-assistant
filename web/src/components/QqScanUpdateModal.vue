<script setup lang="ts">
import type { Account } from '@/stores/account'
import { ref } from 'vue'
import QqScanLogin from '@/components/QqScanLogin.vue'
import ModalOverlay from '@/components/ui/ModalOverlay.vue'

defineProps<{ show: boolean, account: Account | null }>()
const emit = defineEmits<{ close: [], saved: [accountId: string] }>()
const saving = ref(false)
</script>

<template>
  <ModalOverlay :show="show" title="QQ 扫码更新" :busy="saving" @close="emit('close')">
    <div class="ui-modal-panel max-w-md w-full rounded-2xl p-5 shadow-2xl" :style="{ background: 'var(--surface-1, #fff)', color: 'var(--theme-text)' }">
      <h3 class="text-base font-semibold">
        QQ 扫码更新
      </h3>
      <p class="mb-4 mt-1 break-words text-sm opacity-70">
        更新账号：{{ account?.nick || account?.name || account?.id }}
      </p>
      <QqScanLogin
        v-if="show && account"
        :key="account.id"
        :account="account"
        @saving="saving = $event"
        @saved="emit('saved', $event)"
        @close="emit('close')"
      />
    </div>
  </ModalOverlay>
</template>
