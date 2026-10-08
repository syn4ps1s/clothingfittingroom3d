/** Errores tipados del paquete de catálogo. Nunca se tragan en silencio: se propagan con causa legible. */
import { isInvisibleCodePoint } from './util.js';

/** Un problema concreto de validación (ruta legible + mensaje acotado, sin eco de datos hostiles sin límite). */
export interface CatalogIssue {
  readonly path: string;
  readonly message: string;
}

const MAX_ISSUES_SHOWN = 8;
const MAX_FIELD_CHARS = 120;

/** Recorta y sanea texto externo antes de incrustarlo en un mensaje de error (sin saltos de línea ni control). */
export function sanitizeForMessage(value: string, max = MAX_FIELD_CHARS): string {
  let clean = '';
  for (const ch of value) {
    clean += isInvisibleCodePoint(ch.codePointAt(0)!) ? ' ' : ch;
    if (clean.length > max) break;
  }
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** Convierte una ruta de zod (`PropertyKey[]`) en `garments[2].variants[0].color`. */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else
      out +=
        out === ''
          ? sanitizeForMessage(String(seg), 40)
          : `.${sanitizeForMessage(String(seg), 40)}`;
  }
  return out === '' ? '(raíz)' : out;
}

function summarize(prefix: string, issues: readonly CatalogIssue[]): string {
  const shown = issues
    .slice(0, MAX_ISSUES_SHOWN)
    .map((i) => `${i.path}: ${sanitizeForMessage(i.message)}`)
    .join('; ');
  const more =
    issues.length > MAX_ISSUES_SHOWN ? ` (+${issues.length - MAX_ISSUES_SHOWN} más)` : '';
  return `${prefix} (${issues.length} problema${issues.length === 1 ? '' : 's'}): ${shown}${more}`;
}

/**
 * Datos de catálogo corruptos o maliciosos. `loadCatalogData`/`createStaticCatalog` fallan SIEMPRE con este error
 * (nunca devuelven un catálogo a medias).
 */
export class CatalogDataError extends Error {
  readonly code = 'CATALOG_INVALID';
  readonly issues: readonly CatalogIssue[];
  constructor(issues: readonly CatalogIssue[]) {
    super(summarize('Catálogo inválido', issues));
    this.name = 'CatalogDataError';
    this.issues = issues;
  }
}

export type SizingErrorCode =
  'invalid-measurements' | 'invalid-sigma' | 'invalid-preference' | 'invalid-garment';

/** Entrada inválida para el tallaje (medidas fuera de rango/NaN, sigma negativa, prenda sin tabla, etc.). */
export class SizingInputError extends Error {
  readonly code: SizingErrorCode;
  readonly issues: readonly CatalogIssue[];
  constructor(code: SizingErrorCode, issues: readonly CatalogIssue[]) {
    super(summarize(`Entrada de tallaje inválida [${code}]`, issues));
    this.name = 'SizingInputError';
    this.code = code;
    this.issues = issues;
  }
}
