/**
 * Utilidades SOLO para tests (no forman parte de la API pública): generadores de medidas, comprobaciones
 * geométricas independientes de la implementación (orientación por trazado de rayos, simetría, poses).
 */
import fc from 'fast-check';
import {
  BODY_BASES,
  J,
  MEASUREMENT_LIMITS,
  q,
  restPose,
  type BodyModel,
  type MeasurementKey,
  type Measurements,
  type PartialMeasurements,
  type Quat,
  type SkeletonPose,
} from '@fitroom/shared';
import { completeMeasurements } from './complete.js';

/** Medidas COHERENTES (generadas con la regresión) con estatura, IMC y constitución aleatorios. */
export const coherentMeasurements = (): fc.Arbitrary<Measurements> =>
  fc
    .record({
      h: fc.integer({ min: 125, max: 225 }),
      bmi: fc.integer({ min: 160, max: 400 }),
      base: fc.constantFrom(...BODY_BASES),
    })
    .map(({ h, bmi, base }) =>
      completeMeasurements({
        heightCm: h,
        weightKg: Math.min(250, Math.max(30, (bmi / 10) * (h / 100) * (h / 100))),
        bodyBase: base,
      }),
    );

/** Entrada parcial arbitraria dentro de los límites (subconjunto de claves). */
export const partialMeasurements = (): fc.Arbitrary<PartialMeasurements> => {
  const num = (k: MeasurementKey): fc.Arbitrary<number> =>
    fc.double({
      min: MEASUREMENT_LIMITS[k].min,
      max: MEASUREMENT_LIMITS[k].max,
      noNaN: true,
      noDefaultInfinity: true,
    });
  const opt = (k: MeasurementKey): fc.Arbitrary<number | undefined> =>
    fc.option(num(k), { nil: undefined });
  return fc
    .record({
      heightCm: num('heightCm'),
      weightKg: opt('weightKg'),
      chestCm: opt('chestCm'),
      waistCm: opt('waistCm'),
      hipCm: opt('hipCm'),
      shoulderWidthCm: opt('shoulderWidthCm'),
      armLengthCm: opt('armLengthCm'),
      inseamCm: opt('inseamCm'),
      neckCm: opt('neckCm'),
      thighCm: opt('thighCm'),
      bodyBase: fc.option(fc.constantFrom(...BODY_BASES), { nil: undefined }),
    })
    .map((r) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) if (v !== undefined) out[k] = v;
      return out as PartialMeasurements;
    });
};

export const MIN_MEASUREMENTS = (base: Measurements['bodyBase'] = 'neutral'): Measurements => ({
  heightCm: MEASUREMENT_LIMITS.heightCm.min,
  weightKg: MEASUREMENT_LIMITS.weightKg.min,
  chestCm: MEASUREMENT_LIMITS.chestCm.min,
  waistCm: MEASUREMENT_LIMITS.waistCm.min,
  hipCm: MEASUREMENT_LIMITS.hipCm.min,
  shoulderWidthCm: MEASUREMENT_LIMITS.shoulderWidthCm.min,
  armLengthCm: MEASUREMENT_LIMITS.armLengthCm.min,
  inseamCm: MEASUREMENT_LIMITS.inseamCm.min,
  neckCm: MEASUREMENT_LIMITS.neckCm.min,
  thighCm: MEASUREMENT_LIMITS.thighCm.min,
  bodyBase: base,
});

export const MAX_MEASUREMENTS = (base: Measurements['bodyBase'] = 'neutral'): Measurements => ({
  heightCm: MEASUREMENT_LIMITS.heightCm.max,
  weightKg: MEASUREMENT_LIMITS.weightKg.max,
  chestCm: MEASUREMENT_LIMITS.chestCm.max,
  waistCm: MEASUREMENT_LIMITS.waistCm.max,
  hipCm: MEASUREMENT_LIMITS.hipCm.max,
  shoulderWidthCm: MEASUREMENT_LIMITS.shoulderWidthCm.max,
  armLengthCm: MEASUREMENT_LIMITS.armLengthCm.max,
  inseamCm: MEASUREMENT_LIMITS.inseamCm.max,
  neckCm: MEASUREMENT_LIMITS.neckCm.max,
  thighCm: MEASUREMENT_LIMITS.thighCm.max,
  bodyBase: base,
});

/** ¿Está el punto dentro de la malla cerrada? Paridad de cruces de un rayo en dirección irracional. */
export function isInside(
  positions: Float32Array,
  indices: Uint32Array,
  p: readonly [number, number, number],
): boolean {
  const d = [0.5773502691896258, 0.3711, 0.7258];
  const n = Math.hypot(d[0]!, d[1]!, d[2]!);
  const dx = d[0]! / n;
  const dy = d[1]! / n;
  const dz = d[2]! / n;
  let hits = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const e1x = positions[b]! - positions[a]!;
    const e1y = positions[b + 1]! - positions[a + 1]!;
    const e1z = positions[b + 2]! - positions[a + 2]!;
    const e2x = positions[c]! - positions[a]!;
    const e2y = positions[c + 1]! - positions[a + 1]!;
    const e2z = positions[c + 2]! - positions[a + 2]!;
    const hx = dy * e2z - dz * e2y;
    const hy = dz * e2x - dx * e2z;
    const hz = dx * e2y - dy * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < 1e-14) continue;
    const inv = 1 / det;
    const sx = p[0] - positions[a]!;
    const sy = p[1] - positions[a + 1]!;
    const sz = p[2] - positions[a + 2]!;
    const u = (sx * hx + sy * hy + sz * hz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (tt > 0) hits++;
  }
  return hits % 2 === 1;
}

/** Mayor distancia (m) de un vértice a su espejo X más cercano: mide la simetría izquierda/derecha. */
export function mirrorError(positions: Float32Array): number {
  const n = positions.length / 3;
  const cell = 0.004;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number): string =>
    `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let v = 0; v < n; v++) {
    const k = key(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!);
    const l = grid.get(k);
    if (l) l.push(v);
    else grid.set(k, [v]);
  }
  let worst = 0;
  for (let v = 0; v < n; v += 3) {
    const x = -positions[v * 3]!;
    const y = positions[v * 3 + 1]!;
    const z = positions[v * 3 + 2]!;
    const ci = Math.floor(x / cell);
    const cj = Math.floor(y / cell);
    const ck = Math.floor(z / cell);
    let best = Infinity;
    for (let r = 1; r <= 4 && best === Infinity; r++) {
      for (let k = ck - r; k <= ck + r; k++)
        for (let j = cj - r; j <= cj + r; j++)
          for (let i = ci - r; i <= ci + r; i++) {
            const l = grid.get(`${i},${j},${k}`);
            if (!l) continue;
            for (const w of l) {
              const d = Math.hypot(
                positions[w * 3]! - x,
                positions[w * 3 + 1]! - y,
                positions[w * 3 + 2]! - z,
              );
              if (d < best) best = d;
            }
          }
    }
    if (best > worst) worst = best;
  }
  return worst;
}

const deg = (d: number): number => (d * Math.PI) / 180;

/** Poses extremas de prueba (rotaciones locales sobre el reposo). */
export const TEST_POSES: Readonly<Record<string, Readonly<Record<number, Quat>>>> = {
  armsUp: {
    [J.l_upper_arm]: q.fromAxisAngle([0, 0, 1], deg(140)),
    [J.r_upper_arm]: q.fromAxisAngle([0, 0, 1], deg(-140)),
  },
  armsForward: {
    [J.l_upper_arm]: q.fromAxisAngle([1, 0, 0], deg(-80)),
    [J.r_upper_arm]: q.fromAxisAngle([1, 0, 0], deg(-80)),
  },
  elbowBend: {
    [J.l_upper_arm]: q.fromAxisAngle([1, 0, 0], deg(-60)),
    [J.l_forearm]: q.fromAxisAngle([-0.788, -0.616, 0], deg(110)),
  },
  sit: {
    [J.l_thigh]: q.fromAxisAngle([1, 0, 0], deg(-90)),
    [J.r_thigh]: q.fromAxisAngle([1, 0, 0], deg(-90)),
    [J.l_calf]: q.fromAxisAngle([1, 0, 0], deg(90)),
    [J.r_calf]: q.fromAxisAngle([1, 0, 0], deg(90)),
  },
  legRaise: {
    [J.l_thigh]: q.fromAxisAngle([1, 0, 0], deg(-80)),
    [J.l_calf]: q.fromAxisAngle([1, 0, 0], deg(40)),
  },
  twist: {
    [J.spine]: q.fromAxisAngle([0, 1, 0], deg(20)),
    [J.chest]: q.fromAxisAngle([0, 1, 0], deg(25)),
    [J.head]: q.fromAxisAngle([0, 1, 0], deg(30)),
  },
  bendForward: {
    [J.spine]: q.fromAxisAngle([1, 0, 0], deg(-30)),
    [J.chest]: q.fromAxisAngle([1, 0, 0], deg(-30)),
  },
};

export function poseOf(body: BodyModel, rots: Readonly<Record<number, Quat>>): SkeletonPose {
  const rp = restPose(body.skeleton);
  return { ...rp, rotations: rp.rotations.map((r, i) => rots[i] ?? r) };
}

/** Volumen firmado (m³) de una malla triangular con posiciones dadas. */
export function signedVolume(positions: ArrayLike<number>, indices: Uint32Array): number {
  let vol = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    vol +=
      (positions[a]! * (positions[b + 1]! * positions[c + 2]! - positions[b + 2]! * positions[c + 1]!) -
        positions[a + 1]! * (positions[b]! * positions[c + 2]! - positions[b + 2]! * positions[c]!) +
        positions[a + 2]! * (positions[b]! * positions[c + 1]! - positions[b + 1]! * positions[c]!)) /
      6;
  }
  return vol;
}
