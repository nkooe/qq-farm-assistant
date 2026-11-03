<script setup lang="ts">
import { computed } from 'vue'
import CollectionsPanel from '../../src/components/CollectionsPanel.vue'
import MallCatalogPanel from '../../src/components/commerce/MallCatalogPanel.vue'
import MutationCatalogPanel from '../../src/components/MutationCatalogPanel.vue'
import { useAccountStore } from '../../src/stores/account'
import { useStatusStore } from '../../src/stores/status'
import { useUserStore } from '../../src/stores/user'

useUserStore().userInfo = { id: 1000, username: 'test-admin', role: 'admin', card: null, accountLimit: -1 }
const account = useAccountStore()
const status = useStatusStore()
account.accounts = [{ id: '1', name: '测试甲', running: true }, { id: '2', name: '测试乙', running: true }]
account.currentAccountId = '1'
status.statusAccountId = '1'
status.status = { connection: { connected: true } }
const page = new URLSearchParams(location.search).get('page')
const propsShop = computed(() => page === 'props')
function switchAccount() {
  account.currentAccountId = account.currentAccountId === '1' ? '2' : '1'
  status.statusAccountId = account.currentAccountId
  status.status = { connection: { connected: true } }
}
</script>

<template>
  <main style="padding: 12px">
    <button data-testid="switch" style="min-height: 44px" @click="switchAccount">
      切换账号
    </button>
    <MallCatalogPanel v-if="page === 'mall' || page === 'props'" :slot-type="1" :props-shop="propsShop" />
    <MutationCatalogPanel v-else-if="page === 'catalog'" />
    <CollectionsPanel v-else />
  </main>
</template>
