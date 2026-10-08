import {
  MEASUREMENT_KEYS,
  MEASUREMENT_LIMITS,
  buildRestSkeleton,
  type BodyBase,
  type BodyModel,
  type MeasurementEstimate,
  type MeasurementKey,
  type Measurements,
  type PartialMeasurements,
} from '@fitroom/shared';

/** Proporciones antropométricas medias (fracción de la estatura) por base corporal — SÓLO desarrollo. */
const RATIOS: Record<BodyBase, Record<Exclude<MeasurementKey, 'heightCm' | 'weightKg'>, number>> = {
  neutral: { chestCm: 0.53, waistCm: 0.43, hipCm: 0.56, shoulderWidthCm: 0.235, armLengthCm: 0.34, inseamCm: 0.45, neckCm: 0.205, thighCm: 0.32 },
  feminine: { chestCm: 0.52, waistCm: 0.41, hipCm: 0.58, shoulderWidthCm: 0.222, armLengthCm: 0.335, inseamCm: 0.45, neckCm: 0.195, thighCm: 0.33 },
  masculine: { chestCm: 0.555, waistCm: 0.455, hipCm: 0.55, shoulderWidthCm: 0.25, armLengthCm: 0.345, inseamCm: 0.455, neckCm: 0.215, thighCm: 0.315 },
};

const clamp = (k: MeasurementKey, v: number): number =>
  Math.min(MEASUREMENT_LIMITS[k].max, Math.max(MEASUREMENT_LIMITS[k].min, v));

/** Sustituto de `completeMeasurements` de @fitroom/body mientras no esté READY. */
export function completeMeasurementsFallback(partial: PartialMeasurements): Measurements {
  const base = partial.bodyBase ?? 'neutral';
  const h = partial.heightCm;
  const r = RATIOS[base];
  const out: Record<string, number | string> = { heightCm: h, bodyBase: base };
  out.weightKg = clamp('weightKg', partial.weightKg ?? 22.5 * (h / 100) ** 2);
  for (const k of MEASUREMENT_KEYS) {
    if (k === 'heightCm' || k === 'weightKg') continue;
    out[k] = clamp(k, partial[k] ?? r[k] * h);
  }
  return out as unknown as Measurements;
}

/** Estimación simulada (valores ± sigma) para el escaneo de demostración. */
export function mockEstimate(heightCm: number): MeasurementEstimate {
  const m = completeMeasurementsFallback({ heightCm, bodyBase: 'neutral' });
  const sigma: Record<Exclude<MeasurementKey, 'heightCm'>, number> = {
    weightKg: 8,
    chestCm: 3,
    waistCm: 3.5,
    hipCm: 3,
    shoulderWidthCm: 1.5,
    armLengthCm: 1.6,
    inseamCm: 1.8,
    neckCm: 1.2,
    thighCm: 2.5,
  };
  const est: Record<string, { value: number; sigma: number; source: string }> = {
    heightCm: { value: heightCm, sigma: 0.5, source: 'user' },
  };
  for (const k of MEASUREMENT_KEYS) {
    if (k === 'heightCm') continue;
    est[k] = { value: Math.round(m[k] * 10) / 10, sigma: sigma[k], source: k === 'weightKg' ? 'regression' : 'scan-video' };
  }
  return est as unknown as MeasurementEstimate;
}

/** Cuerpo «hueco» (sin malla) pero con esqueleto real: suficiente para los mocks, que dibujan con las medidas. */
export function makeMockBody(measurements: Measurements): BodyModel {
  return {
    measurements,
    skeleton: buildRestSkeleton(measurements),
    mesh: {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
      skinIndices: new Uint16Array(0),
      skinWeights: new Float32Array(0),
    },
    regions: new Uint8Array(0),
    colliders: [],
  };
}
