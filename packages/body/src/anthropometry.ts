import type { BodyBase, MeasurementKey } from '@fitroom/shared';

/**
 * Modelo antropométrico (ver docs/anthropometry.md). Regresiones lineales en cm sobre
 * x = [1, (H−170)/10, (IMC−22)/5, s, s·(IMC−22)/5], con s = +1 masculino, −1 femenino, 0 neutro.
 * Los coeficientes se ajustaron por mínimos cuadrados a los perfiles de referencia del repositorio y a
 * medias publicadas aproximadas (ANSUR II / NHANES) por IMC y sexo.
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

/** Desviación típica poblacional del residuo (cm) tras condicionar por estatura, IMC y sexo. */
export const RESIDUAL_SIGMA: Readonly<
  Record<GirthKey | 'armLengthCm' | 'inseamCm', number>
> = {
  chestCm: 5.0,
  waistCm: 7.0,
  hipCm: 5.5,
  shoulderWidthCm: 2.2,
  neckCm: 2.0,
  thighCm: 3.5,
  armLengthCm: 2.3,
  inseamCm: 2.6,
};

/** Orden de las variables del modelo de residuos. */
export const RESIDUAL_KEYS = [
  'chestCm',
  'waistCm',
  'hipCm',
  'shoulderWidthCm',
  'neckCm',
  'thighCm',
  'armLengthCm',
  'inseamCm',
] as const satisfies readonly MeasurementKey[];
export type ResidualKey = (typeof RESIDUAL_KEYS)[number];

/** Correlaciones de los residuos (triángulo superior; simétrica, diagonal 1). */
const CORR_UPPER: ReadonlyArray<readonly [ResidualKey, ResidualKey, number]> = [
  ['chestCm', 'waistCm', 0.55],
  ['chestCm', 'hipCm', 0.45],
  ['chestCm', 'shoulderWidthCm', 0.4],
  ['chestCm', 'neckCm', 0.5],
  ['chestCm', 'thighCm', 0.35],
  ['chestCm', 'armLengthCm', 0.15],
  ['chestCm', 'inseamCm', 0.05],
  ['waistCm', 'hipCm', 0.5],
  ['waistCm', 'shoulderWidthCm', 0.15],
  ['waistCm', 'neckCm', 0.4],
  ['waistCm', 'thighCm', 0.35],
  ['hipCm', 'shoulderWidthCm', 0.15],
  ['hipCm', 'neckCm', 0.25],
  ['hipCm', 'thighCm', 0.6],
  ['hipCm', 'armLengthCm', 0.05],
  ['hipCm', 'inseamCm', 0.05],
  ['shoulderWidthCm', 'neckCm', 0.35],
  ['shoulderWidthCm', 'thighCm', 0.1],
  ['shoulderWidthCm', 'armLengthCm', 0.3],
  ['shoulderWidthCm', 'inseamCm', 0.15],
  ['neckCm', 'thighCm', 0.2],
  ['neckCm', 'armLengthCm', 0.1],
  ['neckCm', 'inseamCm', 0.05],
  ['thighCm', 'armLengthCm', 0.05],
  ['thighCm', 'inseamCm', 0.15],
  ['armLengthCm', 'inseamCm', 0.45],
];

export function correlation(a: ResidualKey, b: ResidualKey): number {
  if (a === b) return 1;
  for (const [x, y, r] of CORR_UPPER) if ((x === a && y === b) || (x === b && y === a)) return r;
  return 0;
}

export const SEX_FACTOR: Readonly<Record<BodyBase, number>> = {
  masculine: 1,
  feminine: -1,
  neutral: 0,
};

/** IMC poblacional a priori (adultos sanos) por constitución. */
export const PRIOR_BMI: Readonly<Record<BodyBase, number>> = {
  masculine: 23.5,
  feminine: 22,
  neutral: 22.5,
};
export const PRIOR_BMI_SIGMA = 4.5;

export function girthFeatures(heightCm: number, bmi: number, s: number): number[] {
  const db = (bmi - 22) / 5;
  return [1, (heightCm - 170) / 10, db, s, s * db];
}

export function predictGirth(key: GirthKey, heightCm: number, bmi: number, s: number): number {
  const c = GIRTH_COEF[key];
  const f = girthFeatures(heightCm, bmi, s);
  let v = 0;
  for (let i = 0; i < c.length; i++) v += c[i]! * f[i]!;
  return v;
}

/** Derivada de la predicción respecto al IMC (cm por unidad de IMC). */
export function girthSlopeBmi(key: GirthKey, s: number): number {
  const c = GIRTH_COEF[key];
  return (c[2]! + c[4]! * s) / 5;
}

/** Proporciones lineales (fracción de la estatura) — Drillis & Contini / NASA-STD-3000, ajustadas a los perfiles de referencia. */
export function predictInseam(heightCm: number): number {
  return 0.4545 * heightCm;
}

export function predictArmLength(heightCm: number, s: number): number {
  return heightCm * (0.3375 + 0.0035 * s + 0.0003 * (heightCm - 170));
}

/** Resuelve A·x = b (A simétrica definida positiva, tamaño pequeño) por eliminación gaussiana con pivote. */
export function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r]![i]!) > Math.abs(M[p]![i]!)) p = r;
    const tmp = M[i]!;
    M[i] = M[p]!;
    M[p] = tmp;
    const piv = M[i]![i]!;
    if (Math.abs(piv) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = M[r]![i]! / piv;
      for (let c = i; c <= n; c++) M[r]![c] = M[r]![c]! - f * M[i]![c]!;
    }
  }
  return M.map((row, i) => (Math.abs(row[i]!) < 1e-12 ? 0 : row[n]! / row[i]!));
}
