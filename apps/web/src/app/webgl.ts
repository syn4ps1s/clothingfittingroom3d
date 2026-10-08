import { appParams } from './params';

/** ¿Hay WebGL2? (`?webgl=0` lo desactiva para probar la alternativa). Se comprueba una sola vez. */
let cached: boolean | null = null;

export function hasWebgl2(): boolean {
  if (cached !== null) return cached;
  if (appParams().forceNoWebgl) return (cached = false);
  try {
    const canvas = document.createElement('canvas');
    cached = Boolean(canvas.getContext('webgl2'));
  } catch {
    cached = false;
  }
  return cached;
}
