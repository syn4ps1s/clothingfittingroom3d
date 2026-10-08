import {
  J,
  REST_BONE_DIRECTIONS,
  buildRestSkeleton,
  type Measurements,
  type RestSkeleton,
  type Vec3,
} from '@fitroom/shared';
import { clampN, ellipsePerimeter } from './geom.js';

/** Calibración: multiplicadores que el constructor ajusta en bucle cerrado para clavar las medidas. */
export interface Calibration {
  readonly chest: number;
  readonly waist: number;
  readonly hip: number;
  readonly thigh: number;
  readonly neck: number;
  /** Desplazamiento vertical (m) de la base del tronco: sube/baja la entrepierna. */
  readonly crotchDy: number;
}

export const UNIT_CALIBRATION: Calibration = {
  chest: 1,
  waist: 1,
  hip: 1,
  thigh: 1,
  neck: 1,
  crotchDy: 0,
};

/** Alturas de referencia (m) donde se miden las circunferencias. Derivadas del esqueleto. */
export interface Landmarks {
  readonly crotch: number;
  readonly hip: number;
  readonly waist: number;
  readonly chest: number;
  readonly neck: number;
  readonly thigh: number;
  readonly shoulder: number;
}

/**
 * Dimensiones derivadas de las medidas: todo lo que el campo de distancia necesita (en metros).
 * Es una función pura de `Measurements`: mismas medidas → mismas dimensiones.
 */
export interface BodyDims {
  readonly m: Measurements;
  readonly rest: RestSkeleton;
  readonly H: number;
  /** Factor de constitución: +1 masculino, −1 femenino, 0 neutro. */
  readonly s: number;
  readonly bmi: number;
  /** Posición de reposo de cada joint. */
  readonly P: readonly Vec3[];
  readonly lm: Landmarks;
  // circunferencias objetivo (m)
  readonly chestC: number;
  readonly waistC: number;
  readonly hipC: number;
  readonly neckC: number;
  readonly thighC: number;
  readonly halfShoulder: number;
  // proporciones de sección (profundidad/anchura)
  readonly aspectChest: number;
  readonly aspectWaist: number;
  readonly aspectHip: number;
  // extremidades (radios equivalentes, m)
  readonly armR: number; // bíceps
  readonly foreR: number; // antebrazo
  readonly wristR: number;
  readonly calfR: number;
  readonly kneeR: number;
  readonly ankleR: number;
  /** Prominencia de busto (0..1) y de glúteos (0..1) */
  readonly bust: number;
  readonly glute: number;
  readonly belly: number;
}

const SEX = { masculine: 1, feminine: -1, neutral: 0 } as const;

/** Radio de lado rS de una elipse con razón rF/rS = k y perímetro C. */
export function ellipseSideRadius(C: number, k: number): number {
  return C / ellipsePerimeter(k, 1);
}

export function deriveDims(m: Measurements): BodyDims {
  const rest = buildRestSkeleton(m);
  const H = m.heightCm / 100;
  const s = SEX[m.bodyBase];
  const bmi = clampN(m.weightKg / (H * H), 12, 70);
  const P = rest.joints.map((j) => j.position);
  const crotch = m.inseamCm / 100;
  const lm: Landmarks = {
    crotch,
    hip: P[J.l_thigh]![1] - 0.02 * H,
    waist: P[J.spine]![1],
    chest: P[J.chest]![1] - 0.035 * H,
    neck: P[J.neck]![1] + 0.027 * H,
    thigh: crotch - 0.03 * H,
    shoulder: P[J.l_upper_arm]![1],
  };
  const dB = bmi - 22;
  const armC = clampN(0.29 * m.chestCm, 17, 56) / 100;
  const armR = armC / (2 * Math.PI);
  const thighR = m.thighCm / 100 / (2 * Math.PI);
  const calfC = clampN(0.635 * m.thighCm, 18, 62) / 100;
  const bust = clampN(0.5 - 0.5 * s + 0.0, 0, 1) * (m.bodyBase === 'neutral' ? 0.55 : 1);
  return {
    m,
    rest,
    H,
    s,
    bmi,
    P,
    lm,
    chestC: m.chestCm / 100,
    waistC: m.waistCm / 100,
    hipC: m.hipCm / 100,
    neckC: m.neckCm / 100,
    thighC: m.thighCm / 100,
    halfShoulder: m.shoulderWidthCm / 200,
    aspectChest: clampN(0.74 - 0.025 * s + 0.007 * dB, 0.6, 0.95),
    aspectWaist: clampN(0.72 + 0.013 * dB, 0.62, 1.05),
    aspectHip: clampN(0.69 + 0.006 * dB, 0.6, 0.9),
    armR,
    foreR: 0.88 * armR,
    wristR: clampN(0.094 * H * (1 + 0.006 * dB), 0.12, 0.24) / (2 * Math.PI),
    calfR: calfC / (2 * Math.PI),
    kneeR: Math.max(0.97 * (calfC / (2 * Math.PI)), thighR * 0.62),
    ankleR: clampN(0.37 * (m.thighCm / 100), 0.15, 0.3) / (2 * Math.PI),
    bust,
    glute: clampN(0.55 - 0.45 * s, 0, 1),
    belly: clampN((bmi - 24) / 10, 0, 1),
  };
}
