/**
 * Aleatoriedad determinista (sin `Math.random`): hashes enteros de 32 bits y un PRNG pequeño.
 * Todo el generador de texturas deriva de estas funciones, de modo que la misma `seed` produce
 * exactamente los mismos bytes en cualquier plataforma.
 */

/** Mezcla de 32 bits (finalizador tipo "lowbias32"). Devuelve un uint32. */
export function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash de hasta cuatro enteros → uint32. */
export function hashU32(a: number, b = 0, c = 0, d = 0): number {
  let h = mix32((a | 0) ^ 0x9e3779b9);
  h = mix32(h ^ ((b | 0) + 0x85ebca6b));
  h = mix32(h ^ ((c | 0) + 0xc2b2ae35));
  h = mix32(h ^ ((d | 0) + 0x27d4eb2f));
  return h;
}

/** Hash de enteros → número en [0, 1). */
export function hash01(a: number, b = 0, c = 0, d = 0): number {
  return hashU32(a, b, c, d) / 4294967296;
}

/** FNV-1a de una cadena → uint32 (para derivar semillas por defecto de ids). */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** PRNG mulberry32: función `() => [0,1)`. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normaliza una semilla arbitraria (número finito o no) a uint32. */
export function normalizeSeed(seed: number | undefined, fallback: number): number {
  if (seed === undefined || !Number.isFinite(seed)) return fallback >>> 0;
  return mix32(Math.trunc(seed) | 0);
}
