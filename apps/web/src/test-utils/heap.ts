import v8 from 'node:v8';
import vm from 'node:vm';

let gcFn: (() => void) | null | undefined;

/** Recolector forzado (activa --expose-gc en caliente; null si el motor no lo permite). */
export function forceGc(): void {
  if (gcFn === undefined) {
    try {
      v8.setFlagsFromString('--expose-gc');
      gcFn = vm.runInNewContext('gc') as () => void;
    } catch {
      gcFn = null;
    }
  }
  gcFn?.();
}

/**
 * Heurística de «no asigna en el bucle caliente»: mínimo, entre `rounds` rondas, del crecimiento del
 * heap tras ejecutar `fn` `iterations` veces partiendo de un GC forzado. Un bucle que asigna por
 * llamada crece decenas de MB en cada ronda; uno que no asigna queda en ruido del motor (< ~1 MB).
 */
export function minHeapGrowth(
  fn: () => void,
  iterations: number,
  rounds = 5,
  warmup = Math.min(iterations, 4000),
): number {
  // calentamiento: el código sin optimizar (Ignition) boxea cada double y parecería asignar
  for (let i = 0; i < warmup; i++) fn();
  let best = Infinity;
  for (let r = 0; r < rounds; r++) {
    forceGc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < iterations; i++) fn();
    const after = process.memoryUsage().heapUsed;
    best = Math.min(best, after - before);
  }
  return best;
}
