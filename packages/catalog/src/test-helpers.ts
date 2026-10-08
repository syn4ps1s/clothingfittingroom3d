/** Utilidades SÓLO para tests (excluidas de la cobertura): cuerpos arbitrarios, semillas fijas y atajos del catálogo. */
import fc from 'fast-check';
import {
  MEASUREMENT_LIMITS,
  REFERENCE_MEASUREMENTS,
  type FabricDef,
  type GarmentDefinition,
  type MeasurementKey,
  type Measurements,
} from '@fitroom/shared';
import { loadCatalogData } from './loader.js';

/** Configuración común de fast-check: semilla fija (tests deterministas) y nº de ejecuciones moderado. */
export const FC = { seed: 20260801, numRuns: 150 } as const;

export const catalog = loadCatalogData();
export const fabricById = new Map<string, FabricDef>(catalog.fabrics.map((f) => [f.id, f]));
export const stretchOf = (g: GarmentDefinition): { stretch: number } => ({
  stretch: fabricById.get(g.fabricId)!.stretch,
});

const tenths = (min: number, max: number) =>
  fc.integer({ min: min * 10, max: max * 10 }).map((n) => n / 10);

/** Cuerpo humano plausible (rangos amplios: de la talla más pequeña a la más grande de las referencias y algo más). */
export const arbBody: fc.Arbitrary<Measurements> = fc.record({
  heightCm: tenths(145, 205),
  weightKg: tenths(40, 140),
  chestCm: tenths(74, 134),
  waistCm: tenths(58, 124),
  hipCm: tenths(82, 134),
  shoulderWidthCm: tenths(32, 56),
  armLengthCm: tenths(48, 70),
  inseamCm: tenths(64, 92),
  neckCm: tenths(29, 48),
  thighCm: tenths(44, 78),
  bodyBase: fc.constantFrom('neutral', 'feminine', 'masculine'),
});

/** Id de prenda (los contraejemplos de fast-check muestran sólo el id, no la prenda entera). */
export const arbGarmentId: fc.Arbitrary<string> = fc.constantFrom(
  ...catalog.garments.map((g) => g.id),
);
const garmentsById = new Map<string, GarmentDefinition>(catalog.garments.map((g) => [g.id, g]));
export const garmentOf = (id: string): GarmentDefinition => garmentsById.get(id)!;

const GROWING: readonly MeasurementKey[] = [
  'heightCm',
  'chestCm',
  'waistCm',
  'hipCm',
  'shoulderWidthCm',
  'armLengthCm',
  'inseamCm',
  'thighCm',
];

/** Suma `delta` (≥ 0) a todas las medidas que "crecen con el cuerpo", respetando los límites de plausibilidad. */
export function growBody(
  m: Measurements,
  delta: Readonly<Partial<Record<MeasurementKey, number>>>,
): Measurements {
  const out: Record<string, number | string> = { ...m };
  for (const k of GROWING) {
    const lim = MEASUREMENT_LIMITS[k];
    out[k] = Math.min(lim.max, (m[k] as number) + (delta[k] ?? 0));
  }
  return out as unknown as Measurements;
}

export const idxOf = (g: GarmentDefinition, label: string): number =>
  g.sizes.findIndex((s) => s.label === label);

const clampTo = (key: MeasurementKey, v: number): number =>
  Math.min(MEASUREMENT_LIMITS[key].max, Math.max(MEASUREMENT_LIMITS[key].min, v));

const RANGE_TO_KEY = {
  heightCm: 'heightCm',
  chestCm: 'chestCm',
  waistCm: 'waistCm',
  hipCm: 'hipCm',
  shoulderWidthCm: 'shoulderWidthCm',
  inseamCm: 'inseamCm',
} as const;

/**
 * Cuerpo «de tabla» para la talla `index`: punto medio (o fracción `at` 0..1) de cada rango de la tabla; las medidas
 * que la tabla no recoge (muslo, brazo, cuello, peso) se derivan con proporciones típicas de los cuerpos de referencia.
 * `at` sólo afecta a `primary` (la dimensión principal); el resto va al centro.
 */
export function bodyForSize(
  g: GarmentDefinition,
  index: number,
  base: Measurements = REFERENCE_MEASUREMENTS.adultA,
  primary?: { key: keyof typeof RANGE_TO_KEY; at: number },
): Measurements {
  const body: Record<string, number | string> = { ...base };
  for (const [k, range] of Object.entries(g.sizes[index]!.body)) {
    const key = RANGE_TO_KEY[k as keyof typeof RANGE_TO_KEY];
    const at = primary && primary.key === k ? primary.at : 0.5;
    body[key] = clampTo(key, range[0] + at * (range[1] - range[0]));
  }
  body.thighCm = clampTo('thighCm', 0.58 * (body.hipCm as number));
  body.armLengthCm = clampTo('armLengthCm', 0.337 * (body.heightCm as number));
  return body as unknown as Measurements;
}

/**
 * Cuerpo humano PROPORCIONADO: una escala continua `u` (0 = muy pequeño, 1 = muy grande) más pequeñas variaciones de
 * proporciones. Es el tipo de cuerpo para el que la tabla de tallas está pensada (a diferencia de `arbBody`, que
 * combina medidas independientes y produce muchos cuerpos «imposibles»).
 */
export const arbProportionedBody: fc.Arbitrary<Measurements> = fc
  .record({
    u: fc.integer({ min: 0, max: 100 }).map((n) => n / 100),
    n: fc.array(tenths(-2.5, 2.5), { minLength: 6, maxLength: 6 }),
  })
  .map(({ u, n }) => {
    const height = 150 + 45 * u + n[0]!;
    const hip = 84 + 40 * u + n[3]!;
    return {
      heightCm: height,
      weightKg: 40 + 80 * u,
      chestCm: 78 + 50 * u + n[1]!,
      waistCm: 60 + 54 * u + n[2]!,
      hipCm: hip,
      shoulderWidthCm: 34 + 19 * u + n[4]! * 0.4,
      armLengthCm: 0.337 * height,
      inseamCm: 0.45 * height + n[5]! * 0.4,
      neckCm: 31 + 14 * u,
      thighCm: 0.58 * hip,
      bodyBase: 'neutral' as const,
    };
  });
