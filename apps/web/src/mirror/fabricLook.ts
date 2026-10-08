import type { FabricDef, FabricFamily } from '@fitroom/shared';

/** Parámetros de apariencia PBR que dependen de la familia de tela (lo que las texturas no codifican). */
export interface FabricLook {
  /** Intensidad base del brillo de fibra (sheen) 0..1. */
  readonly sheen: number;
  /** Rugosidad del sheen 0..1 (alto = fieltro/pelusa; bajo = brillo de satén). */
  readonly sheenRoughness: number;
  /** 0 = sheen blanco, 1 = sheen del color de la tela. */
  readonly sheenTint: number;
  readonly clearcoat: number;
  readonly clearcoatRoughness: number;
  /** Anisotropía (satén/seda: brillo estirado perpendicular a la fibra). */
  readonly anisotropy: number;
  /** Multiplicador de la intensidad del normal map de tejido. */
  readonly normalScale: number;
  /** Intensidad de reflejo especular dieléctrico (three: specularIntensity). */
  readonly specularIntensity: number;
}

const base: FabricLook = {
  sheen: 0.25,
  sheenRoughness: 0.55,
  sheenTint: 0.6,
  clearcoat: 0,
  clearcoatRoughness: 0.4,
  anisotropy: 0,
  normalScale: 1,
  specularIntensity: 0.6,
};

const L = (o: Partial<FabricLook>): FabricLook => ({ ...base, ...o });

/** Tabla por familia. Valores elegidos por inspección visual (ver docs de MIRROR). */
export const FABRIC_LOOKS: Readonly<Record<FabricFamily, FabricLook>> = {
  'cotton-jersey': L({ sheen: 0.35, sheenRoughness: 0.6, normalScale: 0.9 }),
  'cotton-poplin': L({ sheen: 0.25, sheenRoughness: 0.5, normalScale: 0.8, specularIntensity: 0.7 }),
  denim: L({ sheen: 0.12, sheenRoughness: 0.7, normalScale: 1.25, specularIntensity: 0.4 }),
  linen: L({ sheen: 0.2, sheenRoughness: 0.75, normalScale: 1.35, specularIntensity: 0.4 }),
  'wool-knit': L({ sheen: 0.7, sheenRoughness: 0.85, sheenTint: 0.8, normalScale: 1.2, specularIntensity: 0.3 }),
  merino: L({ sheen: 0.65, sheenRoughness: 0.8, sheenTint: 0.8, normalScale: 1.05, specularIntensity: 0.3 }),
  satin: L({
    sheen: 0.45,
    sheenRoughness: 0.3,
    sheenTint: 0.4,
    anisotropy: 0.65,
    normalScale: 0.5,
    specularIntensity: 1,
  }),
  'silk-crepe': L({
    sheen: 0.4,
    sheenRoughness: 0.4,
    sheenTint: 0.5,
    anisotropy: 0.3,
    normalScale: 0.7,
    specularIntensity: 0.8,
  }),
  leather: L({
    sheen: 0,
    clearcoat: 0.45,
    clearcoatRoughness: 0.35,
    normalScale: 1.1,
    specularIntensity: 0.8,
  }),
  corduroy: L({ sheen: 0.85, sheenRoughness: 0.8, sheenTint: 0.85, normalScale: 1.5, specularIntensity: 0.25 }),
  fleece: L({ sheen: 0.9, sheenRoughness: 0.9, sheenTint: 0.9, normalScale: 1.1, specularIntensity: 0.2 }),
  twill: L({ sheen: 0.2, sheenRoughness: 0.6, normalScale: 1.1, specularIntensity: 0.5 }),
  tweed: L({ sheen: 0.3, sheenRoughness: 0.85, normalScale: 1.5, specularIntensity: 0.3 }),
};

/** Look final: familia + brillo de fibra concreto de la tela (FabricDef.sheen 0..1). */
export function lookFor(fabric: Pick<FabricDef, 'family' | 'sheen'>): FabricLook {
  const l = FABRIC_LOOKS[fabric.family] ?? base;
  const sheen = Math.min(1, Math.max(0, l.sheen * 0.5 + fabric.sheen * 0.6));
  return { ...l, sheen: l.sheen === 0 ? 0 : sheen };
}
