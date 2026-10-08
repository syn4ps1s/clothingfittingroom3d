import {
  type BodyModel,
  type Measurements,
  type WorldCapsule,
  type CapsuleCollider,
} from '@fitroom/shared';
import { LruCache } from './cache.js';
import { buildBodyUncached, buildSteps, measurementsKey, validateBuildInput } from './build.js';

export { completeMeasurements, validateMeasurementCoherence } from './complete.js';
export type { CoherenceCode, CoherenceWarning } from './complete.js';
export { BodyInputError } from './errors.js';
export type { BodyErrorCode, BodyIssue } from './errors.js';
export { worldColliders } from './colliders.js';
export {
  measureBody,
  slicePlane,
  loopPerimeter,
  loopAreaXZ,
  loopCentroid,
  loopContainsXZ,
  clipLoopHalfX,
  torsoGirthCm,
  thighGirthCm,
  crotchHeight,
} from './measure.js';
export type { MeasuredBody, Loop } from './measure.js';
export { analyzeTopology } from './meshops.js';
export type { TopologyReport } from './meshops.js';
export { INSEAM_RATIO_RANGE } from './build.js';
export { buildBodyUncached };

const cache = new LruCache<BodyModel>(8);

/**
 * Construye el cuerpo paramétrico skinneado (A-pose de reposo, pies en y = 0, centrado en x = 0).
 * Determinista y con caché LRU (8 entradas) por clave de medidas: mismas medidas → el MISMO objeto.
 * El resultado es de SOLO LECTURA (no mutar sus arrays tipados: están compartidos con la caché).
 * Lanza `BodyInputError` si las medidas son inválidas o físicamente imposibles.
 */
export function buildBody(measurements: Measurements): BodyModel {
  const m = validateBuildInput(measurements);
  const key = measurementsKey(m);
  const hit = cache.get(key);
  if (hit) return hit;
  const body = buildBodyUncached(m);
  cache.set(key, body);
  return body;
}

/**
 * Igual que `buildBody` pero cede al bucle de eventos entre fases (≈ 20 pausas) para no bloquear la UI.
 * Usa y rellena la misma caché.
 */
export async function buildBodyAsync(measurements: Measurements): Promise<BodyModel> {
  const m = validateBuildInput(measurements);
  const key = measurementsKey(m);
  const hit = cache.get(key);
  if (hit) return hit;
  const gen = buildSteps(m);
  for (;;) {
    const r = gen.next();
    if (r.done) {
      cache.set(key, r.value);
      return r.value;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** Vacía la caché de cuerpos (p. ej. al liberar memoria). */
export function clearBodyCache(): void {
  cache.clear();
}

/** Ajusta la capacidad de la caché LRU (por defecto 8). */
export function setBodyCacheCapacity(n: number): void {
  cache.setCapacity(n);
}

export type { WorldCapsule, CapsuleCollider };
