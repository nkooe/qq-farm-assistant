<script setup lang="ts">
import { NConfigProvider } from 'naive-ui/es/config-provider'
import { darkTheme } from 'naive-ui/es/themes/dark'
import { computed } from 'vue'
import { useAppStore } from '@/stores/app'
import { createNaiveThemeOverrides } from '@/ui/naive-theme'

const app = useAppStore()
const overrides = computed(() => createNaiveThemeOverrides(app.isDark))
</script>

<template>
  <NConfigProvider class="game-catalog-theme" :theme="app.isDark ? darkTheme : null" :theme-overrides="overrides">
    <slot />
  </NConfigProvider>
</template>

<style>
/* Keep reset styles from clearing Naive's filled button backgrounds. */
.game-catalog-theme .n-button {
  background-color: var(--n-color);
}
.game-catalog-theme .n-button:hover {
  background-color: var(--n-color-hover);
}
.game-catalog-theme .n-button:active {
  background-color: var(--n-color-pressed);
}
</style>
