import type {
  GarmentDimension,
  GarmentFit,
  GarmentTemplate,
  Measurements,
  SizeBodyRange,
} from '@fitroom/shared';

/**
 * Perfiles de tallaje por plantilla: QUÉ se compara y CÓMO se interpreta. Es la única fuente de verdad
 * de las holguras («ease») nominales; el generador de datos del catálogo las reutiliza, de modo que las
 * tablas de prenda y el clasificador de ajuste nunca se contradicen.
 */

export type BodyRangeKey = keyof SizeBodyRange;
export type NumericMeasurementKey = Exclude<keyof Measurements, 'bodyBase'>;

/** Tolerancia por defecto (cm por «escalón» de talla) cuando la tabla no permite deducirla. */
export const DEFAULT_SCALE_CM: Readonly<Record<NumericMeasurementKey, number>> = {
  heightCm: 8,
  weightKg: 5,
  chestCm: 6,
  waistCm: 6,
  hipCm: 4.5,
  shoulderWidthCm: 2.5,
  armLengthCm: 2.5,
  inseamCm: 2.5,
  neckCm: 1.5,
  thighCm: 3,
};

/** Dimensiones de la tabla `size.body` que participan en la puntuación, con su peso (se renormaliza). */
export type ScoreWeights = Readonly<Partial<Record<BodyRangeKey, number>>>;

/** Holgura nominal (cm) de una dimensión según el ajuste: [slim, regular, relaxed, oversized]. */
export type NominalEase = readonly [number, number, number, number];

export interface EaseRule {
  /** medida de la PRENDA */
  readonly dimension: GarmentDimension;
  /** medida del CUERPO con la que se compara */
  readonly body: NumericMeasurementKey;
  /** peso en el veredicto global (suma ≈ 1 por plantilla) */
  readonly weight: number;
  /** unidad de tolerancia (cm) para clasificar la desviación respecto a la holgura nominal */
  readonly unitCm: number;
  readonly nominal: NominalEase;
  /** holgura mínima (cm) para poder vestir la prenda en una tela SIN elasticidad */
  readonly floorCm: number;
  /** cuánto baja ese mínimo (cm) con elasticidad 1; se escala con `fabric.stretch` */
  readonly stretchReliefCm: number;
  /** la regla sólo aplica si la prenda tiene esa medida «larga» (manga completa / pernera completa) */
  readonly requiresFull?: 'sleeve' | 'inseam';
}

export interface TemplateProfile {
  readonly template: GarmentTemplate;
  /** elasticidad supuesta cuando no se conoce la tela (0..1) */
  readonly defaultStretch: number;
  readonly score: ScoreWeights;
  readonly ease: readonly EaseRule[];
}

export const FIT_INDEX: Readonly<Record<GarmentFit, 0 | 1 | 2 | 3>> = {
  slim: 0,
  regular: 1,
  relaxed: 2,
  oversized: 3,
};

/** Las prendas holgadas toleran más desviación en términos absolutos (y las ajustadas menos). */
export const FIT_TOLERANCE_SCALE: Readonly<Record<GarmentFit, number>> = {
  slim: 0.8,
  regular: 1,
  relaxed: 1.3,
  oversized: 1.7,
};

export function nominalEase(rule: EaseRule, fit: GarmentFit): number {
  return rule.nominal[FIT_INDEX[fit]];
}

// ---------- Reglas reutilizables ----------

const chestTop: EaseRule = {
  dimension: 'chestCm',
  body: 'chestCm',
  weight: 0.6,
  unitCm: 3,
  nominal: [4, 10, 16, 24],
  floorCm: 5,
  stretchReliefCm: 12,
};
const chestOuter: EaseRule = {
  ...chestTop,
  nominal: [8, 14, 20, 28],
  floorCm: 8,
  stretchReliefCm: 6,
};
const shoulder: EaseRule = {
  dimension: 'shoulderWidthCm',
  body: 'shoulderWidthCm',
  weight: 0.25,
  unitCm: 1.2,
  nominal: [1.5, 2.5, 4, 8],
  floorCm: 0,
  stretchReliefCm: 2,
};
const sleeve: EaseRule = {
  dimension: 'sleeveLengthCm',
  body: 'armLengthCm',
  weight: 0.15,
  unitCm: 2,
  nominal: [-0.5, 1, 2.5, 5],
  floorCm: -5,
  stretchReliefCm: 0,
  requiresFull: 'sleeve',
};
const waistPants: EaseRule = {
  dimension: 'waistCm',
  body: 'waistCm',
  weight: 0.35,
  unitCm: 2.5,
  nominal: [1, 2, 5, 9],
  floorCm: 0,
  stretchReliefCm: 5,
};
const hipPants: EaseRule = {
  dimension: 'hipCm',
  body: 'hipCm',
  weight: 0.3,
  unitCm: 3,
  nominal: [6, 10, 15, 22],
  floorCm: 2,
  stretchReliefCm: 8,
};
const thighPants: EaseRule = {
  dimension: 'thighCm',
  body: 'thighCm',
  weight: 0.2,
  unitCm: 3,
  nominal: [6, 12, 18, 26],
  floorCm: 2,
  stretchReliefCm: 8,
};
const inseamPants: EaseRule = {
  dimension: 'inseamCm',
  body: 'inseamCm',
  weight: 0.15,
  unitCm: 2,
  nominal: [-1, 0, 1, 2],
  floorCm: -6,
  stretchReliefCm: 0,
  requiresFull: 'inseam',
};

const topScore = (
  chest: number,
  shoulderW: number,
  waist: number,
  hip: number,
  height: number,
): ScoreWeights => ({
  chestCm: chest,
  shoulderWidthCm: shoulderW,
  waistCm: waist,
  hipCm: hip,
  heightCm: height,
});

const TOP_EASE = [chestTop, shoulder, sleeve] as const;
const OUTER_EASE = [chestOuter, { ...shoulder, weight: 0.3 }, sleeve] as const;
const PANTS_EASE = [waistPants, hipPants, thighPants, inseamPants] as const;

export const TEMPLATE_PROFILES: Readonly<Record<GarmentTemplate, TemplateProfile>> = {
  tee: {
    template: 'tee',
    defaultStretch: 0.35,
    score: topScore(0.5, 0.17, 0.1, 0.08, 0.15),
    ease: TOP_EASE,
  },
  long_sleeve: {
    template: 'long_sleeve',
    defaultStretch: 0.35,
    score: topScore(0.5, 0.17, 0.1, 0.08, 0.15),
    ease: TOP_EASE,
  },
  tank: {
    template: 'tank',
    defaultStretch: 0.5,
    score: topScore(0.55, 0.1, 0.13, 0.1, 0.12),
    // Los tirantes no tienen «hombro» comparable: sólo el contorno de pecho decide el ajuste.
    ease: [{ ...chestTop, weight: 1 }],
  },
  polo: {
    template: 'polo',
    defaultStretch: 0.25,
    score: topScore(0.5, 0.17, 0.1, 0.08, 0.15),
    ease: TOP_EASE,
  },
  shirt: {
    template: 'shirt',
    defaultStretch: 0.05,
    score: topScore(0.45, 0.2, 0.1, 0.07, 0.18),
    ease: TOP_EASE,
  },
  sweater: {
    template: 'sweater',
    defaultStretch: 0.4,
    score: topScore(0.45, 0.2, 0.1, 0.07, 0.18),
    ease: TOP_EASE,
  },
  hoodie: {
    template: 'hoodie',
    defaultStretch: 0.3,
    score: topScore(0.45, 0.2, 0.1, 0.07, 0.18),
    ease: TOP_EASE,
  },
  jeans: {
    template: 'jeans',
    defaultStretch: 0.1,
    score: { waistCm: 0.38, hipCm: 0.32, inseamCm: 0.14, heightCm: 0.16 },
    ease: PANTS_EASE,
  },
  chinos: {
    template: 'chinos',
    defaultStretch: 0.08,
    score: { waistCm: 0.38, hipCm: 0.32, inseamCm: 0.14, heightCm: 0.16 },
    ease: PANTS_EASE,
  },
  shorts: {
    template: 'shorts',
    defaultStretch: 0.05,
    score: { waistCm: 0.5, hipCm: 0.43, heightCm: 0.07 },
    ease: [{ ...waistPants, weight: 0.45 }, { ...hipPants, weight: 0.35 }, thighPants],
  },
  skirt: {
    template: 'skirt',
    defaultStretch: 0.1,
    score: { waistCm: 0.48, hipCm: 0.4, heightCm: 0.12 },
    ease: [
      {
        dimension: 'waistCm',
        body: 'waistCm',
        weight: 0.55,
        unitCm: 2.5,
        nominal: [2, 4, 8, 12],
        floorCm: 0,
        stretchReliefCm: 5,
      },
      {
        dimension: 'hipCm',
        body: 'hipCm',
        weight: 0.45,
        unitCm: 3,
        nominal: [4, 8, 14, 20],
        floorCm: 2,
        stretchReliefCm: 8,
      },
    ],
  },
  dress: {
    template: 'dress',
    defaultStretch: 0.15,
    score: { chestCm: 0.28, waistCm: 0.26, hipCm: 0.28, shoulderWidthCm: 0.06, heightCm: 0.12 },
    ease: [
      {
        dimension: 'chestCm',
        body: 'chestCm',
        weight: 0.3,
        unitCm: 3,
        nominal: [4, 8, 14, 22],
        floorCm: 4,
        stretchReliefCm: 10,
      },
      {
        dimension: 'waistCm',
        body: 'waistCm',
        weight: 0.3,
        unitCm: 3,
        nominal: [2, 6, 14, 24],
        floorCm: 0,
        stretchReliefCm: 6,
      },
      {
        dimension: 'hipCm',
        body: 'hipCm',
        weight: 0.3,
        unitCm: 3,
        nominal: [4, 8, 16, 24],
        floorCm: 2,
        stretchReliefCm: 8,
      },
      { ...sleeve, weight: 0.1 },
    ],
  },
  blazer: {
    template: 'blazer',
    defaultStretch: 0.05,
    score: topScore(0.45, 0.22, 0.1, 0.08, 0.15),
    ease: OUTER_EASE,
  },
  jacket: {
    template: 'jacket',
    defaultStretch: 0.05,
    score: topScore(0.45, 0.22, 0.1, 0.08, 0.15),
    ease: OUTER_EASE,
  },
  coat: {
    template: 'coat',
    defaultStretch: 0.03,
    score: topScore(0.45, 0.22, 0.1, 0.08, 0.15),
    ease: OUTER_EASE,
  },
};

/** Umbrales de la clasificación de ajuste, en «unidades de tolerancia» (x = (ease − nominal) / unidad). */
export const VERDICT_BANDS = {
  /** x < tooTight → demasiado ajustada */
  tooTight: -2,
  /** x < snug → ceñida */
  snug: -0.75,
  /** x ≤ good → buen ajuste */
  good: 1,
  /** x ≤ roomy → holgada; por encima, demasiado holgada */
  roomy: 2.25,
} as const;
