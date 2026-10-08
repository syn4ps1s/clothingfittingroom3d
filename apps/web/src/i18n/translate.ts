import type { LocalizedText } from '@fitroom/shared';
import { en } from './en';
import { es, type MessageKey, type SpanishMessages } from './es';

export type Lang = 'es' | 'en';
export const LANGS: readonly Lang[] = ['es', 'en'];

export type { MessageKey };

/** Extrae los nombres de parámetro `{nombre}` de una plantilla literal. */
type Params<S extends string> = S extends `${string}{${infer P}}${infer Rest}`
  ? P | Params<Rest>
  : never;
type ParamsFor<K extends MessageKey> = Params<SpanishMessages[K]>;

export type TranslateParams = Record<string, string | number>;

export interface TranslateFn {
  /** Clave literal: los parámetros se comprueban en compilación. */
  <K extends MessageKey>(
    key: K,
    ...args: [ParamsFor<K>] extends [never] ? [] : [params: Record<ParamsFor<K>, string | number>]
  ): string;
  /** Clave calculada en tiempo de ejecución (tablas de dominio → clave): sin comprobación de parámetros. */
  dyn(key: MessageKey, params?: TranslateParams): string;
}

const DICTIONARIES: Record<Lang, Record<MessageKey, string>> = { es, en };

export function isLang(value: unknown): value is Lang {
  return value === 'es' || value === 'en';
}

/** Idioma preferido del navegador, restringido a los soportados (por defecto español). */
export function detectLang(languages: readonly string[] | undefined): Lang {
  for (const raw of languages ?? []) {
    const base = raw.toLowerCase().split('-')[0];
    if (base === 'es') return 'es';
    if (base === 'en') return 'en';
  }
  return 'es';
}

export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

/** Traduce una clave. Pura (el idioma se pasa explícito); `useT()` la enlaza al idioma activo. */
export function translate(
  lang: Lang,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  return interpolate(DICTIONARIES[lang][key] ?? es[key], params);
}

export function makeT(lang: Lang): TranslateFn {
  const dyn = (key: MessageKey, params?: TranslateParams) => translate(lang, key, params);
  return Object.assign(
    (key: MessageKey, params?: TranslateParams) => translate(lang, key, params),
    { dyn },
  ) as TranslateFn;
}

/** Texto localizado del catálogo ({es,en}), con respaldo al español. */
export function localized(text: LocalizedText, lang: Lang): string {
  return text[lang] || text.es;
}

export function formatPrice(amount: number, lang: Lang): string {
  return new Intl.NumberFormat(lang === 'es' ? 'es-ES' : 'en-IE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/** Número con separador decimal del idioma. */
export function formatDecimal(value: number, lang: Lang, digits = 1): string {
  return new Intl.NumberFormat(lang, {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
    useGrouping: false,
  }).format(value);
}
