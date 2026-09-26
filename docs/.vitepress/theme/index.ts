import { h, nextTick } from 'vue';
import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import LanguageContent from './LanguageContent.vue';
import LanguageSelector from './LanguageSelector.vue';
import LanguageStatus from './LanguageStatus.vue';
import { revealAnchorLanguage } from './language';
import './style.css';

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, {
    'nav-bar-content-before': () => h(LanguageSelector),
    'doc-before': () => h(LanguageStatus),
  }),
  enhanceApp({ app, router }) {
    app.component('LanguageContent', LanguageContent);
    // Same-page search navigation can update the URL without a hashchange.
    router.onAfterRouteChange = async () => {
      await nextTick();
      await revealAnchorLanguage();
    };
  },
} satisfies Theme;
