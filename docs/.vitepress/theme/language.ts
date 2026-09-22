import { ref } from 'vue';
import ports from '../../ports.json';

export { ports };
export const language = ref('typescript');
export const storageKey = 'dialcache-docs-language';

export function selectLanguage(value: string) {
  if (!ports.some(port => port.id === value)) return;
  language.value = value;
  try { localStorage.setItem(storageKey, value); } catch { /* Storage may be unavailable. */ }
}

export function restoreLanguage() {
  try {
    const query = new URLSearchParams(window.location.search).get('lang');
    selectLanguage(query ?? localStorage.getItem(storageKey) ?? 'typescript');
  } catch { /* Server rendering and blocked storage use the default. */ }
}
