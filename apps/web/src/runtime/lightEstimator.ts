/**
 * Estimación barata de la iluminación ambiente a partir del vídeo (muestreo en un canvas diminuto).
 * Sirve para modular exposición, tinte y dirección de las luces de las prendas y que no parezcan
 * «pegadas» sobre el vídeo.
 */
export interface LightEstimate {
  /** Luminancia media percibida (sRGB codificada) 0..1. */
  readonly luma: number;
  /** Luminancia media lineal 0..1 (la que importa para exposición física). */
  readonly lumaLinear: number;
  /** Luma media en escala 0..255 (para el escaneo: «poca luz»). */
  readonly luma255: number;
  /** Color medio lineal normalizado a luminancia 1 (tinte de la luz; ≈[1,1,1] si es neutra). */
  readonly tint: readonly [number, number, number];
  /** −1 (más luz a la izquierda de la imagen) .. +1 (a la derecha). Imagen NO espejada. */
  readonly dirX: number;
  /** −1 (más luz abajo) .. +1 (arriba). */
  readonly dirY: number;
  /** 0..1 — dispersión de luminancia (escenas contrastadas → luz más dura). */
  readonly contrast: number;
}

export const NEUTRAL_LIGHT: LightEstimate = {
  luma: 0.5,
  lumaLinear: 0.2,
  luma255: 128,
  tint: [1, 1, 1],
  dirX: 0,
  dirY: 0.4,
  contrast: 0.3,
};

const SRGB_TO_LINEAR = (() => {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return lut;
})();

export interface LightEstimatorOptions {
  /** Constante de tiempo (ms) del suavizado temporal de la estimación. */
  readonly smoothingMs: number;
  /** Ancho de la rejilla de muestreo (el alto sale de la relación de aspecto). */
  readonly gridWidth: number;
}

/** Calcula estadísticas de iluminación de un buffer RGBA y las suaviza en el tiempo. */
export class LightEstimator {
  private current: LightEstimate = NEUTRAL_LIGHT;
  private initialised = false;
  private lastT = 0;
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  private readonly opts: LightEstimatorOptions;

  constructor(opts: Partial<LightEstimatorOptions> = {}) {
    this.opts = { smoothingMs: 500, gridWidth: 32, ...opts };
  }

  get estimate(): LightEstimate {
    return this.current;
  }

  get hasEstimate(): boolean {
    return this.initialised;
  }

  reset(): void {
    this.initialised = false;
    this.current = NEUTRAL_LIGHT;
  }

  /** Muestrea el vídeo/canvas dado (coste ≈ un `drawImage` a 32×18 + 576 píxeles). */
  sampleSource(
    source: CanvasImageSource & { videoWidth?: number; videoHeight?: number },
    nowMs: number,
  ): LightEstimate | null {
    const sw = source.videoWidth ?? (source as { width?: number }).width ?? 0;
    const sh = source.videoHeight ?? (source as { height?: number }).height ?? 0;
    if (!(sw > 0 && sh > 0)) return null;
    const gw = this.opts.gridWidth;
    const gh = Math.max(4, Math.round((gw * sh) / sw));
    if (!this.canvas || this.canvas.width !== gw || this.canvas.height !== gh) {
      this.canvas = makeCanvas(gw, gh);
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true }) as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D
        | null;
    }
    const ctx = this.ctx;
    if (!ctx) return null;
    try {
      ctx.drawImage(source, 0, 0, gw, gh);
      const data = ctx.getImageData(0, 0, gw, gh).data;
      return this.updateFromPixels(data, gw, gh, nowMs);
    } catch {
      return null; // origen no legible (p. ej. vídeo aún sin fotograma): se conserva la estimación previa
    }
  }

  /** Núcleo puro y testeable: RGBA8 sRGB → estimación suavizada. */
  updateFromPixels(
    data: ArrayLike<number>,
    width: number,
    height: number,
    nowMs: number,
  ): LightEstimate {
    const raw = computeLightStats(data, width, height);
    if (!this.initialised) {
      this.current = raw;
      this.initialised = true;
    } else {
      const dt = Math.max(0, Math.min(2000, nowMs - this.lastT));
      const a = 1 - Math.exp(-dt / this.opts.smoothingMs);
      const c = this.current;
      this.current = {
        luma: c.luma + (raw.luma - c.luma) * a,
        lumaLinear: c.lumaLinear + (raw.lumaLinear - c.lumaLinear) * a,
        luma255: c.luma255 + (raw.luma255 - c.luma255) * a,
        tint: [
          c.tint[0] + (raw.tint[0] - c.tint[0]) * a,
          c.tint[1] + (raw.tint[1] - c.tint[1]) * a,
          c.tint[2] + (raw.tint[2] - c.tint[2]) * a,
        ],
        dirX: c.dirX + (raw.dirX - c.dirX) * a,
        dirY: c.dirY + (raw.dirY - c.dirY) * a,
        contrast: c.contrast + (raw.contrast - c.contrast) * a,
      };
    }
    this.lastT = nowMs;
    return this.current;
  }
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

/** Estadísticas crudas de una rejilla RGBA8 (sin suavizado temporal). Siempre finitas. */
export function computeLightStats(
  data: ArrayLike<number>,
  width: number,
  height: number,
): LightEstimate {
  const n = width * height;
  if (!(n > 0) || data.length < n * 4) return NEUTRAL_LIGHT;
  let sumLin = 0;
  let sumLuma = 0;
  let sumSq = 0;
  let r = 0,
    g = 0,
    b = 0;
  let left = 0,
    right = 0,
    top = 0,
    bottom = 0;
  const sideW = Math.max(1, Math.floor(width / 3));
  const halfH = Math.floor(height / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const R = data[i]!,
        G = data[i + 1]!,
        B = data[i + 2]!;
      const lr = SRGB_TO_LINEAR[R & 255]!,
        lg = SRGB_TO_LINEAR[G & 255]!,
        lb = SRGB_TO_LINEAR[B & 255]!;
      const lin = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
      const luma = (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255;
      sumLin += lin;
      sumLuma += luma;
      sumSq += luma * luma;
      r += lr;
      g += lg;
      b += lb;
      // dirección: columnas laterales (la persona suele ocupar el centro y sesgaría el resultado)
      if (x < sideW) {
        left += lin;
      } else if (x >= width - sideW) {
        right += lin;
      }
      if (y < halfH) top += lin;
      else if (y >= height - halfH) {
        bottom += lin;
      }
    }
  }
  const meanLin = sumLin / n;
  const meanLuma = sumLuma / n;
  const variance = Math.max(0, sumSq / n - meanLuma * meanLuma);
  const lumSafe = Math.max(1e-4, meanLin);
  const tint: [number, number, number] = [
    clamp(r / n / lumSafe, 0.5, 1.6),
    clamp(g / n / lumSafe, 0.5, 1.6),
    clamp(b / n / lumSafe, 0.5, 1.6),
  ];
  // normaliza el tinte a luminancia ≈ 1
  const tl = 0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2];
  tint[0] /= tl;
  tint[1] /= tl;
  tint[2] /= tl;
  const side = Math.max(1e-4, left + right);
  const vert = Math.max(1e-4, top + bottom);
  return {
    luma: meanLuma,
    lumaLinear: meanLin,
    luma255: meanLuma * 255,
    tint,
    dirX: clamp((right - left) / side, -1, 1),
    dirY: clamp((top - bottom) / vert, -1, 1),
    contrast: clamp(Math.sqrt(variance) * 3, 0, 1),
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo;
}
