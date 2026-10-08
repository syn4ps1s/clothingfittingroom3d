import type { Texture } from 'three';
import { NotImplementedError } from '@fitroom/shared';
import { generateWrinkleNormalMap } from '@fitroom/garments';
import { makeDataTexture } from './textureCache';

let cached: Texture | null | undefined;

/**
 * Normal map tileable de arrugas, único para toda la sesión (se genera una vez y se comparte).
 * Devuelve null si el generador aún no existe: las prendas se ven bien, sólo sin arrugas por pose.
 */
export function getWrinkleTexture(size: 512 | 1024 = 512): Texture | null {
  if (cached !== undefined) return cached;
  try {
    const data = generateWrinkleNormalMap(size, 7);
    cached = makeDataTexture(data, size);
  } catch (err) {
    if (!(err instanceof NotImplementedError)) {
      console.warn('[mirror] no se pudo generar el mapa de arrugas', err);
    }
    cached = null;
  }
  return cached;
}

/** Sólo para tests: olvida la textura compartida. */
export function resetWrinkleTextureForTests(): void {
  cached?.dispose();
  cached = undefined;
}
