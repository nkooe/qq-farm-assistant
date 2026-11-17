<script setup lang="ts">
import { NTabs } from 'naive-ui/es/tabs'
defineOptions({ inheritAttrs: false })
</script>

<template>
  <NTabs class="page-tabs" type="line" v-bind="$attrs"><slot /></NTabs>
</template>
