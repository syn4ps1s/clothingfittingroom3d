import type { SwatchVariant } from '@fitroom/shared';
import { clamp01 } from '../util.js';

/** Color en OKLCH: L 0..1 (luminosidad percibida), C ≥ 0 (croma), h en grados [0, 360). */
export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

const srgbToLinear = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** `#rrggbb` → OKLCH (Björn Ottosson). Lanza si el formato no es válido. */
export function hexToOklch(hex: string): Oklch {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new RangeError(`color inválido: ${hex.slice(0, 20)}`);
  const r = srgbToLinear(parseInt(hex.slice(1, 3), 16) / 255);
  const g = srgbToLinear(parseInt(hex.slice(3, 5), 16) / 255);
  const b = srgbToLinear(parseInt(hex.slice(5, 7), 16) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}

/** Distancia angular entre tonos, 0..180. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** 0 = neutro (blanco, negro, grises, beige…) … 1 = claramente cromático. Continuo, sin umbrales duros. */
export function colorfulness(color: Oklch): number {
  return smoothstep(0.03, 0.1, color.c);
}

const HUE_FLOOR = 0.3;
/** Campana suave (coseno²) alrededor de un tono: `peak` en el centro, `HUE_FLOOR` a `halfWidth` grados. */
function bump(delta: number, center: number, halfWidth: number, peak: number): number {
  const t = Math.min(1, Math.abs(delta - center) / halfWidth);
  const c = Math.cos((Math.PI / 2) * t);
  return HUE_FLOOR + (peak - HUE_FLOOR) * c * c;
}

/** Armonía entre dos tonos (0..1): análoga ≈ 0, complementaria ≈ 180°, triádica ≈ 120°; el resto choca. */
export function hueHarmony(deltaHue: number): number {
  return Math.max(
    HUE_FLOOR,
    bump(deltaHue, 0, 42, 0.93),
    bump(deltaHue, 180, 34, 0.86),
    bump(deltaHue, 120, 18, 0.62),
  );
}

/** Armonía de dos colores (0..1): mezcla continua entre «neutros combinan con todo» y la regla de tonos. */
export function pairHarmony(a: Oklch, b: Oklch): number {
  const dl = Math.abs(a.l - b.l);
  const neutral = 0.82 + 0.13 * Math.min(1, dl / 0.3);
  const colorful = Math.min(colorfulness(a), colorfulness(b));
  if (colorful <= 0) return neutral;
  let hue = hueHarmony(hueDistance(a.h, b.h));
  if (a.c > 0.1 && b.c > 0.1 && hue < 0.9) hue *= 0.92; // dos tonos saturados compitiendo
  if (dl < 0.05) hue *= 0.95; // mismo valor tonal: la mezcla se «vibra»
  return (1 - colorful) * neutral + colorful * hue;
}

export interface PaletteColor {
  readonly color: Oklch;
  /** peso en la mezcla: el color base pesa más que los secundarios del estampado */
  readonly weight: number;
}

/** Colores representativos de una muestra: base (peso 1) + colores del estampado (0,4 / 0,2). */
export function paletteOf(variant: SwatchVariant): PaletteColor[] {
  const out: PaletteColor[] = [{ color: hexToOklch(variant.color), weight: 1 }];
  const p = variant.pattern;
  if (p.type !== 'solid') {
    out.push({ color: hexToOklch(p.color2), weight: 0.4 });
    if ('color3' in p && p.color3 !== undefined) out.push({ color: hexToOklch(p.color3), weight: 0.2 });
  }
  return out;
}

/** Armonía entre dos muestras (media ponderada de todos los pares de colores). */
export function variantHarmony(a: readonly PaletteColor[], b: readonly PaletteColor[]): number {
  let num = 0;
  let den = 0;
  for (const x of a) {
    for (const y of b) {
      const w = x.weight * y.weight;
      num += w * pairHarmony(x.color, y.color);
      den += w;
    }
  }
  return den > 0 ? num / den : 0;
}

export type HarmonyKind =
  | 'neutral'
  | 'accent'
  | 'monochrome'
  | 'analogous'
  | 'complementary'
  | 'triadic'
  | 'clash';

/** Clasifica un conjunto por sus colores base (uno por prenda). */
export function classifyHarmony(bases: readonly Oklch[]): HarmonyKind {
  const chromatic = bases.filter((c) => colorfulness(c) >= 0.5);
  if (chromatic.length === 0) return 'neutral';
  if (chromatic.length === 1) return 'accent';
  let spread = 0;
  for (let i = 0; i < chromatic.length; i++) {
    for (let j = i + 1; j < chromatic.length; j++) {
      spread = Math.max(spread, hueDistance(chromatic[i]!.h, chromatic[j]!.h));
    }
  }
  if (spread <= 22) return 'monochrome';
  if (spread <= 40) return 'analogous';
  if (chromatic.length === 2 && Math.abs(spread - 180) <= 32) return 'complementary';
  if (Math.abs(spread - 120) <= 22) return 'triadic';
  return 'clash';
}
