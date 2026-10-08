/**
 * Utilidades de color. El texturizado mezcla en espacio LINEAL y codifica a sRGB con una tabla.
 */

export type RGB = readonly [number, number, number];

/** sRGB 8 bit → lineal 0..1 */
export const SRGB_TO_LINEAR: Float32Array = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

const ENC_N = 16384;
/** lineal (0..1, índice cuantizado a 1/16384) → sRGB 8 bit */
const LINEAR_TO_SRGB8: Uint8Array = (() => {
  const t = new Uint8Array(ENC_N + 1);
  for (let i = 0; i <= ENC_N; i++) {
    const l = i / ENC_N;
    const c = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
    t[i] = Math.round(Math.min(1, Math.max(0, c)) * 255);
  }
  return t;
})();

/** Codifica un valor lineal a sRGB 8 bit (satura fuera de 0..1). */
export function encodeSrgb8(linear: number): number {
  if (!(linear > 0)) return 0;
  if (linear >= 1) return 255;
  return LINEAR_TO_SRGB8[(linear * ENC_N + 0.5) | 0]!;
}

/** `#rrggbb` → RGB lineal. Entradas inválidas devuelven gris medio (la validación real es zod). */
export function hexToLinear(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return [0.2, 0.2, 0.2];
  const n = parseInt(m[1]!, 16);
  return [
    SRGB_TO_LINEAR[(n >> 16) & 255]!,
    SRGB_TO_LINEAR[(n >> 8) & 255]!,
    SRGB_TO_LINEAR[n & 255]!,
  ];
}

export function linearToSrgbFloat(l: number): number {
  const c = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  return Math.min(1, Math.max(0, c));
}

export function srgbFloatToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Luminancia relativa (Rec. 709) de un RGB lineal. */
export function luminance(c: RGB): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function mixRgb(a: RGB, b: RGB, t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function scaleRgb(a: RGB, s: number): [number, number, number] {
  return [a[0] * s, a[1] * s, a[2] * s];
}

/** Rota el tono en espacio sRGB-perceptual (aprox. HSL) y devuelve lineal. `deg` en grados. */
export function shiftHueLinear(c: RGB, deg: number, satScale = 1): [number, number, number] {
  const r = linearToSrgbFloat(c[0]);
  const g = linearToSrgbFloat(c[1]);
  const b = linearToSrgbFloat(c[2]);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  let h = 0;
  let s = 0;
  const d = mx - mn;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (mx === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  h = (((h + deg / 360) % 1) + 1) % 1;
  s = Math.min(1, Math.max(0, s * satScale));
  const q2 = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p2 = 2 * l - q2;
  const hue = (t: number): number => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p2 + (q2 - p2) * 6 * t;
    if (t < 1 / 2) return q2;
    if (t < 2 / 3) return p2 + (q2 - p2) * (2 / 3 - t) * 6;
    return p2;
  };
  const rr = s === 0 ? l : hue(h + 1 / 3);
  const gg = s === 0 ? l : hue(h);
  const bb = s === 0 ? l : hue(h - 1 / 3);
  return [srgbFloatToLinear(rr), srgbFloatToLinear(gg), srgbFloatToLinear(bb)];
}
