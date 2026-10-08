/** Utilidades puras compartidas por el paquete (texto, congelado, redondeo). */

/**
 * Normaliza texto para búsqueda: NFKD, sin diacríticos, minúsculas, espacios colapsados.
 * «Camisa de LINO» y «camísa de lino» → «camisa de lino». Insensible a acentos y mayúsculas en es/en.
 */
export function normalizeText(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/ß/g, 'ss')
    .replace(/[øØ]/g, 'o')
    .replace(/[æÆ]/g, 'ae')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Congela recursivamente objetos y arrays (los datos del catálogo son inmutables en runtime). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
  }
  return value;
}

/** Redondea a `digits` decimales de forma determinista (evita ruido de coma flotante en la salida). */
export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Mediana de una lista no vacía de números (no muta la entrada). */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Rangos de code points NO permitidos en texto visible: controles C0/C1, separadores de línea Unicode,
 * marcas bidi (Trojan Source), espacios de ancho cero y BOM.
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
];

export function isInvisibleCodePoint(cp: number): boolean {
  for (const [lo, hi] of INVISIBLE_RANGES) if (cp >= lo && cp <= hi) return true;
  return false;
}
