import { nextTick, ref } from 'vue';
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

export async function revealAnchorLanguage() {
  if (typeof document === 'undefined') return;
  const hash = window.location.hash;
  let target: HTMLElement | null;
  try { target = document.getElementById(decodeURIComponent(hash.slice(1))); }
  catch { return; }
  const anchoredLanguage = target?.closest<HTMLElement>('[data-language]')?.dataset.language;
  if (!target || !anchoredLanguage || anchoredLanguage === language.value) return;
  selectLanguage(anchoredLanguage);
  await nextTick();
  // VitePress schedules its own scroll using the previously hidden target.
  // Run after it, once Vue has revealed the requested language section.
  requestAnimationFrame(() => {
    if (target.isConnected && language.value === anchoredLanguage && window.location.hash === hash) {
      target.scrollIntoView();
    }
  });
}
