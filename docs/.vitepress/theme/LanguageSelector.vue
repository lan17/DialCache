<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRoute, useRouter, withBase } from 'vitepress';
import { language, ports, restoreLanguage, selectLanguage } from './language';
const route = useRoute();
const router = useRouter();
const nativeGuide = () => ports.find(port =>
  route.path === withBase(port.guide) || route.path === withBase(`${port.guide}.html`))?.id;
const selectedPort = computed(() => ports.find(port => port.id === language.value)!);
function choose(value: string) {
  selectLanguage(value);
  if (nativeGuide()) void router.go(withBase(`/languages/${value}.html`));
}
onMounted(() => {
  restoreLanguage();
  const native = nativeGuide();
  if (native) selectLanguage(native);
});
watch(() => route.path, () => {
  const native = nativeGuide();
  if (native) selectLanguage(native);
});
</script>

<template>
  <label class="language-selector">
    <span>Language</span>
    <select :value="language" aria-label="Documentation language"
      @change="choose(($event.target as HTMLSelectElement).value)">
      <option v-for="port in ports" :key="port.id" :value="port.id">{{ port.label }}</option>
    </select>
    <a :href="withBase(selectedPort.reference)" target="_self">API reference</a>
  </label>
</template>

<style scoped>
.language-selector { display: flex; align-items: center; gap: .65rem; margin-bottom: 1.5rem; font-size: .9rem; color: var(--vp-c-text-2); }
select { border: 1px solid var(--vp-c-divider); border-radius: 6px; padding: .35rem 1.8rem .35rem .6rem; appearance: auto; color: var(--vp-c-text-1); background: var(--vp-c-bg-soft); font: inherit; }
select:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 2px; }
a { color: var(--vp-c-brand-1); }
</style>
