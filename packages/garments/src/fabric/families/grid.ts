import type { FabricDef } from '@fitroom/shared';
import { roundToUnit } from '../lattice.js';
import { hash01 } from '../prng.js';

/** Resolución mínima (px) por hilo/puntada. Por debajo el micro-patrón deja de leerse. */
export const MIN_PX_PER_THREAD = 8;
export const MIN_PX_PER_STITCH = 12;

export interface ThreadGrid {
  /** columnas (hilos de urdimbre / columnas de punto) */
  readonly nu: number;
  /** filas (hilos de trama / hileras) */
  readonly nv: number;
  /** pedidos: threadsPerCm × tileCm */
  readonly requested: number;
  readonly lowered: boolean;
  readonly pxPerThreadU: number;
  readonly pxPerThreadV: number;
}

/**
 * Resuelve cuántos hilos caben en el tile.
 *  - `requested = threadsPerCm × tileCm` (escala física real).
 *  - Se limita a `size / minPx` para conservar ≥ minPx píxeles por hilo; si se baja, `lowered = true`
 *    (los hilos se ven más gruesos que en la realidad pero el tile conserva su tamaño físico).
 *  - Se redondea a múltiplos del repetido del ligamento (para que el tejido encaje sin costura).
 *  - `aspect` escala el nº de filas respecto al de columnas (punto: hileras/columnas ≈ 1,3).
 */
export function resolveThreadGrid(
  fabric: Pick<FabricDef, 'threadsPerCm' | 'tileCm'>,
  size: number,
  repeatU: number,
  repeatV: number,
  minPx = MIN_PX_PER_THREAD,
  aspect = 1,
): ThreadGrid {
  const requested = fabric.threadsPerCm * fabric.tileCm;
  const maxU = Math.floor(size / minPx);
  const maxV = Math.floor((size / minPx) * aspect);
  const nu = roundToUnit(requested, repeatU, maxU);
  const nv = roundToUnit(requested * aspect, repeatV, maxV);
  return {
    nu,
    nv,
    requested,
    lowered: nu < requested * 0.97,
    pxPerThreadU: size / nu,
    pxPerThreadV: size / nv,
  };
}

/** Rellena `row` con ruido uniforme [0,1) determinista para la fila `y` (independiente del orden). */
export function fillRowNoise(row: Float32Array, seed: number, y: number): void {
  let s = (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(y + 1, 0xc2b2ae35)) >>> 0;
  if (s === 0) s = 0x1234567;
  for (let x = 0; x < row.length; x++) {
    // xorshift32
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    row[x] = s * 2.3283064365386963e-10;
  }
}

/** Tabla de hash aleatoria por índice (determinista). */
export function randomTable(n: number, seed: number, stream: number): Float32Array {
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) t[i] = hash01(seed, i, stream, 3);
  return t;
}
