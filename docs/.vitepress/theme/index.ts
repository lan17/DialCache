import { h, nextTick } from 'vue';
import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import LanguageContent from './LanguageContent.vue';
import LanguageSelector from './LanguageSelector.vue';
import { revealAnchorLanguage } from './language';

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { 'doc-before': () => h(LanguageSelector) }),
  enhanceApp({ app, router }) {
    app.component('LanguageContent', LanguageContent);
    // Same-page search navigation can update the URL without a hashchange.
    router.onAfterRouteChange = async () => {
      await nextTick();
      await revealAnchorLanguage();
    };
  },
} satisfies Theme;
