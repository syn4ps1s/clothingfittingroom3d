/**
 * Derivación de mapas: cavidades (AO) y normal tangent-space a partir del campo de alturas.
 * Todo envuelve en los bordes (tileable). Las funciones trabajan por bandas de filas y escriben
 * píxeles RGBA empaquetados en `Uint32Array` (una escritura por píxel).
 */

/** `true` en las plataformas little-endian (todas las relevantes). Condiciona el empaquetado RGBA. */
export const LITTLE_ENDIAN: boolean = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Empaqueta r,g,b,a (0..255 enteros) en un uint32 cuyo orden de bytes en memoria es R,G,B,A. */
export function packRgba(r: number, g: number, b: number, a: number): number {
  return LITTLE_ENDIAN
    ? ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
    : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

/** Desenfoque horizontal por ventana deslizante (radio r) con envoltura. Filas y0..y1-1. */
export function blurRowsH(
  src: Float32Array,
  dst: Float32Array,
  size: number,
  r: number,
  y0: number,
  y1: number,
): void {
  const S = size;
  const inv = 1 / (2 * r + 1);
  for (let y = y0; y < y1; y++) {
    const o = y * S;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[o + ((k + S) % S)]!;
    for (let x = 0; x < S; x++) {
      dst[o + x] = sum * inv;
      const xi = x + r + 1;
      const xo = x - r;
      sum += src[o + (xi >= S ? xi - S : xi)]! - src[o + (xo < 0 ? xo + S : xo)]!;
    }
  }
}

export interface NormalAoParams {
  readonly size: number;
  readonly strength: number; // pendiente por unidad de relieve
  readonly bumpUnitPx: number;
  readonly aoStrength: number;
  readonly aoRadius: number;
}

/**
 * Para las filas y0..y1-1: AO (desenfoque vertical de `Hb` menos H) y normal (Sobel) → bytes.
 * Escribe la normal como RGBA en `normal32` y el AO (0..255) en `aoOut` para el empaquetado ORM.
 */
export function normalAoBand(
  H: Float32Array,
  Hb: Float32Array,
  p: NormalAoParams,
  y0: number,
  y1: number,
  normal32: Uint32Array,
  aoOut: Uint8Array,
  colSum: Float32Array,
): void {
  const S = p.size;
  const r = p.aoRadius;
  const inv = 1 / (2 * r + 1);
  const scale = p.strength * p.bumpUnitPx;
  const aoK = p.aoStrength * 3.2;

  // suma vertical inicial para la fila y0
  colSum.fill(0);
  for (let k = -r; k <= r; k++) {
    const o = ((y0 + k + S * 4) % S) * S;
    for (let x = 0; x < S; x++) colSum[x] = colSum[x]! + Hb[o + x]!;
  }

  for (let y = y0; y < y1; y++) {
    const o = y * S;
    const om = (y === 0 ? S - 1 : y - 1) * S;
    const op = (y === S - 1 ? 0 : y + 1) * S;
    // ventana 3×3 deslizante: 3 lecturas por píxel
    let a = H[om + S - 1]!;
    let b = H[om]!;
    let c = H[om + 1]!;
    let d = H[o + S - 1]!;
    let e = H[o]!;
    let f = H[o + 1]!;
    let g = H[op + S - 1]!;
    let h = H[op]!;
    let i = H[op + 1]!;
    for (let x = 0; x < S; x++) {
      const dx = (c + 2 * f + i - (a + 2 * d + g)) * 0.125;
      const dy = (g + 2 * h + i - (a + 2 * b + c)) * 0.125;
      const nx = -dx * scale;
      const ny = -dy * scale;
      const il = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const rr = (nx * il * 0.5 + 0.5) * 255 + 0.5;
      const gg = (ny * il * 0.5 + 0.5) * 255 + 0.5;
      const bb = (il * 0.5 + 0.5) * 255 + 0.5;
      normal32[o + x] = LITTLE_ENDIAN
        ? ((255 << 24) | ((bb | 0) << 16) | ((gg | 0) << 8) | (rr | 0)) >>> 0
        : (((rr | 0) << 24) | ((gg | 0) << 16) | ((bb | 0) << 8) | 255) >>> 0;
      // cavidad: media local − altura
      const cav = colSum[x]! * inv - e;
      let ao = 1 - aoK * (cav > 0 ? cav : 0);
      if (ao < 0.22) ao = 0.22;
      aoOut[o + x] = ao * 255 + 0.5;
      // avanza la ventana
      const xn = x + 2 >= S ? x + 2 - S : x + 2;
      a = b;
      b = c;
      c = H[om + xn]!;
      d = e;
      e = f;
      f = H[o + xn]!;
      g = h;
      h = i;
      i = H[op + xn]!;
    }
    // desliza la ventana vertical a la fila siguiente
    const add = ((y + r + 1) % S) * S;
    const sub = ((y - r + S * 4) % S) * S;
    for (let x = 0; x < S; x++) colSum[x] = colSum[x]! + Hb[add + x]! - Hb[sub + x]!;
  }
}
