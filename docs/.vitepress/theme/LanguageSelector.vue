<script setup lang="ts">
import { onMounted, watch } from 'vue';
import { useData, useRoute, useRouter, withBase } from 'vitepress';
import { language, ports, restoreLanguage, revealAnchorLanguage, selectLanguage } from './language';
const route = useRoute();
const router = useRouter();
const { hash } = useData();
const nativeGuide = () => ports.find(port =>
  route.path === withBase(port.guide) || route.path === withBase(`${port.guide}.html`))?.id;
function choose(value: string) {
  selectLanguage(value);
  if (nativeGuide()) void router.go(withBase(`/languages/${value}.html`));
}
function syncNativeGuide() {
  const native = nativeGuide();
  if (native) selectLanguage(native);
}
onMounted(() => {
  restoreLanguage();
  syncNativeGuide();
  void revealAnchorLanguage();
});
watch(() => route.path, syncNativeGuide);
watch(hash, revealAnchorLanguage, { flush: 'post' });
</script>

<template>
  <div class="language-selector">
    <div class="language-options" role="group" aria-label="Documentation language">
      <button v-for="port in ports" :key="port.id" type="button"
        :aria-pressed="language === port.id" @click="choose(port.id)">
        {{ port.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.language-selector { display: flex; flex-shrink: 0; align-items: center; font-size: 13px; }
.language-options { display: inline-flex; gap: .2rem; padding: .2rem; border: 1px solid var(--vp-c-divider); border-radius: 9px; background: var(--vp-c-bg-soft); }
button { min-height: 32px; padding: .25rem .65rem; border-radius: 6px; color: var(--vp-c-text-2); font: inherit; font-weight: 600; cursor: pointer; }
button:hover { color: var(--vp-c-text-1); background: var(--vp-c-default-soft); }
button[aria-pressed="true"] { color: var(--vp-button-brand-text); background: var(--vp-button-brand-bg); }
button:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 2px; }
</style>
