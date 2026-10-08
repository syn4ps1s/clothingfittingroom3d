import { q, v3, clamp, QUAT_IDENTITY, type Quat, type Vec3 } from '@fitroom/shared';

/**
 * Utilidades geométricas internas del paquete `pose` (puras, sin DOM).
 * Convención del proyecto: mano derecha, +Y arriba, +Z hacia donde mira el cuerpo, cuaterniones [x,y,z,w].
 */

export const AXIS_X: Vec3 = [1, 0, 0];
export const AXIS_Y: Vec3 = [0, 1, 0];
export const AXIS_Z: Vec3 = [0, 0, 1];

/** `x` si es finito; si no, `fallback`. */
export const finiteOr = (x: number, fallback: number): number =>
  Number.isFinite(x) ? x : fallback;

/** Visibilidad saneada a [0,1] (NaN/undefined → 0). */
export const cleanVis = (v: number | undefined): number =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : 0;

/** smoothstep de borde inclusivo (e0 < e1). */
export const sstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Mediana (no muta la entrada). Devuelve NaN si el array está vacío. */
export function median(values: readonly number[]): number {
  const n = values.length;
  if (n === 0) return NaN;
  const s = Array.from(values).sort((a, b) => a - b);
  const m = n >> 1;
  return n % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Media ponderada; 0 si la suma de pesos es 0. */
export function weightedMean(values: readonly number[], weights: readonly number[]): number {
  let sw = 0;
  let s = 0;
  for (let i = 0; i < values.length; i++) {
    const w = weights[i]!;
    sw += w;
    s += w * values[i]!;
  }
  return sw > 0 ? s / sw : 0;
}

/**
 * Cuaternión a partir de una base ortonormal DERECHA (columnas x, y, z de la matriz de rotación).
 * La rotación resultante lleva (1,0,0)→x, (0,1,0)→y, (0,0,1)→z.
 */
export function quatFromBasis(x: Vec3, y: Vec3, z: Vec3): Quat {
  const m00 = x[0],
    m10 = x[1],
    m20 = x[2];
  const m01 = y[0],
    m11 = y[1],
    m21 = y[2];
  const m02 = z[0],
    m12 = z[1],
    m22 = z[2];
  const tr = m00 + m11 + m22;
  let out: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    out = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    out = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    out = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    out = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  return q.normalize(out);
}

/**
 * Base ortonormal derecha con eje X exactamente `x` y eje Y lo más cercano posible a `up`.
 * Si `up` es (casi) paralelo a `x` se usa `fallbackUp`; si también lo es, un eje cualquiera.
 * Devuelve las tres columnas [x, y, z] con z = x × y.
 */
export function basisFromXUp(
  x: Vec3,
  up: Vec3,
  fallbackUp: Vec3 = AXIS_Y,
): readonly [Vec3, Vec3, Vec3] {
  const xn = v3.normalize(x, AXIS_X);
  let y = v3.sub(up, v3.scale(xn, v3.dot(up, xn)));
  if (!(v3.length(y) > 1e-6)) {
    y = v3.sub(fallbackUp, v3.scale(xn, v3.dot(fallbackUp, xn)));
    if (!(v3.length(y) > 1e-6)) {
      const helper: Vec3 = Math.abs(xn[1]) < 0.9 ? AXIS_Y : AXIS_Z;
      y = v3.sub(helper, v3.scale(xn, v3.dot(helper, xn)));
    }
  }
  const yn = v3.normalize(y, AXIS_Y);
  const zn = v3.cross(xn, yn);
  return [xn, yn, zn];
}

/** Base derecha con eje Z = `fwd` exacto y eje X lo más cercano posible a `xHint`. */
export function basisFromZX(
  fwd: Vec3,
  xHint: Vec3,
  fallbackX: Vec3 = AXIS_X,
): readonly [Vec3, Vec3, Vec3] {
  const zn = v3.normalize(fwd, AXIS_Z);
  let x = v3.sub(xHint, v3.scale(zn, v3.dot(xHint, zn)));
  if (!(v3.length(x) > 1e-6)) {
    x = v3.sub(fallbackX, v3.scale(zn, v3.dot(fallbackX, zn)));
    if (!(v3.length(x) > 1e-6)) {
      const helper: Vec3 = Math.abs(zn[0]) < 0.9 ? AXIS_X : AXIS_Y;
      x = v3.sub(helper, v3.scale(zn, v3.dot(helper, zn)));
    }
  }
  const xn = v3.normalize(x, AXIS_X);
  const yn = v3.cross(zn, xn);
  return [xn, yn, zn];
}

/**
 * Base derecha con eje Y exactamente `up` y eje X lo más cercano posible a `xHint`
 * (la componente de `xHint` a lo largo de `up` se descarta).
 */
export function basisFromYX(
  up: Vec3,
  xHint: Vec3,
  fallbackX: Vec3 = AXIS_X,
): readonly [Vec3, Vec3, Vec3] {
  const yn = v3.normalize(up, AXIS_Y);
  let x = v3.sub(xHint, v3.scale(yn, v3.dot(xHint, yn)));
  if (!(v3.length(x) > 1e-6)) {
    x = v3.sub(fallbackX, v3.scale(yn, v3.dot(fallbackX, yn)));
    if (!(v3.length(x) > 1e-6)) {
      const helper: Vec3 = Math.abs(yn[0]) < 0.9 ? AXIS_X : AXIS_Z;
      x = v3.sub(helper, v3.scale(yn, v3.dot(helper, yn)));
    }
  }
  const xn = v3.normalize(x, AXIS_X);
  const zn = v3.cross(xn, yn);
  return [xn, yn, zn];
}

/** Rotación de la base `basisFromYX(up, xHint)`. */
export const frameFromYX = (up: Vec3, xHint: Vec3, fallbackX: Vec3 = AXIS_X): Quat => {
  const [bx, by, bz] = basisFromYX(up, xHint, fallbackX);
  return quatFromBasis(bx, by, bz);
};

/** Rotación (cuaternión) de la base `basisFromXUp(x, up)`. */
export const frameFromXUp = (x: Vec3, up: Vec3, fallbackUp: Vec3 = AXIS_Y): Quat => {
  const [bx, by, bz] = basisFromXUp(x, up, fallbackUp);
  return quatFromBasis(bx, by, bz);
};

/** Rotación de la base `basisFromZX(fwd, xHint)`. */
export const frameFromZX = (fwd: Vec3, xHint: Vec3, fallbackX: Vec3 = AXIS_X): Quat => {
  const [bx, by, bz] = basisFromZX(fwd, xHint, fallbackX);
  return quatFromBasis(bx, by, bz);
};

/** Cuaternión inverso (para unitarios, el conjugado). */
export const qInv = (a: Quat): Quat => q.conjugate(a);

/** a⁻¹ · b: rotación local de `b` respecto al marco `a`. */
export const qRelative = (a: Quat, b: Quat): Quat => q.normalize(q.multiply(q.conjugate(a), b));

/** Cuaternión unitario y finito siempre (si no, identidad). */
export function sanitizeQuat(a: Quat): Quat {
  if (!q.isFinite(a)) return QUAT_IDENTITY;
  return q.normalize(a);
}

/** Ángulo (rad, [0, π]) de la rotación del cuaternión unitario. */
export function quatAngle(a: Quat): number {
  return 2 * Math.acos(clamp(Math.abs(a[3]), 0, 1));
}

/** Escala el ángulo de una rotación (slerp desde la identidad) — t en [0, 1]. */
export const qScale = (a: Quat, t: number): Quat => q.slerp(QUAT_IDENTITY, a, t);

/**
 * Limita el ángulo total de la rotación a `maxAngle` (rad) conservando el eje.
 * Devuelve la misma rotación si ya está dentro del límite.
 */
export function clampAngle(a: Quat, maxAngle: number): Quat {
  const ang = quatAngle(a);
  if (!(ang > maxAngle)) return a;
  return qScale(a, maxAngle / ang);
}

/**
 * Descompone `a` en swing·twist respecto al eje unitario `axis` (en el marco de `a`):
 * a = swing ⊗ twist, con twist una rotación pura alrededor de `axis`.
 * Devuelve el ángulo de torsión con signo en (−π, π].
 */
export function twistAngleAbout(a: Quat, axis: Vec3): number {
  const proj = a[0] * axis[0] + a[1] * axis[1] + a[2] * axis[2];
  let ang = 2 * Math.atan2(proj, a[3]);
  if (ang > Math.PI) ang -= 2 * Math.PI;
  if (ang < -Math.PI) ang += 2 * Math.PI;
  return ang;
}

/** Matriz 3x3 (filas) a partir de un cuaternión unitario; sólo para depuración/tests. */
export function quatToMatrix(a: Quat): readonly [Vec3, Vec3, Vec3] {
  const x = q.rotate(a, AXIS_X);
  const y = q.rotate(a, AXIS_Y);
  const z = q.rotate(a, AXIS_Z);
  return [x, y, z];
}

/** Xorshift32/mulberry32 determinista. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash entero de 32 bits para combinar semilla + índice de fotograma (determinismo por marca de tiempo). */
export function hash32(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Gaussiana N(0,1) por Box-Muller a partir de un generador uniforme. */
export function gaussian(rand: () => number): number {
  let u = 0;
  while (u < 1e-12) u = rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
