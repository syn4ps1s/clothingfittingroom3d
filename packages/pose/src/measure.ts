import {
  LM,
  clamp,
  type BodyBase,
  type EstimatedValue,
  type MeasurementEstimate,
  type MeasurementKey,
  type PoseFrame,
} from '@fitroom/shared';
import {
  PRIOR_BMI_SIGMA,
  RESIDUAL_SIGMA,
  SEX_FACTOR,
  girthPrior,
  girthSlopeBmi,
  predictGirth,
  type GirthKey,
} from './anthropometry.js';
import {
  ANKLE_HEIGHT,
  ARM_LENGTH_BIAS_CM,
  CHAIN_FRACTIONS,
  GIRTH_FROM_WIDTH,
  HIP_ABOVE_CROTCH,
  SHOULDER_INSET_M,
  type GirthLevel,
} from './calibration.js';
import { cleanVis, median } from './geom.js';
import { measureSilhouette, type SilhouetteWidths } from './girth.js';
import { fuse, robustLocation, rss } from './robust.js';

/**
 * Estimador de medidas corporales a partir de landmarks (+ máscara de segmentación opcional).
 *
 *  - LONGITUDES (hombros, brazo, entrepierna, torso): se miden en 3D en los landmarks «world», con la
 *    escala métrica fijada por la estatura declarada (cadena pierna+torso+cuello ≈ 0.887·H).
 *  - CIRCUNFERENCIAS (pecho, cintura, cadera, cuello, muslo): NO se pueden medir con un esqueleto; se
 *    combinan (inverso de la varianza) un a priori antropométrico (estatura, peso, constitución) y, si hay
 *    máscara, el ancho frontal de silueta a la altura de cada nivel convertido con factores ajustados a las
 *    mallas de body. Las σ incluyen la incertidumbre de todos esos supuestos.
 *
 * Nada de lo que sale de aquí es «talla de sastre»: es una estimación con incertidumbre que la persona
 * SIEMPRE puede revisar y editar.
 */

export interface EstimatorOptions {
  /** Peso declarado (kg): reduce mucho la incertidumbre de las circunferencias. */
  readonly weightKg?: number;
  /** Constitución para el a priori. Por defecto `neutral`. */
  readonly bodyBase?: BodyBase;
  /** `photo`: un solo fotograma (σ mayores, `source: 'scan-photo'`). */
  readonly mode?: 'video' | 'photo';
}

export type ScaleEvidence = 'full' | 'upper' | 'none';

export interface MeasureDetails {
  /** Con qué se fijó la escala métrica de los landmarks. */
  readonly scaleEvidence: ScaleEvidence;
  /** Factor world→métrico y su incertidumbre relativa. */
  readonly scaleK: number;
  readonly scaleSigmaRel: number;
  readonly framesUsed: number;
  readonly framesWithMask: number;
  /** Longitud del torso (cadera→hombros), informativa (no es una `MeasurementKey`). */
  readonly torsoLengthCm?: EstimatedValue;
  /** ¿Se vieron los brazos separados del tronco en la silueta? (`null` sin máscara) */
  readonly armsClear: boolean | null;
  readonly pxPerM?: number;
  /** IMC usado (declarado o inferido de las siluetas) y su σ; `inferred` = no había peso declarado. */
  readonly bmi?: { readonly value: number; readonly sigma: number; readonly inferred: boolean };
  /** Medidas con a priori solamente (sin evidencia de cámara). */
  readonly priorOnly: readonly MeasurementKey[];
}

interface FrameGeometry {
  readonly shoulder?: number;
  readonly arm: readonly number[];
  readonly leg: readonly number[];
  readonly torso?: number;
  readonly head?: number;
}

const VIS = 0.5;

/** Geometría 3D (m, escala cruda de MediaPipe) de un fotograma; sólo con landmarks visibles. */
export function frameGeometry(frame: PoseFrame): FrameGeometry {
  const w = frame.world;
  const ok = (i: number, min = VIS): boolean => {
    const l = w[i];
    return !!l && Number.isFinite(l.x + l.y + l.z) && cleanVis(l.visibility) >= min;
  };
  const d = (a: number, b: number): number =>
    Math.hypot(w[a]!.x - w[b]!.x, w[a]!.y - w[b]!.y, w[a]!.z - w[b]!.z);
  const mid = (a: number, b: number): [number, number, number] => [
    (w[a]!.x + w[b]!.x) / 2,
    (w[a]!.y + w[b]!.y) / 2,
    (w[a]!.z + w[b]!.z) / 2,
  ];
  const dist3 = (p: readonly number[], q: readonly number[]): number =>
    Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);

  const bothSh = ok(LM.l_shoulder) && ok(LM.r_shoulder);
  const bothHip = ok(LM.l_hip) && ok(LM.r_hip);
  const arm: number[] = [];
  const leg: number[] = [];
  for (const [s, e, wr] of [
    [LM.l_shoulder, LM.l_elbow, LM.l_wrist],
    [LM.r_shoulder, LM.r_elbow, LM.r_wrist],
  ] as const) {
    if (ok(s) && ok(e) && ok(wr)) arm.push(d(s, e) + d(e, wr));
  }
  for (const [h, k, a] of [
    [LM.l_hip, LM.l_knee, LM.l_ankle],
    [LM.r_hip, LM.r_knee, LM.r_ankle],
  ] as const) {
    if (ok(h) && ok(k) && ok(a)) leg.push(d(h, k) + d(k, a));
  }
  const out: {
    shoulder?: number;
    arm: number[];
    leg: number[];
    torso?: number;
    head?: number;
  } = { arm, leg };
  if (bothSh) out.shoulder = d(LM.l_shoulder, LM.r_shoulder);
  if (bothSh && bothHip) {
    const shMid = mid(LM.l_shoulder, LM.r_shoulder);
    out.torso = dist3(shMid, mid(LM.l_hip, LM.r_hip));
    if (ok(LM.l_ear, 0.4) && ok(LM.r_ear, 0.4)) out.head = dist3(shMid, mid(LM.l_ear, LM.r_ear));
    else if (ok(LM.nose)) out.head = dist3(shMid, [w[LM.nose]!.x, w[LM.nose]!.y, w[LM.nose]!.z]);
  }
  return out;
}

const meanOf = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Prior de una circunferencia para un IMC (con su incertidumbre) dado. */
function girthPriorAtBmi(
  key: GirthKey,
  H: number,
  base: BodyBase,
  bmi: number,
  bmiSigma: number,
): { value: number; sigma: number } {
  const s = SEX_FACTOR[base];
  return {
    value: predictGirth(key, H, bmi, s),
    sigma: Math.hypot(RESIDUAL_SIGMA[key], girthSlopeBmi(key, s) * bmiSigma),
  };
}

/**
 * IMC más verosímil dadas las siluetas: minimiza (IMC − μ)²/σ² + Σ_niveles (prior(IMC) − c(IMC)·ancho)²/var.
 * Búsqueda en rejilla (14–48, paso 0.25); σ posterior por curvatura. Sin peso declarado, evita que el a
 * priori de población arrastre las circunferencias de personas con IMC muy alto o muy bajo.
 */
function inferBmi(
  stats: readonly { level: GirthLevel; key: GirthKey; widthCm: number; sigmaW: number }[],
  H: number,
  base: BodyBase,
): { bmi: number; sigma: number } {
  const s = SEX_FACTOR[base];
  const mu = girthPrior('chestCm', H, undefined, base).bmi;
  const sigmaPop = 5.5; // la población adulta tiene cola derecha en IMC: algo más ancha que 4.5
  const cost = (bmi: number): number => {
    let c = ((bmi - mu) / sigmaPop) ** 2;
    for (const st of stats) {
      const g = GIRTH_FROM_WIDTH[st.level];
      const factor = g.c0 + g.c1 * (bmi - 22);
      const meas = factor * st.widthCm;
      const varr =
        RESIDUAL_SIGMA[st.key] ** 2 + (factor * st.sigmaW) ** 2 + (g.rel * meas) ** 2;
      const pred = predictGirth(st.key, H, bmi, s);
      c += (pred - meas) ** 2 / varr;
    }
    return c;
  };
  let best = mu;
  let bestC = Infinity;
  for (let b = 14; b <= 48; b += 0.25) {
    const c = cost(b);
    if (c < bestC) {
      bestC = c;
      best = b;
    }
  }
  const h = 1;
  const curv = (cost(best + h) - 2 * bestC + cost(best - h)) / (h * h);
  const sigma = curv > 1e-9 ? clamp(Math.sqrt(2 / curv), 0.8, 4) : 4;
  return { bmi: best, sigma };
}

/**
 * Estima todas las medidas posibles a partir de `frames` (≥ 1). Es la función común de la sesión de
 * escaneo (vídeo, ≈ 45 fotogramas) y del modo foto (1 fotograma).
 */
export function estimateMeasurements(
  frames: readonly PoseFrame[],
  heightCm: number,
  opts: EstimatorOptions = {},
): { estimate: MeasurementEstimate; details: MeasureDetails } {
  const photo = opts.mode === 'photo' || frames.length <= 1;
  const source = photo ? 'scan-photo' : 'scan-video';
  const base = opts.bodyBase ?? 'neutral';
  const H = clamp(Number.isFinite(heightCm) ? heightCm : 170, 100, 260);
  const geoms = frames.map(frameGeometry);
  const nEff = photo ? 1 : Math.max(1, geoms.length / 3); // los fotogramas consecutivos están correlados

  // ---- escala métrica con la estatura declarada ------------------------------------------------
  const kFull: number[] = [];
  const kUpper: number[] = [];
  for (const g of geoms) {
    if (g.torso === undefined || g.head === undefined) continue;
    const upper = g.torso + g.head;
    kUpper.push((H / 100) * (CHAIN_FRACTIONS.torso + CHAIN_FRACTIONS.head) / upper);
    if (g.leg.length > 0) {
      const legSpan = meanOf(g.leg);
      const full = legSpan + upper;
      kFull.push(
        ((H / 100) * (CHAIN_FRACTIONS.legSpan + CHAIN_FRACTIONS.torso + CHAIN_FRACTIONS.head)) /
          full,
      );
    }
  }
  let scaleEvidence: ScaleEvidence = 'none';
  let scaleK = 1;
  let scaleSigmaRel = 0.09; // sin referencia: se confía en la escala métrica de MediaPipe (±9 %)
  const kF = robustLocation(kFull, { minSigma: 0.002 });
  const kU = robustLocation(kUpper, { minSigma: 0.002 });
  if (kF && kF.kept >= Math.min(3, geoms.length)) {
    scaleEvidence = 'full';
    scaleK = kF.value;
    // variación poblacional de la proporción pierna/estatura (≈ 1.5 %) + ruido temporal
    scaleSigmaRel = rss(0.015, kF.spread / Math.sqrt(nEff));
  } else if (kU && kU.kept >= Math.min(3, geoms.length)) {
    scaleEvidence = 'upper';
    scaleK = kU.value;
    scaleSigmaRel = rss(0.04, kU.spread / Math.sqrt(nEff));
  }
  // la escala sólo puede ser razonable: más allá, algo va mal con los landmarks
  scaleK = clamp(scaleK, 0.5, 2);
  const evidenceFactor = scaleEvidence === 'full' ? 1 : scaleEvidence === 'upper' ? 1.4 : 2;

  // ---- longitudes -------------------------------------------------------------------------------
  const lengthSigma = (
    modelCm: number,
    calCm: number,
    valueCm: number,
    spread: number,
  ): number => {
    const temporal = photo ? 1.0 : spread / Math.sqrt(nEff);
    const model = photo ? modelCm * 1.15 : modelCm;
    return evidenceFactor * rss(model, calCm, scaleSigmaRel * valueCm, temporal);
  };
  const est: { -readonly [K in MeasurementKey]?: EstimatedValue } = {};
  const priorOnly: MeasurementKey[] = [];

  const shoulderVals = geoms.filter((g) => g.shoulder !== undefined).map((g) => g.shoulder!);
  const shoulder = robustLocation(shoulderVals.map((v) => 100 * v * scaleK), { minSigma: 0.15 });
  if (shoulder) {
    const v = shoulder.value + 200 * SHOULDER_INSET_M;
    est.shoulderWidthCm = {
      value: v,
      sigma: lengthSigma(1.5, 2.1, v, shoulder.spread),
      source,
    };
  }
  const armVals = geoms.filter((g) => g.arm.length > 0).map((g) => 100 * meanOf(g.arm) * scaleK);
  const arm = robustLocation(armVals, { minSigma: 0.2 });
  if (arm) {
    const v = arm.value + ARM_LENGTH_BIAS_CM;
    est.armLengthCm = { value: v, sigma: lengthSigma(0.035 * v, 1.2, v, arm.spread), source };
  }
  const legVals = geoms.filter((g) => g.leg.length > 0).map((g) => 100 * meanOf(g.leg) * scaleK);
  const leg = robustLocation(legVals, { minSigma: 0.2 });
  if (leg) {
    // inseam = pierna(cadera→tobillo) + altura del tobillo − altura de la articulación sobre la entrepierna
    const v = leg.value + (ANKLE_HEIGHT - HIP_ABOVE_CROTCH) * H;
    est.inseamCm = { value: v, sigma: lengthSigma(0.03 * leg.value, 1.2, v, leg.spread), source };
  }
  const torsoVals = geoms.filter((g) => g.torso !== undefined).map((g) => 100 * g.torso! * scaleK);
  const torso = robustLocation(torsoVals, { minSigma: 0.2 });
  const torsoLengthCm: EstimatedValue | undefined = torso
    ? { value: torso.value, sigma: lengthSigma(0.035 * torso.value, 1.0, torso.value, torso.spread), source }
    : undefined;

  // ---- circunferencias: a priori + silueta -----------------------------------------------------
  const sil: SilhouetteWidths[] = [];
  for (const f of frames) {
    const s = measureSilhouette(f, scaleK, H / 100);
    if (s) sil.push(s);
  }
  const armsClear = sil.length > 0 ? sil.filter((s) => s.armsClear).length >= sil.length / 2 : null;
  const girthKeys: [GirthLevel, GirthKey, keyof SilhouetteWidths][] = [
    ['chest', 'chestCm', 'chestCm'],
    ['waist', 'waistCm', 'waistCm'],
    ['hip', 'hipCm', 'hipCm'],
    ['neck', 'neckCm', 'neckCm'],
    ['thigh', 'thighCm', 'thighCm'],
  ];
  // anchos medidos por nivel (robustos entre fotogramas) y su σ
  interface LevelStat {
    level: GirthLevel;
    key: GirthKey;
    widthCm: number;
    sigmaW: number;
  }
  const levelStats: LevelStat[] = [];
  for (const [level, key, widthKey] of girthKeys) {
    const widths = sil.map((s) => s[widthKey]).filter((x): x is number => typeof x === 'number');
    const wStat = robustLocation(widths, { minSigma: 0.3 });
    if (!wStat) continue;
    const merged = (level === 'chest' || level === 'waist') && armsClear === false;
    const sigmaW = rss(
      1.1, // bordes de la máscara (≈ ±0.7 px por lado)
      level === 'neck' ? 1.0 : 1.5, // ropa/pelo
      0.6, // error de localización del nivel
      wStat.spread / Math.sqrt(photo ? 1 : nEff),
      merged ? 2.5 : 0,
    );
    levelStats.push({ level, key, widthCm: wStat.value, sigmaW });
  }

  // IMC: declarado, o inferido combinando la población con la coherencia entre las siluetas y el a priori
  const weightKnown = opts.weightKg !== undefined && Number.isFinite(opts.weightKg) && opts.weightKg > 0;
  let bmi = girthPrior('chestCm', H, opts.weightKg, base).bmi;
  let bmiSigma = weightKnown ? 0.5 : PRIOR_BMI_SIGMA;
  let bmiInferred = false;
  if (!weightKnown && levelStats.length >= 2) {
    const inf = inferBmi(levelStats, H, base);
    bmi = inf.bmi;
    bmiSigma = inf.sigma;
    bmiInferred = true;
  }

  for (const [level, key] of girthKeys) {
    const prior = girthPriorAtBmi(key, H, base, bmi, bmiSigma);
    const st = levelStats.find((l) => l.level === level);
    if (!st) {
      // sin silueta de este nivel: a priori (con el IMC inferido si lo hay)
      est[key] = {
        value: prior.value,
        sigma: prior.sigma * (bmiInferred ? 1.15 : 1),
        source: bmiInferred ? source : 'regression',
      };
      if (!bmiInferred) priorOnly.push(key);
      continue;
    }
    const g = GIRTH_FROM_WIDTH[level];
    const c = g.c0 + g.c1 * (bmi - 22);
    const sCirc = c * st.widthCm;
    const sSigma = rss(c * st.sigmaW, g.rel * sCirc, scaleSigmaRel * sCirc) * (photo ? 1.2 : 1);
    const f = fuse({ value: prior.value, sigma: prior.sigma }, { value: sCirc, sigma: sSigma });
    // la σ final nunca baja del 80 % de la de la medida (el a priori no «inventa» precisión)
    est[key] = { value: f.value, sigma: Math.max(f.sigma, 0.8 * sSigma), source };
  }

  // ---- ensamblado ----------------------------------------------------------------------------------
  const fill = (key: 'shoulderWidthCm' | 'armLengthCm' | 'inseamCm'): void => {
    if (est[key]) return;
    // sin evidencia de cámara: regresión desde la estatura (misma antropometría que body)
    const v =
      key === 'shoulderWidthCm'
        ? girthPrior('shoulderWidthCm', H, opts.weightKg, base)
        : key === 'armLengthCm'
          ? { value: H * 0.3375, sigma: 2.3 }
          : { value: H * 0.4545, sigma: 2.6 };
    est[key] = { value: v.value, sigma: v.sigma * 1.2, source: 'regression' };
    priorOnly.push(key);
  };
  fill('shoulderWidthCm');
  fill('armLengthCm');
  fill('inseamCm');

  const estimate: MeasurementEstimate = {
    heightCm: { value: H, sigma: 0.7, source: 'user' },
    ...(opts.weightKg !== undefined && Number.isFinite(opts.weightKg)
      ? { weightKg: { value: opts.weightKg, sigma: 0.5, source: 'user' as const } }
      : {}),
    ...est,
  };
  const pxPerM = sil.length ? median(sil.map((s) => s.pxPerM)) : undefined;
  return {
    estimate,
    details: {
      scaleEvidence,
      scaleK,
      scaleSigmaRel,
      framesUsed: frames.length,
      framesWithMask: sil.length,
      ...(torsoLengthCm ? { torsoLengthCm } : {}),
      armsClear,
      ...(pxPerM !== undefined ? { pxPerM } : {}),
      bmi: { value: bmi, sigma: bmiSigma, inferred: bmiInferred },
      priorOnly,
    },
  };
}

/**
 * Estimación a partir de UNA foto (modo foto): un único fotograma de pose (con máscara si se dispone).
 * Las σ son mayores que en vídeo (no hay promediado temporal) y el origen es `scan-photo`.
 */
export function estimateMeasurementsFromFrame(
  frame: PoseFrame,
  heightCm: number,
  opts: Omit<EstimatorOptions, 'mode'> = {},
): MeasurementEstimate {
  return estimateMeasurements([frame], heightCm, { ...opts, mode: 'photo' }).estimate;
}

