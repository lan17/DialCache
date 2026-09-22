import { h } from 'vue';
import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import LanguageContent from './LanguageContent.vue';
import LanguageSelector from './LanguageSelector.vue';

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { 'doc-before': () => h(LanguageSelector) }),
  enhanceApp({ app }) { app.component('LanguageContent', LanguageContent); },
} satisfies Theme;
