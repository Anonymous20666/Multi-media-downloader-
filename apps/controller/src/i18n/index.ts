/**
 * Minimal i18n (§49): keyed strings, locale fallback (→en), {param} interpolation.
 * Full ICU pluralization lands in V1; the call sites already use keys.
 */
import en from "./en.json" with { type: "json" };

const LOCALES: Record<string, Record<string, string>> = { en: en as Record<string, string> };
const DEFAULT = "en";

export function t(key: string, params: Record<string, string | number> = {}, locale = DEFAULT): string {
  const dict = LOCALES[locale] ?? LOCALES[DEFAULT];
  let s = dict[key] ?? LOCALES[DEFAULT][key] ?? key;
  for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

export function availableLocales(): string[] {
  return Object.keys(LOCALES);
}
