import type { BodyModel, GarmentDefinition, GarmentGeometry } from '@fitroom/shared';
import { Lru, garmentCacheKey } from './cache.js';
import { generateGarmentUncached, type GarmentGeometryEx } from './generate.js';

export { GarmentGeometryError } from './errors.js';
export type { GarmentErrorCode } from './errors.js';
export { generateGarmentUncached } from './generate.js';
export type { GarmentBuildInfo, GarmentGeometryEx, ClothTuning } from './generate.js';

const cache = new Lru<GarmentGeometryEx>(24);

/**
 * Geometría de alta resolución de una prenda ajustada a un cuerpo y a una talla.
 * Determinista y con caché LRU por (id de prenda, talla, medidas del cuerpo, definición).
 * Devuelve un objeto de SOLO LECTURA (compartido con la caché).
 */
export function generateGarment(
  def: GarmentDefinition,
  sizeLabel: string,
  body: BodyModel,
): GarmentGeometry {
  const key = garmentCacheKey(def, sizeLabel, body);
  const hit = cache.get(key);
  if (hit) return hit;
  const g = generateGarmentUncached(def, sizeLabel, body);
  cache.set(key, g);
  return g;
}

export function clearGarmentCache(): void {
  cache.clear();
}
