export type Locale = 'ko' | 'en';
let initialized: Locale | undefined;
let override: Locale | undefined;
const valid = (value: unknown): value is string => typeof value === 'string' && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value.trim());
export function resolveLocale(appLanguage?: () => unknown, browserLanguage?: () => unknown): Locale {
  try { const value = appLanguage?.(); if (valid(value)) return value.trim().toLowerCase().startsWith('ko') ? 'ko' : 'en'; } catch { /* Headless API. */ }
  try {
    const value = browserLanguage ? browserLanguage() : typeof navigator !== 'undefined' ? navigator.language : undefined;
    if (valid(value)) return value.trim().toLowerCase().startsWith('ko') ? 'ko' : 'en';
  } catch { /* No browser language. */ }
  return 'en';
}
export function initLocale(appLanguage?: () => unknown): Locale { return initialized ??= resolveLocale(appLanguage); }
export function getLocale(): Locale { return override ?? initLocale(); }
export function setLocaleForTests(value: Locale | undefined): void { override = value; }
export function L<T>(pair: { ko: T; en: T }, locale: Locale = getLocale()): T { return pair[locale]; }
/** Only evaluate the chosen interpolation: previews and formatters may have side effects. */
export function LT(pair: { ko: () => string; en: () => string }, locale: Locale = getLocale()): string { return pair[locale](); }
