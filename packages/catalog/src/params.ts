import type { GarmentDefinition, GarmentTemplate } from '@fitroom/shared';

/**
 * Acuerdo CATALOG ↔ GARMENT-GEO sobre `GarmentDefinition.params`: claves, rangos válidos y valor por defecto por plantilla.
 * Todas las claves son números finitos. Las que dependen del tamaño se expresan como RATIOS (adimensionales) o en cm
 * absolutos pequeños (profundidades, anchos de cinta); las dimensiones grandes viven en `sizes[].garment`.
 * Documentación para humanos: `docs/template-params.md`.
 */
export interface ParamSpec {
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

const p = (min: number, max: number, def: number): ParamSpec => ({ min, max, default: def });

const NECK = {
  /** ancho de la abertura del cuello / ancho de hombros de la prenda */
  neckWidthRatio: p(0.25, 0.6, 0.4),
  /** descenso del cuello delantero respecto al punto alto del hombro (cm) */
  neckDropCm: p(0, 25, 8),
  /** descenso del cuello trasero (cm) */
  neckDropBackCm: p(0, 15, 2.5),
} as const;
const ARMHOLE = {
  /** profundidad de la sisa / contorno de pecho de la prenda */
  armholeDepthRatio: p(0.17, 0.3, 0.21),
} as const;
const SLEEVE = {
  /** contorno del puño / contorno del bíceps de la manga (1 = tubo recto) */
  sleeveTaper: p(0.5, 1.1, 0.85),
} as const;

const TOP_COMMON = {
  ...NECK,
  ...ARMHOLE,
  ...SLEEVE,
  /** altura del dobladillo doblado o de la cinta de bajo (cm) */
  hemFoldCm: p(0, 4, 1.5),
  /** abertura lateral del bajo (cm) */
  sideVentCm: p(0, 15, 0),
} as const;

const COLLAR = {
  collarHeightCm: p(3, 10, 5),
  placketLengthCm: p(8, 80, 15),
  placketWidthCm: p(2, 5, 3),
  buttonCount: p(0, 10, 3),
} as const;

const PANTS = {
  /** contorno de la rodilla / contorno del muslo de la prenda */
  kneeRatio: p(0.6, 1.05, 0.85),
  waistbandHeightCm: p(2, 7, 4),
  /** vuelta del bajo (cm), 0 = sin vuelta */
  cuffFoldCm: p(0, 6, 0),
  flyLengthCm: p(8, 18, 14),
  /** tiro trasero extra respecto al delantero (cm) */
  backRiseExtraCm: p(1, 8, 4),
} as const;

const OUTER = {
  neckWidthRatio: NECK.neckWidthRatio,
  ...ARMHOLE,
  ...SLEEVE,
  /** ancho de la solapa (cm), 0 = sin solapa */
  lapelWidthCm: p(0, 14, 8),
  /** punto de pliegue de la solapa, fracción del largo delantero desde el cuello */
  lapelRollRatio: p(0.3, 0.65, 0.5),
  collarHeightCm: p(3, 10, 5),
  buttonCount: p(0, 10, 2),
  /** posición del botón/cierre principal, fracción del largo desde el cuello */
  buttonStanceRatio: p(0.35, 0.75, 0.55),
  ventLengthCm: p(0, 60, 0),
  /** grosor de la hombrera (cm) */
  shoulderPadCm: p(0, 3, 0),
} as const;

type Spec = Readonly<Record<string, ParamSpec>>;

interface TemplateParams {
  /** claves que TODA prenda de la plantilla debe definir */
  readonly required: Spec;
  /** claves permitidas pero no obligatorias */
  readonly optional: Spec;
}

const without = (spec: Spec, ...keys: string[]): Spec =>
  Object.fromEntries(Object.entries(spec).filter(([k]) => !keys.includes(k)));

export const TEMPLATE_PARAM_SPECS: Readonly<Record<GarmentTemplate, TemplateParams>> = {
  tee: { required: TOP_COMMON, optional: {} },
  long_sleeve: { required: TOP_COMMON, optional: {} },
  tank: {
    required: {
      ...without(TOP_COMMON, 'sleeveTaper'),
      strapWidthCm: p(0.5, 8, 3),
    },
    optional: {},
  },
  polo: { required: { ...TOP_COMMON, ...COLLAR }, optional: {} },
  shirt: { required: { ...TOP_COMMON, ...COLLAR }, optional: {} },
  sweater: { required: { ...TOP_COMMON, ribHeightCm: p(0, 10, 5) }, optional: {} },
  hoodie: {
    required: {
      ...TOP_COMMON,
      ribHeightCm: p(0, 10, 7),
      hoodHeightCm: p(25, 45, 36),
      hoodWidthCm: p(20, 35, 27),
      pocketWidthCm: p(15, 40, 28),
    },
    optional: {},
  },
  jeans: { required: PANTS, optional: {} },
  chinos: { required: PANTS, optional: {} },
  shorts: { required: PANTS, optional: {} },
  skirt: {
    required: {
      waistbandHeightCm: p(1, 8, 3.5),
      /** nº de pliegues (0 = falda lisa/acampanada) */
      pleatCount: p(0, 120, 0),
      pleatDepthCm: p(0, 6, 2),
      slitLengthCm: p(0, 60, 0),
    },
    optional: {},
  },
  dress: {
    required: {
      ...NECK,
      ...ARMHOLE,
      /** altura de la cintura sobre el largo total (cuello → bajo) */
      waistLevelRatio: p(0.3, 0.55, 0.4),
      /** fruncido en la costura de cintura, 0 = sin fruncir */
      gatherRatio: p(0, 0.6, 0),
      slitLengthCm: p(0, 60, 0),
    },
    optional: {
      ...SLEEVE,
      ...COLLAR,
      strapWidthCm: p(0.5, 8, 1),
      ribHeightCm: p(0, 10, 5),
    },
  },
  blazer: { required: OUTER, optional: {} },
  jacket: { required: OUTER, optional: {} },
  coat: { required: OUTER, optional: {} },
};

/** Valor de un parámetro de plantilla: el de la prenda o, si falta, el valor por defecto documentado. */
export function templateParam(def: GarmentDefinition, key: string): number | undefined {
  const own = def.params?.[key];
  if (own !== undefined && Number.isFinite(own)) return own;
  const spec = TEMPLATE_PARAM_SPECS[def.template];
  return (spec.required[key] ?? spec.optional[key])?.default;
}
