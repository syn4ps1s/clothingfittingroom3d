import { hashU32, hash01 } from './prng.js';

/**
 * Ruido PERIÓDICO (tileable por construcción): el lattice se envuelve con módulo `period`,
 * así que cualquier campo construido con él repite sin costura cada `period` celdas.
 */

const TWO_PI = Math.PI * 2;

/** Ruido de gradiente (tipo Perlin) 2D con periodo entero. Salida aprox. en [-1, 1]. */
export class PeriodicNoise2D {
  readonly period: number;
  private readonly g: Float32Array; // [gx, gy] por nodo

  constructor(period: number, seed: number) {
    const p = Math.max(1, Math.floor(period));
    this.period = p;
    this.g = new Float32Array(p * p * 2);
    for (let y = 0; y < p; y++) {
      for (let x = 0; x < p; x++) {
        const a = hash01(seed, x, y, 7) * TWO_PI;
        const i = (y * p + x) * 2;
        this.g[i] = Math.cos(a);
        this.g[i + 1] = Math.sin(a);
      }
    }
  }

  /** Muestrea en coordenadas de lattice (cualquier real; se envuelve). */
  sample(x: number, y: number): number {
    const P = this.period;
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const fx = x - xf;
    const fy = y - yf;
    let x0 = xf % P;
    if (x0 < 0) x0 += P;
    let y0 = yf % P;
    if (y0 < 0) y0 += P;
    const x1 = x0 + 1 === P ? 0 : x0 + 1;
    const y1 = y0 + 1 === P ? 0 : y0 + 1;
    const g = this.g;
    const i00 = (y0 * P + x0) * 2;
    const i10 = (y0 * P + x1) * 2;
    const i01 = (y1 * P + x0) * 2;
    const i11 = (y1 * P + x1) * 2;
    const n00 = g[i00]! * fx + g[i00 + 1]! * fy;
    const n10 = g[i10]! * (fx - 1) + g[i10 + 1]! * fy;
    const n01 = g[i01]! * fx + g[i01 + 1]! * (fy - 1);
    const n11 = g[i11]! * (fx - 1) + g[i11 + 1]! * (fy - 1);
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const a = n00 + u * (n10 - n00);
    const b = n01 + u * (n11 - n01);
    return (a + v * (b - a)) * 1.4142;
  }
}

/** Ruido de valor 2D periódico (más barato que el de gradiente). Salida en [-1, 1]. */
export class PeriodicValueNoise2D {
  readonly period: number;
  private readonly v: Float32Array;

  constructor(period: number, seed: number) {
    const p = Math.max(1, Math.floor(period));
    this.period = p;
    this.v = new Float32Array(p * p);
    for (let y = 0; y < p; y++) {
      for (let x = 0; x < p; x++) this.v[y * p + x] = hash01(seed, x, y, 5) * 2 - 1;
    }
  }

  sample(x: number, y: number): number {
    const P = this.period;
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const fx = x - xf;
    const fy = y - yf;
    let x0 = xf % P;
    if (x0 < 0) x0 += P;
    let y0 = yf % P;
    if (y0 < 0) y0 += P;
    const x1 = x0 + 1 === P ? 0 : x0 + 1;
    const y1 = y0 + 1 === P ? 0 : y0 + 1;
    const d = this.v;
    const u = fx * fx * (3 - 2 * fx);
    const w = fy * fy * (3 - 2 * fy);
    const a = d[y0 * P + x0]! + (d[y0 * P + x1]! - d[y0 * P + x0]!) * u;
    const b = d[y1 * P + x0]! + (d[y1 * P + x1]! - d[y1 * P + x0]!) * u;
    return a + (b - a) * w;
  }
}

/** Ruido de valor 1D periódico (para perfiles a lo largo de un hilo). Salida en [0, 1]. */
export class PeriodicNoise1D {
  readonly period: number;
  private readonly v: Float32Array;

  constructor(period: number, seed: number, stream = 0) {
    const p = Math.max(1, Math.floor(period));
    this.period = p;
    this.v = new Float32Array(p);
    for (let i = 0; i < p; i++) this.v[i] = hash01(seed, i, stream, 13);
  }

  sample(x: number): number {
    const P = this.period;
    const xf = Math.floor(x);
    const f = x - xf;
    let i0 = xf % P;
    if (i0 < 0) i0 += P;
    const i1 = i0 + 1 === P ? 0 : i0 + 1;
    const t = f * f * (3 - 2 * f);
    return this.v[i0]! + (this.v[i1]! - this.v[i0]!) * t;
  }
}

/**
 * fBm periódico: suma `octaves` octavas de {@link PeriodicNoise2D}; el periodo de cada octava es
 * `basePeriod * 2^k`, de modo que el conjunto es periódico en el lattice base.
 */
export class PeriodicFbm {
  readonly basePeriod: number;
  private readonly octaves: PeriodicNoise2D[];
  private readonly amps: number[];
  private readonly norm: number;

  constructor(basePeriod: number, octaves: number, seed: number, gain = 0.5) {
    this.basePeriod = Math.max(1, Math.floor(basePeriod));
    this.octaves = [];
    this.amps = [];
    let a = 1;
    let sum = 0;
    for (let k = 0; k < octaves; k++) {
      this.octaves.push(new PeriodicNoise2D(this.basePeriod << k, hashU32(seed, k, 99)));
      this.amps.push(a);
      sum += a;
      a *= gain;
    }
    this.norm = 1 / sum;
  }

  /** `x`,`y` en unidades de la octava base (el tile completo mide `basePeriod`). */
  sample(x: number, y: number): number {
    let s = 0;
    let f = 1;
    for (let k = 0; k < this.octaves.length; k++) {
      s += this.amps[k]! * this.octaves[k]!.sample(x * f, y * f);
      f *= 2;
    }
    return s * this.norm;
  }
}

/**
 * Campo periódico de baja resolución (res×res) con muestreo bilineal envolvente.
 * Sirve para variaciones suaves (desgaste, manchas) sin evaluar ruido por píxel.
 */
export class LowResField {
  readonly res: number;
  private readonly data: Float32Array;

  constructor(res: number, fn: (u: number, v: number) => number) {
    this.res = res;
    this.data = new Float32Array(res * res);
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) this.data[y * res + x] = fn(x / res, y / res);
    }
  }

  /** u,v en [0,1) (se envuelven). */
  sample(u: number, v: number): number {
    const R = this.res;
    const x = (u - Math.floor(u)) * R;
    const y = (v - Math.floor(v)) * R;
    const x0 = x | 0;
    const y0 = y | 0;
    const fx = x - x0;
    const fy = y - y0;
    const x1 = x0 + 1 === R ? 0 : x0 + 1;
    const y1 = y0 + 1 === R ? 0 : y0 + 1;
    const d = this.data;
    const a = d[y0 * R + x0]! + (d[y0 * R + x1]! - d[y0 * R + x0]!) * fx;
    const b = d[y1 * R + x0]! + (d[y1 * R + x1]! - d[y1 * R + x0]!) * fx;
    return a + (b - a) * fy;
  }
}

/** Tabla de seno sobre "vueltas" (argumento 1.0 = 2π). Evita `Math.sin` en bucles calientes. */
const SIN_N = 4096;
const SIN_LUT = (() => {
  const t = new Float32Array(SIN_N + 1);
  for (let i = 0; i <= SIN_N; i++) t[i] = Math.sin((i / SIN_N) * TWO_PI);
  return t;
})();

/** sin(2π·t) con interpolación lineal sobre tabla (error < 2e-6). */
export function sinTurns(t: number): number {
  const f = t - Math.floor(t);
  const x = f * SIN_N;
  const i = x | 0;
  const a = SIN_LUT[i]!;
  return a + (SIN_LUT[i + 1]! - a) * (x - i);
}

/** cos(2π·t). */
export function cosTurns(t: number): number {
  return sinTurns(t + 0.25);
}

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export function smooth01(e0: number, e1: number, x: number): number {
  const t = (x - e0) / (e1 - e0);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}
