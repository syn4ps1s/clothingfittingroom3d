import { clamp, type BodyBase } from '@fitroom/shared';

/**
 * A priori antropométrico para circunferencias (cm): regresión lineal sobre
 * x = [1, (H−170)/10, (IMC−22)/5, s, s·(IMC−22)/5], con s = +1 masculino, −1 femenino, 0 neutro.
 *
 * Los coeficientes y las σ residuales son una COPIA de `@fitroom/body/src/anthropometry.ts` (v1):
 * `pose` no puede depender de `body` en ejecución (ADR 0003), y así el prior del escaneo coincide con
 * el que usa `completeMeasurements` para rellenar el avatar. Un test (`anthropometry.test.ts`, con
 * `@fitroom/body` como devDependency) comprueba que no se desvían.
 */

export type GirthKey = 'chestCm' | 'waistCm' | 'hipCm' | 'shoulderWidthCm' | 'neckCm' | 'thighCm';

export const GIRTH_COEF: Readonly<Record<GirthKey, readonly number[]>> = {
  chestCm: [91.883, 4.272, 8.967, 0.058, 0.746],
  waistCm: [75.532, 3.134, 12.681, 1.821, 0.329],
  hipCm: [96.288, 3.815, 7.567, -3.306, -0.271],
  shoulderWidthCm: [40.562, 2.649, 2.082, 1.474, 0.111],
  neckCm: [34.517, 1.432, 2.371, 1.161, 0.422],
  thighCm: [54.891, 1.926, 5.531, -1.555, 0.197],
};

/** σ poblacional del residuo (cm) tras condicionar por estatura, IMC y sexo. */
export const RESIDUAL_SIGMA: Readonly<Record<GirthKey | 'armLengthCm' | 'inseamCm', number>> = {
  chestCm: 5.0,
  waistCm: 7.0,
  hipCm: 5.5,
  shoulderWidthCm: 2.2,
  neckCm: 2.0,
  thighCm: 3.5,
  armLengthCm: 2.3,
  inseamCm: 2.6,
};

export const SEX_FACTOR: Readonly<Record<BodyBase, number>> = {
  masculine: 1,
  feminine: -1,
  neutral: 0,
};

/** IMC poblacional a priori (adultos sanos) por constitución, y su σ. */
export const PRIOR_BMI: Readonly<Record<BodyBase, number>> = {
  masculine: 23.5,
  feminine: 22,
  neutral: 22.5,
};
export const PRIOR_BMI_SIGMA = 4.5;

export function predictGirth(key: GirthKey, heightCm: number, bmi: number, s: number): number {
  const c = GIRTH_COEF[key];
  const db = (bmi - 22) / 5;
  const f = [1, (heightCm - 170) / 10, db, s, s * db];
  let v = 0;
  for (let i = 0; i < c.length; i++) v += c[i]! * f[i]!;
  return v;
}

/** Derivada de la predicción respecto al IMC (cm por unidad de IMC). */
export function girthSlopeBmi(key: GirthKey, s: number): number {
  const c = GIRTH_COEF[key];
  return (c[2]! + c[4]! * s) / 5;
}

export interface GirthPrior {
  readonly value: number;
  readonly sigma: number;
  /** IMC usado (declarado o a priori) */
  readonly bmi: number;
  /** `true` si el peso era conocido (σ menor) */
  readonly weightKnown: boolean;
}

/**
 * Prior de una circunferencia dado estatura, peso (opcional) y constitución.
 * Sin peso, el IMC es incierto (σ = 4.5) y esa incertidumbre se propaga a la medida.
 */
export function girthPrior(
  key: GirthKey,
  heightCm: number,
  weightKg: number | undefined,
  base: BodyBase = 'neutral',
): GirthPrior {
  const s = SEX_FACTOR[base];
  const known = weightKg !== undefined && Number.isFinite(weightKg) && weightKg > 0;
  const hm = heightCm / 100;
  const bmi = known ? clamp(weightKg / (hm * hm), 14, 60) : PRIOR_BMI[base];
  const value = predictGirth(key, heightCm, bmi, s);
  const resid = RESIDUAL_SIGMA[key];
  const bmiSigma = known ? 0.5 : PRIOR_BMI_SIGMA;
  const sigma = Math.hypot(resid, girthSlopeBmi(key, s) * bmiSigma);
  return { value, sigma, bmi, weightKnown: known };
}
