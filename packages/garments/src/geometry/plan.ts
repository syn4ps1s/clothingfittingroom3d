import type {
  BodyModel,
  GarmentDefinition,
  GarmentFit,
  GarmentSizeSpec,
  GarmentSpec,
  GarmentTemplate,
} from '@fitroom/shared';
import { GarmentGeometryError } from './errors.js';

/** Parámetros físicos inferidos del id de tela (el generador sólo recibe `fabricId`, no el FabricDef). */
export interface FabricHint {
  /** espesor de la tela (m) */
  readonly thickness: number;
  /** 0 (rígida) .. 1 (muy elástica) */
  readonly stretch: number;
  /** 0 (fluida/caída) .. 1 (rígida): hacia `ClothSetup.stiffness` y la amplitud de pliegues */
  readonly stiffness: number;
  /** densidad de pliegues: más fluida = más y más suaves */
  readonly drape: number;
  readonly family: string;
}

const FAMILY_HINTS: Array<[RegExp, FabricHint]> = [
  [/denim|jean/, { thickness: 0.0012, stretch: 0.1, stiffness: 0.75, drape: 0.35, family: 'denim' }],
  [/corduroy|cord/, { thickness: 0.0016, stretch: 0.05, stiffness: 0.7, drape: 0.4, family: 'corduroy' }],
  [/fleece|hood|sweatshirt/, { thickness: 0.0022, stretch: 0.3, stiffness: 0.55, drape: 0.5, family: 'fleece' }],
  [/wool|knit|merino|sweater|cashmere/, { thickness: 0.0018, stretch: 0.4, stiffness: 0.5, drape: 0.55, family: 'wool-knit' }],
  [/tweed/, { thickness: 0.002, stretch: 0.05, stiffness: 0.8, drape: 0.3, family: 'tweed' }],
  [/leather/, { thickness: 0.0015, stretch: 0.05, stiffness: 0.85, drape: 0.25, family: 'leather' }],
  [/satin|silk|crepe/, { thickness: 0.0005, stretch: 0.1, stiffness: 0.15, drape: 0.95, family: 'satin' }],
  [/linen/, { thickness: 0.0007, stretch: 0.02, stiffness: 0.55, drape: 0.5, family: 'linen' }],
  [/poplin|shirt|oxford/, { thickness: 0.0005, stretch: 0.05, stiffness: 0.45, drape: 0.6, family: 'cotton-poplin' }],
  [/twill|chino|gabardine|cotton-twill/, { thickness: 0.0009, stretch: 0.1, stiffness: 0.6, drape: 0.45, family: 'twill' }],
  [/jersey|tee|cotton|polo/, { thickness: 0.0007, stretch: 0.35, stiffness: 0.25, drape: 0.8, family: 'cotton-jersey' }],
];

export function fabricHintFor(fabricId: string): FabricHint {
  const id = fabricId.toLowerCase();
  for (const [re, hint] of FAMILY_HINTS) if (re.test(id)) return hint;
  return { thickness: 0.0009, stretch: 0.2, stiffness: 0.45, drape: 0.6, family: 'generic' };
}

export interface ResolvedSize {
  readonly spec: GarmentSpec;
  readonly size: GarmentSizeSpec;
}

/** Busca la talla (insensible a mayúsculas). Error tipado si no existe. */
export function resolveSize(def: GarmentDefinition, sizeLabel: string): ResolvedSize {
  if (!def || !Array.isArray(def.sizes) || def.sizes.length === 0) {
    throw new GarmentGeometryError('invalid-definition', 'la prenda no tiene tallas');
  }
  const wanted = String(sizeLabel).trim().toUpperCase();
  const size = def.sizes.find((s) => s.label.trim().toUpperCase() === wanted);
  if (!size) {
    throw new GarmentGeometryError(
      'unknown-size',
      `talla «${sizeLabel}» inexistente en ${def.id} (disponibles: ${def.sizes.map((s) => s.label).join(', ')})`,
    );
  }
  return { spec: size.garment, size };
}

/** Holgura (m de circunferencia) respecto al cuerpo según el ajuste de la prenda, para rellenar medidas ausentes. */
export const EASE_BY_FIT: Readonly<Record<GarmentFit, number>> = {
  slim: 0.05,
  regular: 0.11,
  relaxed: 0.19,
  oversized: 0.3,
};

/** Caída de la sisa (m) bajo la axila del cuerpo según el ajuste. */
export const ARMHOLE_DROP_BY_FIT: Readonly<Record<GarmentFit, number>> = {
  slim: 0.012,
  regular: 0.025,
  relaxed: 0.04,
  oversized: 0.065,
};

/** Hombro caído (m) respecto al hueso del hombro según el ajuste. */
export const SHOULDER_DROP_BY_FIT: Readonly<Record<GarmentFit, number>> = {
  slim: 0,
  regular: 0.004,
  relaxed: 0.016,
  oversized: 0.04,
};

export interface TemplateDefaults {
  readonly lengthRatio: number; // largo espalda / estatura
  readonly sleeve: 'none' | 'short' | 'long' | 'cap';
  readonly sleeveRatio: number; // largo de manga / largo de brazo
}

export const TOP_DEFAULTS: Partial<Record<GarmentTemplate, TemplateDefaults>> = {
  tee: { lengthRatio: 0.395, sleeve: 'short', sleeveRatio: 0.34 },
  long_sleeve: { lengthRatio: 0.4, sleeve: 'long', sleeveRatio: 1.0 },
  tank: { lengthRatio: 0.385, sleeve: 'none', sleeveRatio: 0 },
  polo: { lengthRatio: 0.4, sleeve: 'short', sleeveRatio: 0.36 },
  shirt: { lengthRatio: 0.435, sleeve: 'long', sleeveRatio: 1.02 },
  sweater: { lengthRatio: 0.385, sleeve: 'long', sleeveRatio: 1.0 },
  hoodie: { lengthRatio: 0.395, sleeve: 'long', sleeveRatio: 1.03 },
  blazer: { lengthRatio: 0.43, sleeve: 'long', sleeveRatio: 1.02 },
  jacket: { lengthRatio: 0.37, sleeve: 'long', sleeveRatio: 1.02 },
  coat: { lengthRatio: 0.6, sleeve: 'long', sleeveRatio: 1.04 },
};

export function bodyOf(body: BodyModel): {
  H: number;
  chest: number;
  waist: number;
  hip: number;
  shoulder: number;
  arm: number;
  inseam: number;
  neck: number;
  thigh: number;
} {
  const m = body.measurements;
  return {
    H: m.heightCm / 100,
    chest: m.chestCm / 100,
    waist: m.waistCm / 100,
    hip: m.hipCm / 100,
    shoulder: m.shoulderWidthCm / 100,
    arm: m.armLengthCm / 100,
    inseam: m.inseamCm / 100,
    neck: m.neckCm / 100,
    thigh: m.thighCm / 100,
  };
}

export const cm = (v: number | undefined, fallback: number): number =>
  v !== undefined && Number.isFinite(v) ? v / 100 : fallback;

/** Valor de `def.params` con un valor por defecto. */
export function param(def: GarmentDefinition, key: string, fallback: number): number {
  const v = def.params?.[key];
  return v !== undefined && Number.isFinite(v) ? v : fallback;
}
