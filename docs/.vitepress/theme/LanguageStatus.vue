<script setup lang="ts">
import { computed } from 'vue';
import { withBase } from 'vitepress';
import { language, ports } from './language';

const selectedPort = computed(() => ports.find(port => port.id === language.value)!);
</script>

<template>
  <p class="language-status">
    <strong>TypeScript</strong> is the reference implementation.
    <strong>Go and Rust</strong> are experimental.
    <a :href="withBase(selectedPort.reference)" target="_self">{{ selectedPort.label }} API reference</a>
  </p>
</template>

<style scoped>
.language-status { margin: 0 0 1.5rem; font-size: .85rem; line-height: 1.5; color: var(--vp-c-text-2); }
a { display: block; margin-top: .5rem; color: var(--vp-c-brand-1); }
</style>
