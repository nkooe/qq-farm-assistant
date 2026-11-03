<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import MallCatalogPanel from '@/components/commerce/MallCatalogPanel.vue'
import { useCommerceStore } from '@/stores/commerce'

const route = useRoute()
const router = useRouter()
const commerce = useCommerceStore()
const tab = computed(() => String(route.query.tab || 'mall'))
const tabs = [{ id: 'mall', name: '游戏商城' }, { id: 'limited', name: '限时商店' }, { id: 'props', name: '道具商店' }, { id: 'svip', name: 'SVIP' }]
</script>

<template>
  <section class="space-y-4">
    <nav class="flex flex-wrap items-center gap-2" aria-label="商城分类">
      <RouterLink to="/shop" class="rounded-lg px-4 py-2 text-sm">
        返回农场商店
      </RouterLink>
      <button v-for="item in tabs" :key="item.id" type="button" class="rounded-lg px-4 py-2 text-sm" :class="tab === item.id ? 'bg-emerald-600 text-white' : 'bg-white text-gray-700 dark:bg-gray-800 dark:text-gray-200'" :disabled="commerce.purchasingGoodsId !== null" :aria-current="tab === item.id ? 'page' : undefined" @click="router.replace({ query: { ...route.query, tab: item.id } })">
        {{ item.name }}
      </button>
    </nav>
    <MallCatalogPanel :slot-type="tab === 'svip' ? 4 : tab === 'limited' ? 5 : 1" :props-shop="tab === 'props'" />
  </section>
</template>
