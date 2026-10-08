import {
  MEASUREMENT_LIMITS,
  MeasurementsSchema,
  PartialMeasurementsSchema,
  type BodyBase,
  type MeasurementKey,
  type Measurements,
  type PartialMeasurements,
} from '@fitroom/shared';
import { BodyInputError } from './errors.js';
import { clampN } from './geom.js';
import {
  PRIOR_BMI,
  PRIOR_BMI_SIGMA,
  RESIDUAL_KEYS,
  RESIDUAL_SIGMA,
  SEX_FACTOR,
  correlation,
  girthSlopeBmi,
  predictArmLength,
  predictGirth,
  predictInseam,
  solveLinear,
  type GirthKey,
  type ResidualKey,
} from './anthropometry.js';

const GIRTH_KEYS: readonly GirthKey[] = [
  'chestCm',
  'waistCm',
  'hipCm',
  'shoulderWidthCm',
  'neckCm',
  'thighCm',
];

const lim = (k: MeasurementKey) => MEASUREMENT_LIMITS[k];
const clampKey = (k: MeasurementKey, v: number): number => clampN(v, lim(k).min, lim(k).max);

/** Valida la entrada parcial en el borde con zod y lanza un error tipado si no es válida. */
export function parsePartial(input: unknown): PartialMeasurements {
  const parsed = PartialMeasurementsSchema.safeParse(input);
  if (!parsed.success) {
    throw new BodyInputError(
      'invalid-measurements',
      'las medidas parciales no cumplen PartialMeasurementsSchema',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return parsed.data;
}

/** IMC estimado: del peso si está, y si no, combinación bayesiana de lo que digan las circunferencias dadas. */
function estimateBmi(p: PartialMeasurements, base: BodyBase): number {
  const H = p.heightCm;
  if (p.weightKg !== undefined) return clampN(p.weightKg / ((H / 100) * (H / 100)), 12, 70);
  const s = SEX_FACTOR[base];
  let num = PRIOR_BMI[base] / (PRIOR_BMI_SIGMA * PRIOR_BMI_SIGMA);
  let den = 1 / (PRIOR_BMI_SIGMA * PRIOR_BMI_SIGMA);
  for (const k of ['waistCm', 'hipCm', 'chestCm', 'thighCm', 'neckCm'] as const) {
    const g = p[k];
    if (g === undefined) continue;
    const slope = girthSlopeBmi(k, s);
    if (slope < 0.3) continue;
    const bmiK = 22 + (g - predictGirth(k, H, 22, s)) / slope;
    // varianza de la estimación (σ del residuo inflada ×1,5 por correlaciones entre medidas)
    const varK = Math.pow((1.5 * RESIDUAL_SIGMA[k]) / slope, 2);
    num += bmiK / varK;
    den += 1 / varK;
  }
  return clampN(num / den, 13, 60);
}

/**
 * Completa medidas parciales (sólo `heightCm` es obligatoria).
 *
 * Reglas:
 *  1. Los valores dados por la persona se conservan SIEMPRE, tal cual.
 *  2. El IMC se toma del peso (si está) o se infiere de las circunferencias dadas (bayesiano con a priori
 *     poblacional); a partir de él y de la estatura/constitución se predicen las medidas que faltan.
 *  3. Los residuos de las medidas dadas respecto de su predicción se transfieren a las que faltan por
 *     condicionamiento gaussiano (p. ej. quien tiene la cintura más ancha de lo esperado tiende a tener
 *     también más cadera y pecho).
 *  4. Las medidas derivadas se acotan a rangos coherentes entre sí y con los límites de plausibilidad.
 *
 * Lanza `BodyInputError('invalid-measurements')` si la entrada no es válida (NaN, ±Inf, fuera de rango,
 * claves desconocidas…). Si la entrada es válida pero internamente incoherente NO falla: conserva lo dado
 * (ver `validateMeasurementCoherence`).
 */
export function completeMeasurements(partial: PartialMeasurements): Measurements {
  const p = parsePartial(partial);
  const H = p.heightCm;
  const base: BodyBase = p.bodyBase ?? 'neutral';
  const s = SEX_FACTOR[base];
  const bmi = estimateBmi(p, base);

  // --- predicciones base
  const pred: Record<ResidualKey, number> = {
    chestCm: predictGirth('chestCm', H, bmi, s),
    waistCm: predictGirth('waistCm', H, bmi, s),
    hipCm: predictGirth('hipCm', H, bmi, s),
    shoulderWidthCm: predictGirth('shoulderWidthCm', H, bmi, s),
    neckCm: predictGirth('neckCm', H, bmi, s),
    thighCm: predictGirth('thighCm', H, bmi, s),
    armLengthCm: predictArmLength(H, s),
    inseamCm: predictInseam(H),
  };

  // --- condicionamiento gaussiano de los residuos
  const given = RESIDUAL_KEYS.filter((k) => p[k] !== undefined);
  const missing = RESIDUAL_KEYS.filter((k) => p[k] === undefined);
  const resid: Record<string, number> = {};
  if (given.length > 0 && missing.length > 0) {
    const z = given.map((k) => ((p[k] as number) - pred[k]) / RESIDUAL_SIGMA[k]);
    const Sgg = given.map((a, i) =>
      given.map((b, j) => correlation(a, b) + (i === j ? 0.05 : 0)),
    );
    const w = solveLinear(Sgg, z);
    for (const m of missing) {
      let zm = 0;
      for (let i = 0; i < given.length; i++) zm += correlation(m, given[i]!) * w[i]!;
      // el condicionamiento no puede dar más de ±1,8 σ de desviación a una medida no observada
      resid[m] = clampN(zm, -1.8, 1.8) * RESIDUAL_SIGMA[m];
    }
  }

  const out: Record<string, number | BodyBase> = {};
  const value = (k: ResidualKey): number => {
    const user = p[k];
    if (user !== undefined) return user;
    return pred[k] + (resid[k] ?? 0);
  };

  // --- derivadas con coherencia mutua (sólo se acotan las derivadas)
  const chest = p.chestCm ?? clampKey('chestCm', value('chestCm'));
  const hip0 = p.hipCm ?? clampKey('hipCm', value('hipCm'));
  const waist0 = p.waistCm ?? value('waistCm');
  const waist = p.waistCm ?? clampKey('waistCm', clampN(waist0, 0.62 * Math.min(chest, hip0), 1.12 * Math.max(chest, hip0)));
  const hip = hip0;
  const thighRaw = value('thighCm');
  const thigh =
    p.thighCm ?? clampKey('thighCm', clampN(thighRaw, 0.4 * hip, 0.68 * hip));
  const neckRaw = value('neckCm');
  const neck = p.neckCm ?? clampKey('neckCm', clampN(neckRaw, 0.27 * chest, 0.46 * chest));
  const shoulder =
    p.shoulderWidthCm ??
    clampKey('shoulderWidthCm', clampN(value('shoulderWidthCm'), 0.2 * H, 0.29 * H));
  const arm =
    p.armLengthCm ?? clampKey('armLengthCm', clampN(value('armLengthCm'), 0.3 * H, 0.375 * H));
  const inseam = p.inseamCm ?? clampKey('inseamCm', clampN(value('inseamCm'), 0.42 * H, 0.49 * H));
  const weight = p.weightKg ?? clampKey('weightKg', bmi * (H / 100) * (H / 100));

  out.heightCm = H;
  out.weightKg = weight;
  out.chestCm = chest;
  out.waistCm = waist;
  out.hipCm = hip;
  out.shoulderWidthCm = shoulder;
  out.armLengthCm = arm;
  out.inseamCm = inseam;
  out.neckCm = neck;
  out.thighCm = thigh;
  out.bodyBase = base;
  // garantía final (nunca debería fallar: todo está acotado a los límites)
  const checked = MeasurementsSchema.safeParse(out);
  if (!checked.success) {
    throw new BodyInputError(
      'internal',
      'completeMeasurements produjo medidas fuera de esquema',
      checked.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return checked.data;
}

// ------------------------------------------------------------------ coherencia

export type CoherenceCode =
  | 'waist-exceeds-hip'
  | 'waist-exceeds-chest'
  | 'chest-hip-mismatch'
  | 'thigh-too-large-for-hip'
  | 'thigh-too-small-for-hip'
  | 'neck-too-large-for-chest'
  | 'neck-too-small-for-chest'
  | 'shoulder-narrow-for-chest'
  | 'shoulder-ratio-implausible'
  | 'inseam-ratio-implausible'
  | 'arm-length-ratio-implausible'
  | 'bmi-girth-mismatch'
  | 'bmi-extreme';

export interface CoherenceWarning {
  readonly code: CoherenceCode;
  /** info: inusual; warning: poco probable; error: físicamente implausible (el cuerpo se genera igual, pero sin garantías de aspecto) */
  readonly severity: 'info' | 'warning' | 'error';
  readonly keys: readonly MeasurementKey[];
  readonly message: string;
  /** Valor observado de la razón/diferencia y el rango típico esperado */
  readonly value: number;
  readonly expected: readonly [number, number];
}

/**
 * Detecta incoherencias entre medidas (no falla nunca): p. ej. cintura > cadera por 40 cm, muslo mayor que la
 * cadera, entrepierna imposible para la estatura. Acepta medidas completas o parciales (sólo evalúa lo presente).
 */
export function validateMeasurementCoherence(m: PartialMeasurements): CoherenceWarning[] {
  const out: CoherenceWarning[] = [];
  const push = (w: CoherenceWarning): void => {
    out.push(w);
  };
  const H = m.heightCm;
  const sev = (v: number, warn: number, err: number, dir: 1 | -1): 'info' | 'warning' | 'error' | undefined => {
    if (dir === 1) return v > err ? 'error' : v > warn ? 'warning' : undefined;
    return v < err ? 'error' : v < warn ? 'warning' : undefined;
  };
  if (m.waistCm !== undefined && m.hipCm !== undefined) {
    const d = m.waistCm - m.hipCm;
    const sv = sev(d, 10, 25, 1);
    if (sv)
      push({
        code: 'waist-exceeds-hip',
        severity: sv,
        keys: ['waistCm', 'hipCm'],
        message: `La cintura (${m.waistCm} cm) supera a la cadera (${m.hipCm} cm) en ${d.toFixed(0)} cm.`,
        value: d,
        expected: [-40, 10],
      });
  }
  if (m.waistCm !== undefined && m.chestCm !== undefined) {
    const d = m.waistCm - m.chestCm;
    const sv = sev(d, 10, 25, 1);
    if (sv)
      push({
        code: 'waist-exceeds-chest',
        severity: sv,
        keys: ['waistCm', 'chestCm'],
        message: `La cintura (${m.waistCm} cm) supera al pecho (${m.chestCm} cm) en ${d.toFixed(0)} cm.`,
        value: d,
        expected: [-40, 10],
      });
  }
  if (m.chestCm !== undefined && m.hipCm !== undefined) {
    const d = Math.abs(m.chestCm - m.hipCm);
    const sv = sev(d, 30, 45, 1);
    if (sv)
      push({
        code: 'chest-hip-mismatch',
        severity: sv,
        keys: ['chestCm', 'hipCm'],
        message: `Pecho (${m.chestCm} cm) y cadera (${m.hipCm} cm) difieren en ${d.toFixed(0)} cm.`,
        value: d,
        expected: [0, 30],
      });
  }
  if (m.thighCm !== undefined && m.hipCm !== undefined) {
    const r = m.thighCm / m.hipCm;
    const hi = sev(r, 0.72, 0.85, 1);
    if (hi)
      push({
        code: 'thigh-too-large-for-hip',
        severity: hi,
        keys: ['thighCm', 'hipCm'],
        message: `El muslo (${m.thighCm} cm) es ${(r * 100).toFixed(0)} % de la cadera (${m.hipCm} cm).`,
        value: r,
        expected: [0.45, 0.72],
      });
    const lo = sev(r, 0.4, 0.3, -1);
    if (lo)
      push({
        code: 'thigh-too-small-for-hip',
        severity: lo,
        keys: ['thighCm', 'hipCm'],
        message: `El muslo (${m.thighCm} cm) es sólo ${(r * 100).toFixed(0)} % de la cadera (${m.hipCm} cm).`,
        value: r,
        expected: [0.45, 0.72],
      });
  }
  if (m.neckCm !== undefined && m.chestCm !== undefined) {
    const r = m.neckCm / m.chestCm;
    const hi = sev(r, 0.48, 0.6, 1);
    if (hi)
      push({
        code: 'neck-too-large-for-chest',
        severity: hi,
        keys: ['neckCm', 'chestCm'],
        message: `El cuello (${m.neckCm} cm) es ${(r * 100).toFixed(0)} % del pecho (${m.chestCm} cm).`,
        value: r,
        expected: [0.3, 0.48],
      });
    const lo = sev(r, 0.25, 0.2, -1);
    if (lo)
      push({
        code: 'neck-too-small-for-chest',
        severity: lo,
        keys: ['neckCm', 'chestCm'],
        message: `El cuello (${m.neckCm} cm) es sólo ${(r * 100).toFixed(0)} % del pecho (${m.chestCm} cm).`,
        value: r,
        expected: [0.3, 0.48],
      });
  }
  if (m.shoulderWidthCm !== undefined && m.chestCm !== undefined) {
    const r = m.shoulderWidthCm / m.chestCm;
    const sv = sev(r, 0.36, 0.3, -1);
    if (sv)
      push({
        code: 'shoulder-narrow-for-chest',
        severity: sv,
        keys: ['shoulderWidthCm', 'chestCm'],
        message: `Hombros (${m.shoulderWidthCm} cm) muy estrechos para un pecho de ${m.chestCm} cm: los brazos quedarían dentro del tronco.`,
        value: r,
        expected: [0.36, 0.6],
      });
  }
  if (m.shoulderWidthCm !== undefined) {
    const r = m.shoulderWidthCm / H;
    const hi = sev(r, 0.3, 0.34, 1);
    const lo = sev(r, 0.19, 0.16, -1);
    const sv = hi ?? lo;
    if (sv)
      push({
        code: 'shoulder-ratio-implausible',
        severity: sv,
        keys: ['shoulderWidthCm', 'heightCm'],
        message: `El ancho de hombros es ${(r * 100).toFixed(0)} % de la estatura.`,
        value: r,
        expected: [0.19, 0.3],
      });
  }
  if (m.inseamCm !== undefined) {
    const r = m.inseamCm / H;
    const hi = sev(r, 0.5, 0.52, 1);
    const lo = sev(r, 0.4, 0.33, -1);
    const sv = hi ?? lo;
    if (sv)
      push({
        code: 'inseam-ratio-implausible',
        severity: sv,
        keys: ['inseamCm', 'heightCm'],
        message: `La entrepierna (${m.inseamCm} cm) es ${(r * 100).toFixed(0)} % de la estatura (${H} cm).`,
        value: r,
        expected: [0.4, 0.5],
      });
  }
  if (m.armLengthCm !== undefined) {
    const r = m.armLengthCm / H;
    const hi = sev(r, 0.38, 0.42, 1);
    const lo = sev(r, 0.3, 0.26, -1);
    const sv = hi ?? lo;
    if (sv)
      push({
        code: 'arm-length-ratio-implausible',
        severity: sv,
        keys: ['armLengthCm', 'heightCm'],
        message: `El largo de brazo (${m.armLengthCm} cm) es ${(r * 100).toFixed(0)} % de la estatura.`,
        value: r,
        expected: [0.3, 0.38],
      });
  }
  if (m.weightKg !== undefined) {
    const bmi = m.weightKg / ((H / 100) * (H / 100));
    const ext = bmi > 60 || bmi < 13 ? 'error' : bmi > 45 || bmi < 15 ? 'warning' : undefined;
    if (ext)
      push({
        code: 'bmi-extreme',
        severity: ext,
        keys: ['weightKg', 'heightCm'],
        message: `IMC = ${bmi.toFixed(1)} (peso ${m.weightKg} kg, estatura ${H} cm).`,
        value: bmi,
        expected: [15, 45],
      });
    // ¿Cuadra el peso con las circunferencias?
    const base: BodyBase = m.bodyBase ?? 'neutral';
    const probe: PartialMeasurements = { ...m };
    delete (probe as { weightKg?: number }).weightKg;
    const inferred = hasGirth(probe) ? estimateBmi(probe, base) : undefined;
    if (inferred !== undefined) {
      const d = Math.abs(inferred - bmi);
      const sv = sev(d, 6, 12, 1);
      if (sv)
        push({
          code: 'bmi-girth-mismatch',
          severity: sv,
          keys: ['weightKg', 'waistCm', 'hipCm', 'chestCm'],
          message: `El peso implica IMC ${bmi.toFixed(1)} pero las circunferencias sugieren ≈ ${inferred.toFixed(1)}.`,
          value: d,
          expected: [0, 6],
        });
    }
  }
  return out;
}

function hasGirth(p: PartialMeasurements): boolean {
  return (
    p.waistCm !== undefined ||
    p.hipCm !== undefined ||
    p.chestCm !== undefined ||
    p.thighCm !== undefined ||
    p.neckCm !== undefined
  );
}

export { GIRTH_KEYS };
