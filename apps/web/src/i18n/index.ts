import { useMemo } from 'react';
import { useApp } from '../state/store';
import { makeT, type Lang, type TranslateFn } from './translate';

export * from './translate';
export * from './keys';

/** Idioma activo (suscrito al almacén: funciona también fuera del árbol principal de React). */
export function useLang(): Lang {
  return useApp((s) => s.settings.lang);
}

/** `t()` enlazada al idioma activo. Identidad estable mientras no cambie el idioma. */
export function useT(): TranslateFn {
  const lang = useLang();
  return useMemo(() => makeT(lang), [lang]);
}
