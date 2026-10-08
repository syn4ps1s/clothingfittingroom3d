import type {
  FitDimension,
  FitVerdict,
  GarmentDefinition,
  GarmentDimension,
  GarmentFit,
  GarmentSizeSpec,
  Measurements,
  SizeNote,
  SizeRecommendation,
  SizingInput,
} from '@fitroom/shared';

/**
 * Tallaje de DESARROLLO (sustituido por `@fitroom/catalog` cuando esté READY). Misma firma y semántica que el contrato:
 * holgura = prenda − cuerpo, y un veredicto por zona según la holgura «esperada» del corte (slim/regular/relaxed/oversized).
 */
type BodyKey = keyof Measurements;

interface Target {
  readonly body: BodyKey;
  readonly center: number;
  readonly half: number;
}

const BASE_EASE: Record<GarmentFit, number> = { slim: 6, regular: 10, relaxed: 16, oversized: 24 };
const SHOULDER_EASE: Record<GarmentFit, number> = { slim: 0, regular: 1, relaxed: 3, oversized: 6 };
const LOWER_WAIST: Record<GarmentFit, number> = { slim: 1, regular: 2, relaxed: 4, oversized: 6 };
const LOWER_HIP: Record<GarmentFit, number> = { slim: 3, regular: 6, relaxed: 10, oversized: 14 };

function targetFor(
  dim: GarmentDimension,
  g: GarmentDefinition,
  spec: GarmentSizeSpec['garment'],
): Target | null {
  const lower = g.slot === 'lower';
  switch (dim) {
    case 'chestCm':
      return { body: 'chestCm', center: BASE_EASE[g.fit], half: 5 };
    case 'waistCm':
      return lower
        ? { body: 'waistCm', center: LOWER_WAIST[g.fit], half: 3 }
        : { body: 'waistCm', center: BASE_EASE[g.fit], half: 6 };
    case 'hipCm':
      return { body: 'hipCm', center: lower ? LOWER_HIP[g.fit] : BASE_EASE[g.fit], half: 4 };
    case 'thighCm':
      return { body: 'thighCm', center: BASE_EASE[g.fit] - 2, half: 5 };
    case 'shoulderWidthCm':
      return { body: 'shoulderWidthCm', center: SHOULDER_EASE[g.fit], half: 2 };
    case 'sleeveLengthCm':
      return (spec.sleeveLengthCm ?? 0) > 45 ? { body: 'armLengthCm', center: 1, half: 3 } : null;
    case 'inseamCm':
      return (spec.inseamCm ?? 0) >= 55 ? { body: 'inseamCm', center: 0, half: 4 } : null;
    default:
      return null; // largo, bajo, tiro, bota: sin equivalente directo en el cuerpo
  }
}

export function verdictFor(ease: number, center: number, half: number, circumference: boolean): FitVerdict {
  const d = ease - center;
  if (circumference && ease < 0) return 'too-tight';
  if (Math.abs(d) <= half) return 'good';
  if (d > 0) return d <= 3 * half ? 'roomy' : 'too-loose';
  return d >= -2 * half ? 'snug' : 'too-tight';
}

const SEVERITY: Record<FitVerdict, number> = {
  good: 0,
  snug: 1,
  roomy: 1,
  'too-tight': 2,
  'too-loose': 2,
};

export interface SizeEvaluation {
  readonly dimensions: readonly FitDimension[];
  readonly overall: FitVerdict;
  /** Menor es mejor (distancia a la holgura esperada). */
  readonly score: number;
}

export function evaluateSizeFallback(
  garment: GarmentDefinition,
  size: GarmentSizeSpec,
  m: Measurements,
): SizeEvaluation {
  const dimensions: FitDimension[] = [];
  let score = 0;
  for (const dim of Object.keys(size.garment) as GarmentDimension[]) {
    const garmentCm = size.garment[dim];
    const target = targetFor(dim, garment, size.garment);
    if (garmentCm === undefined || !target) continue;
    const bodyCm = m[target.body] as number;
    if (!Number.isFinite(bodyCm) || !Number.isFinite(garmentCm)) continue;
    const easeCm = garmentCm - bodyCm;
    const circumference = dim !== 'sleeveLengthCm' && dim !== 'inseamCm';
    const verdict = verdictFor(easeCm, target.center, target.half, circumference);
    const over = Math.max(0, Math.abs(easeCm - target.center) - target.half) / target.half;
    score += over * over + Math.abs(easeCm - target.center) / 40;
    dimensions.push({ dimension: dim, bodyCm, garmentCm, easeCm, verdict });
  }
  let overall: FitVerdict = 'good';
  for (const d of dimensions) {
    if (SEVERITY[d.verdict] > SEVERITY[overall]) overall = d.verdict;
  }
  return { dimensions, overall, score };
}

function within(value: number, range: readonly [number, number] | undefined): boolean {
  return !range || (value >= range[0] && value <= range[1]);
}

export function recommendSizeFallback(input: SizingInput): SizeRecommendation {
  const { garment, measurements: m } = input;
  const evaluations = garment.sizes
    .map((size) => ({ size, ev: evaluateSizeFallback(garment, size, m) }))
    .sort((a, b) => a.ev.score - b.ev.score);
  const best = evaluations[0]!;
  const second = evaluations[1];
  const notes: SizeNote[] = [];
  let confidence = 0.95;

  const first = garment.sizes[0]!;
  const last = garment.sizes[garment.sizes.length - 1]!;
  const lo = first.body.chestCm?.[0] ?? first.body.waistCm?.[0];
  const hi = last.body.chestCm?.[1] ?? last.body.waistCm?.[1];
  const ref = first.body.chestCm ? m.chestCm : m.waistCm;
  if (lo !== undefined && ref < lo - 2) {
    notes.push('below-smallest-size');
    confidence -= 0.3;
  }
  if (hi !== undefined && ref > hi + 2) {
    notes.push('above-largest-size');
    confidence -= 0.3;
  }
  if (second && second.ev.score - best.ev.score < 0.25) {
    notes.push('between-sizes');
    confidence -= 0.12;
  }
  if (!within(m.heightCm, best.size.body.heightCm)) {
    notes.push('height-out-of-range');
    confidence -= 0.1;
  }
  const sigmas = Object.values(input.sigmaCm ?? {}).filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0,
  );
  if (sigmas.length > 0) {
    const mean = sigmas.reduce((a, b) => a + b, 0) / sigmas.length;
    confidence -= Math.min(0.4, 0.04 * mean);
    if (mean >= 3) notes.push('low-measurement-confidence');
  }

  return {
    garmentId: garment.id,
    size: best.size.label,
    overall: best.ev.overall,
    dimensions: best.ev.dimensions,
    confidence: Math.min(0.98, Math.max(0.05, confidence)),
    alternatives: evaluations.slice(1, 3).map((e) => ({ size: e.size.label, overall: e.ev.overall })),
    notes,
  };
}
