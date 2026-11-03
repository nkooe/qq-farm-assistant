<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CollectionsPanel from '@/components/CollectionsPanel.vue'
import IllustratedLegacyPanel from '@/components/IllustratedLegacyPanel.vue'
import MutationCatalogPanel from '@/components/MutationCatalogPanel.vue'

const route = useRoute()
const router = useRouter()
const tab = computed(() => String(route.query.tab || 'crop'))
const tabs = [{ id: 'crop', name: '作物图鉴' }, { id: 'collection', name: '藏品' }, { id: 'catalog', name: '变异宝典' }]
</script>

<template>
  <section class="space-y-4">
    <nav class="flex flex-wrap gap-2" aria-label="图鉴分类">
      <button v-for="item in tabs" :key="item.id" type="button" class="rounded-lg px-4 py-2 text-sm" :class="tab === item.id ? 'bg-emerald-600 text-white' : 'bg-white text-gray-700 dark:bg-gray-800 dark:text-gray-200'" :aria-current="tab === item.id ? 'page' : undefined" @click="router.replace({ query: { ...route.query, tab: item.id } })">
        {{ item.name }}
      </button>
    </nav>
    <CollectionsPanel v-if="tab === 'collection'" />
    <MutationCatalogPanel v-else-if="tab === 'catalog'" />
    <IllustratedLegacyPanel v-else />
  </section>
</template>
