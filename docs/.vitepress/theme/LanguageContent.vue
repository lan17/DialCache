<script setup lang="ts">
import { language as selected } from './language';
defineProps<{ language: string }>();
</script>

<template>
  <div v-show="language === selected" :data-language="language"><slot /></div>
</template>
