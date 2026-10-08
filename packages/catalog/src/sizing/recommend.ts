import {
  FIT_PREFERENCES,
  MeasurementsSchema,
  type FitDimension,
  type FitPreference,
  type FitVerdict,
  type GarmentDefinition,
  type Measurements,
  type SizeNote,
  type SizeRecommendation,
  type SizingInput,
} from '@fitroom/shared';
import { SizingInputError, formatPath, type CatalogIssue } from '../errors.js';
import { clamp01, deepFreeze, median, round } from '../util.js';
import {
  DEFAULT_SCALE_CM,
  FIT_INDEX,
  FIT_TOLERANCE_SCALE,
  TEMPLATE_PROFILES,
  VERDICT_BANDS,
  nominalEase,
  type BodyRangeKey,
  type EaseRule,
  type NumericMeasurementKey,
  type TemplateProfile,
} from './profiles.js';

/**
 * Entrada de tallaje. Idéntica a `SizingInput` más, opcionalmente, la elasticidad de la tela
 * (las telas elásticas toleran menos holgura mínima). Si falta se usa un valor típico de la plantilla.
 */
export interface SizingInputEx extends SizingInput {
  readonly fabric?: { readonly stretch: number };
}

// ---------- Constantes del algoritmo (documentadas en docs/sizing.md) ----------

/** Peso del término «cercanía al centro del rango» (desempata tallas con distancia 0 al rango). */
const CENTER_EPS = 0.05;
/** Desplazamiento por preferencia, en fracción del escalón de talla (snug −, roomy +). */
const PREFERENCE_SHIFT_STEPS: Readonly<Record<FitPreference, number>> = {
  snug: -0.3,
  regular: 0,
  roomy: 0.3,
};
/** Tolerancia de empate de costes (coma flotante): gana la talla menor. */
const COST_TIE_EPS = 1e-9;
/** Fracción del escalón (y mínimo en cm) que define la banda «entre tallas». */
const BETWEEN_STEP_FRACTION = 0.15;
const BETWEEN_MIN_CM = 0.5;
/** Fuera de tabla: media ponderada de la distancia normalizada a partir de la cual se avisa. */
const OUT_OF_TABLE_THRESHOLD = 0.12;
/** Estatura fuera del rango de la talla elegida (cm) a partir de la cual se avisa. */
const HEIGHT_TOLERANCE_CM = 3;
/** Alternativas: coste máximo respecto a la mejor talla y número máximo. */
const ALT_MAX_COST = 1.2;
const ALT_MAX_COUNT = 3;
/** Incertidumbre base (cm) incluso sin sigma: repetibilidad de una cinta métrica / redondeo manual. */
const BASE_SIGMA_CM: Readonly<Record<NumericMeasurementKey, number>> = {
  heightCm: 1,
  weightKg: 0,
  chestCm: 0.75,
  waistCm: 0.75,
  hipCm: 0.75,
  shoulderWidthCm: 0.5,
  armLengthCm: 0.75,
  inseamCm: 0.75,
  neckCm: 0,
  thighCm: 0.75,
};
const STABILITY_GRID: readonly { z: number; w: number }[] = (() => {
  const nodes: { z: number; w: number }[] = [];
  for (let k = -10; k <= 10; k++) nodes.push({ z: k * 0.25, w: Math.exp(-((k * 0.25) ** 2) / 2) });
  const total = nodes.reduce((s, n) => s + n.w, 0);
  return nodes.map((n) => ({ z: n.z, w: n.w / total }));
})();

const NUMERIC_KEYS: readonly NumericMeasurementKey[] = [
  'heightCm',
  'weightKg',
  'chestCm',
  'waistCm',
  'hipCm',
  'shoulderWidthCm',
  'armLengthCm',
  'inseamCm',
  'neckCm',
  'thighCm',
];

const VERDICT_ORD: Readonly<Record<FitVerdict, number>> = {
  'too-tight': -2,
  snug: -1,
  good: 0,
  roomy: 1,
  'too-loose': 2,
};

type Vec = Readonly<Record<NumericMeasurementKey, number>>;

interface PreparedDim {
  readonly key: BodyRangeKey;
  /** peso normalizado (suma 1) */
  readonly weight: number;
  /** cm por escalón de talla en esta dimensión */
  readonly scale: number;
  /** la preferencia (ceñida/holgada) desplaza esta dimensión */
  readonly shiftable: boolean;
  readonly lo: readonly number[];
  readonly hi: readonly number[];
  readonly center: readonly number[];
}

interface Prepared {
  readonly garment: GarmentDefinition;
  readonly profile: TemplateProfile;
  readonly dims: readonly PreparedDim[];
  /** fracción del peso de puntuación de la plantilla que la tabla cubre */
  readonly coverage: number;
  readonly rules: readonly EaseRule[];
  readonly stretch: number;
  readonly scales: Readonly<Record<NumericMeasurementKey, number>>;
}

// ---------- Validación de entrada ----------

function fail(code: ConstructorParameters<typeof SizingInputError>[0], path: string, message: string): never {
  throw new SizingInputError(code, [{ path, message }]);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function validateMeasurements(raw: unknown): Measurements {
  const parsed = MeasurementsSchema.safeParse(raw);
  if (!parsed.success) {
    const issues: CatalogIssue[] = parsed.error.issues
      .slice(0, 20)
      .map((i) => ({ path: formatPath(i.path), message: i.message }));
    throw new SizingInputError('invalid-measurements', issues);
  }
  return parsed.data;
}

function validateSigma(raw: unknown): Readonly<Partial<Record<keyof Measurements, number>>> {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('invalid-sigma', 'sigmaCm', 'debe ser un objeto {medida: sigma}');
  }
  const out: Partial<Record<NumericMeasurementKey, number>> = {};
  for (const key of Object.keys(raw)) {
    const v = (raw as Record<string, unknown>)[key];
    if (key === 'bodyBase') continue;
    if (!(NUMERIC_KEYS as readonly string[]).includes(key)) {
      fail('invalid-sigma', `sigmaCm.${key.slice(0, 30)}`, 'medida desconocida');
    }
    if (!isFiniteNumber(v) || v < 0 || v > 100) {
      fail('invalid-sigma', `sigmaCm.${key}`, 'la sigma debe ser un número finito en [0, 100] cm');
    }
    out[key as NumericMeasurementKey] = v;
  }
  return out;
}

function toVec(m: Measurements): Vec {
  return {
    heightCm: m.heightCm,
    weightKg: m.weightKg,
    chestCm: m.chestCm,
    waistCm: m.waistCm,
    hipCm: m.hipCm,
    shoulderWidthCm: m.shoulderWidthCm,
    armLengthCm: m.armLengthCm,
    inseamCm: m.inseamCm,
    neckCm: m.neckCm,
    thighCm: m.thighCm,
  };
}

const RANGE_KEYS: readonly BodyRangeKey[] = [
  'heightCm',
  'chestCm',
  'waistCm',
  'hipCm',
  'shoulderWidthCm',
  'inseamCm',
];
const SHIFTABLE: ReadonlySet<BodyRangeKey> = new Set(['chestCm', 'waistCm', 'hipCm', 'shoulderWidthCm']);

function prepare(garment: GarmentDefinition, fabricStretch: number | undefined): Prepared {
  if (garment === null || typeof garment !== 'object') fail('invalid-garment', 'garment', 'no es un objeto');
  const { sizes, template, fit } = garment;
  if (!Array.isArray(sizes) || sizes.length === 0) {
    fail('invalid-garment', 'garment.sizes', 'la prenda no tiene tabla de tallas');
  }
  if (typeof template !== 'string' || !Object.hasOwn(TEMPLATE_PROFILES, template)) {
    fail('invalid-garment', 'garment.template', 'plantilla desconocida');
  }
  if (typeof fit !== 'string' || !Object.hasOwn(FIT_INDEX, fit)) {
    fail('invalid-garment', 'garment.fit', 'ajuste desconocido');
  }
  const profile = TEMPLATE_PROFILES[template];

  // Dimensiones de puntuación disponibles en TODAS las tallas.
  const rawDims: Omit<PreparedDim, 'weight'>[] = [];
  let availableWeight = 0;
  let totalWeight = 0;
  for (const key of RANGE_KEYS) {
    const w = profile.score[key] ?? 0;
    totalWeight += w;
    if (w <= 0) continue;
    const lo: number[] = [];
    const hi: number[] = [];
    let complete = true;
    for (let i = 0; i < sizes.length; i++) {
      const r = sizes[i]?.body?.[key];
      if (r === undefined) {
        complete = false;
        break;
      }
      if (!Array.isArray(r) || r.length !== 2 || !isFiniteNumber(r[0]) || !isFiniteNumber(r[1]) || r[0] > r[1]) {
        fail('invalid-garment', `garment.sizes[${i}].body.${key}`, 'rango corporal inválido');
      }
      lo.push(r[0]);
      hi.push(r[1]);
    }
    if (!complete) continue;
    const center = lo.map((l, i) => (l + hi[i]!) / 2);
    const steps = center.slice(1).map((c, i) => c - center[i]!);
    const scale = steps.length > 0 ? Math.max(1, median(steps)) : DEFAULT_SCALE_CM[key];
    rawDims.push({ key, scale, shiftable: SHIFTABLE.has(key), lo, hi, center });
    availableWeight += w;
  }
  const dims: PreparedDim[] = rawDims.map((d) => ({ ...d, weight: (profile.score[d.key] ?? 0) / availableWeight }));
  const coverage = totalWeight > 0 ? availableWeight / totalWeight : 0;

  // Reglas de holgura aplicables: la prenda debe tener la medida en TODAS las tallas.
  const rules: EaseRule[] = [];
  for (const rule of profile.ease) {
    let all = true;
    let max = 0;
    for (let i = 0; i < sizes.length; i++) {
      const v = sizes[i]?.garment?.[rule.dimension];
      if (v === undefined) {
        all = false;
        break;
      }
      if (!isFiniteNumber(v)) {
        fail('invalid-garment', `garment.sizes[${i}].garment.${rule.dimension}`, 'medida de prenda inválida');
      }
      max = Math.max(max, v);
    }
    if (!all) continue;
    if (rule.requiresFull === 'sleeve' && max < 45) continue;
    if (rule.requiresFull === 'inseam' && max < 55) continue;
    rules.push(rule);
  }
  if (dims.length === 0 && rules.length === 0) {
    fail('invalid-garment', 'garment.sizes', 'la tabla no tiene ninguna medida comparable con el cuerpo');
  }

  const scales = { ...DEFAULT_SCALE_CM };
  for (const d of dims) {
    if (d.key === 'heightCm' || d.key === 'chestCm' || d.key === 'waistCm' || d.key === 'hipCm') scales[d.key] = d.scale;
    else if (d.key === 'shoulderWidthCm') scales.shoulderWidthCm = d.scale;
    else scales.inseamCm = d.scale;
  }

  const stretch = clamp01(fabricStretch ?? profile.defaultStretch);
  return { garment, profile, dims, coverage, rules, stretch, scales };
}

// ---------- Evaluación de tallas ----------

function classify(ease: number, rule: EaseRule, fit: GarmentDefinition['fit'], stretch: number): FitVerdict {
  if (ease < rule.floorCm - rule.stretchReliefCm * stretch) return 'too-tight';
  const unit = rule.unitCm * FIT_TOLERANCE_SCALE[fit];
  const x = (ease - nominalEase(rule, fit)) / unit;
  if (x < VERDICT_BANDS.tooTight) return 'too-tight';
  if (x < VERDICT_BANDS.snug) return 'snug';
  if (x <= VERDICT_BANDS.good) return 'good';
  if (x <= VERDICT_BANDS.roomy) return 'roomy';
  return 'too-loose';
}

function easeDimensions(p: Prepared, index: number, body: Vec): FitDimension[] {
  const size = p.garment.sizes[index]!;
  return p.rules.map((rule) => {
    const garmentCm = size.garment[rule.dimension]!;
    const bodyCm = body[rule.body];
    const easeCm = garmentCm - bodyCm;
    return {
      dimension: rule.dimension,
      bodyCm: round(bodyCm, 2),
      garmentCm: round(garmentCm, 2),
      easeCm: round(easeCm, 2),
      verdict: classify(easeCm, rule, p.garment.fit, p.stretch),
    };
  });
}

/** Veredicto global: lo ceñido manda (una dimensión importante «too-tight» basta); el resto, media ponderada. */
function overallVerdict(p: Prepared, dims: readonly FitDimension[]): FitVerdict {
  if (dims.length === 0) return 'good';
  let wsum = 0;
  let mean = 0;
  const weights = dims.map((d) => p.rules.find((r) => r.dimension === d.dimension)!.weight);
  for (const w of weights) wsum += w;
  let tightSignificant = false;
  dims.forEach((d, i) => {
    const w = weights[i]! / wsum;
    mean += w * VERDICT_ORD[d.verdict];
    if (d.verdict === 'too-tight' && w >= 0.2) tightSignificant = true;
  });
  if (tightSignificant || mean <= -1.5) return 'too-tight';
  if (mean <= -0.5) return 'snug';
  if (mean <= 0.5) return 'good';
  if (mean <= 1.5) return 'roomy';
  return 'too-loose';
}

interface Selection {
  readonly index: number;
  readonly costs: readonly number[];
  readonly verdicts: readonly FitVerdict[];
}

function selectSize(p: Prepared, body: Vec, preference: FitPreference): Selection {
  const n = p.garment.sizes.length;
  const shiftSteps = PREFERENCE_SHIFT_STEPS[preference];
  const costs: number[] = new Array<number>(n).fill(0);
  const verdicts: FitVerdict[] = new Array<FitVerdict>(n).fill('good');
  for (let i = 0; i < n; i++) {
    let cost = 0;
    for (const d of p.dims) {
      const b = body[d.key] + (d.shiftable ? shiftSteps * d.scale : 0);
      const dist = Math.max(0, d.lo[i]! - b, b - d.hi[i]!) / d.scale;
      const off = (b - d.center[i]!) / d.scale;
      cost += d.weight * (dist * dist + CENTER_EPS * off * off);
    }
    const dims = easeDimensions(p, i, body);
    if (p.dims.length === 0) {
      // Sin tabla corporal: el coste sale de la desviación de la holgura respecto a la nominal.
      let wsum = 0;
      for (const r of p.rules) wsum += r.weight;
      for (const dim of dims) {
        const rule = p.rules.find((r) => r.dimension === dim.dimension)!;
        const x =
          (dim.easeCm - nominalEase(rule, p.garment.fit) - shiftSteps * rule.unitCm) /
          (rule.unitCm * FIT_TOLERANCE_SCALE[p.garment.fit]);
        cost += (rule.weight / wsum) * 0.25 * x * x;
      }
    }
    costs[i] = cost;
    verdicts[i] = overallVerdict(p, dims);
  }
  // Veto de tallas no vestibles. `first` = primera talla que no es «demasiado ajustada»; `loose` = primera
  // «demasiado holgada». Se elige dentro de [first, loose) y, si ese intervalo queda vacío (cuerpo
  // desproporcionado respecto a la tabla), se admite al menos la primera vestible. Ambos extremos crecen con el
  // cuerpo, lo que garantiza la MONOTONÍA global de la elección (teorema de Topkis).
  let first = verdicts.findIndex((v) => v !== 'too-tight');
  if (first < 0) first = n - 1;
  let loose = verdicts.findIndex((v) => v === 'too-loose');
  if (loose < 0) loose = n;
  const end = Math.min(n, Math.max(loose, first + 1));
  let best = first;
  for (let i = first; i < end; i++) {
    if (costs[i]! < costs[best]! - COST_TIE_EPS) best = i;
  }
  return { index: best, costs, verdicts };
}

function shiftBody(body: Vec, delta: (key: NumericMeasurementKey) => number): Vec {
  const out = { ...body };
  for (const k of NUMERIC_KEYS) out[k] = body[k] + delta(k);
  return out;
}

// ---------- API pública ----------

/**
 * Recomienda talla para una prenda y unas medidas. Determinista y explicable: ver `docs/sizing.md`.
 * Lanza `SizingInputError` ante medidas fuera de rango/NaN, sigmas inválidas o una prenda sin tabla utilizable.
 */
export function recommendSize(input: SizingInputEx): SizeRecommendation {
  if (input === null || typeof input !== 'object') fail('invalid-garment', 'input', 'entrada vacía');
  const measurements = validateMeasurements(input.measurements);
  const sigma = validateSigma(input.sigmaCm);
  const preference = input.preference ?? 'regular';
  if (!FIT_PREFERENCES.includes(preference)) fail('invalid-preference', 'preference', 'preferencia desconocida');
  const stretchRaw = input.fabric?.stretch;
  if (stretchRaw !== undefined && !isFiniteNumber(stretchRaw)) {
    fail('invalid-garment', 'fabric.stretch', 'elasticidad inválida');
  }
  const p = prepare(input.garment, stretchRaw);
  const body = toVec(measurements);
  const sigmaOf = (k: NumericMeasurementKey): number => sigma[k] ?? 0;

  // (a)+(c) puntuación por rango y desplazamiento por preferencia, con veto de tallas no vestibles.
  const sel = selectSize(p, body, preference);
  const idx = sel.index;
  const size = p.garment.sizes[idx]!;

  // (b) holgura real y veredictos de la talla elegida.
  const dimensions = easeDimensions(p, idx, body);
  const overall = sel.verdicts[idx]!;

  // Distancias normalizadas (sin preferencia) para avisos y confianza.
  let rangeCost = 0;
  let below = 0;
  let above = 0;
  let circWeight = 0;
  for (const d of p.dims) {
    const b = body[d.key];
    const lo = d.lo[idx]!;
    const hi = d.hi[idx]!;
    const dist = Math.max(0, lo - b, b - hi) / d.scale;
    rangeCost += d.weight * dist * dist;
    // Sólo los contornos deciden «fuera de tabla»; estatura y entrepierna (longitudes) tienen su propio aviso.
    if (d.key !== 'heightCm' && d.key !== 'inseamCm') {
      circWeight += d.weight;
      below += d.weight * Math.max(0, lo - b) / d.scale;
      above += d.weight * Math.max(0, b - hi) / d.scale;
    }
  }
  if (circWeight > 0) {
    below /= circWeight;
    above /= circWeight;
  }

  // (d) avisos
  const notes: SizeNote[] = [];
  const last = p.garment.sizes.length - 1;
  const belowSmallest = idx === 0 && below >= OUT_OF_TABLE_THRESHOLD;
  const aboveLargest = idx === last && above >= OUT_OF_TABLE_THRESHOLD;
  if (belowSmallest) notes.push('below-smallest-size');
  if (aboveLargest) notes.push('above-largest-size');

  const margin = (k: NumericMeasurementKey) =>
    Math.max(BETWEEN_STEP_FRACTION * p.scales[k], BETWEEN_MIN_CM) + 0.5 * sigmaOf(k);
  const lowIdx = selectSize(p, shiftBody(body, (k) => -margin(k)), preference).index;
  const highIdx = selectSize(p, shiftBody(body, (k) => margin(k)), preference).index;
  const between = lowIdx !== highIdx;
  if (between) notes.push('between-sizes');

  const heightRange = size.body.heightCm;
  const heightOut =
    heightRange !== undefined &&
    (body.heightCm < heightRange[0] - HEIGHT_TOLERANCE_CM || body.heightCm > heightRange[1] + HEIGHT_TOLERANCE_CM);
  if (heightOut) notes.push('height-out-of-range');

  let sigmaRms = 0;
  let sigmaMaxNorm = 0;
  for (const d of p.dims) {
    const s = sigmaOf(d.key) / d.scale;
    sigmaRms += d.weight * s * s;
    sigmaMaxNorm = Math.max(sigmaMaxNorm, s);
  }
  sigmaRms = Math.sqrt(sigmaRms);
  const lowConfidence = sigmaRms >= 0.3 || sigmaMaxNorm >= 0.9;
  if (lowConfidence) notes.push('low-measurement-confidence');

  // (e) confianza = ajuste a la tabla × estabilidad ante la incertidumbre × precisión × veredicto × cobertura.
  const fitTerm = 1 / (1 + 1.5 * rangeCost);
  let stable = 0;
  for (const node of STABILITY_GRID) {
    const probe = shiftBody(body, (k) => node.z * Math.hypot(sigmaOf(k), BASE_SIGMA_CM[k]));
    if (selectSize(p, probe, preference).index === idx) stable += node.w;
  }
  const sigmaTerm = 1 / (1 + (sigmaRms / 0.5) ** 2);
  const verdictTerm = overall === 'good' ? 1 : overall === 'snug' || overall === 'roomy' ? 0.93 : 0.55;
  const coverageTerm = 0.6 + 0.4 * p.coverage;
  let confidence =
    fitTerm * stable * (0.75 + 0.25 * sigmaTerm) * verdictTerm * coverageTerm * (heightOut ? 0.9 : 1);
  if (belowSmallest || aboveLargest) confidence = Math.min(confidence, 0.4);

  // (f) alternativas ordenadas por coste (empates: talla menor primero).
  const best = sel.costs[idx]!;
  const alternatives = sel.costs
    .map((cost, i) => ({ i, cost }))
    .filter((c) => c.i !== idx && c.cost <= best + ALT_MAX_COST)
    .sort((a, b) => a.cost - b.cost || a.i - b.i)
    .slice(0, ALT_MAX_COUNT)
    .map((c) => ({ size: p.garment.sizes[c.i]!.label, overall: sel.verdicts[c.i]! }));

  return deepFreeze({
    garmentId: p.garment.id,
    size: size.label,
    overall,
    dimensions,
    confidence: round(clamp01(confidence), 3),
    alternatives,
    notes,
  });
}
