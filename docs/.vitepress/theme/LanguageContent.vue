<script setup lang="ts">
import { language as selected } from './language';
defineProps<{ language: string }>();
</script>

<template>
  <div v-show="language === selected" :data-language="language"><slot /></div>
</template>

<style scoped>
/* Leave space for the sticky site header and mobile page navigation. */
:deep([id]) { scroll-margin-top: calc(var(--vp-nav-height) + 48px); }
</style>
