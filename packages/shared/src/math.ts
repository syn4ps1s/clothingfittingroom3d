/**
 * Matemática mínima, pura y sin dependencias (sin three.js, sin DOM).
 * Convención global del proyecto:
 *  - Unidades SI: metros, kilogramos, radianes.
 *  - Mano derecha, +Y arriba, +Z hacia donde MIRA el cuerpo (hacia la cámara cuando
 *    el usuario mira a la cámara), +X = lado IZQUIERDO de la persona
 *    (coincide con la derecha de la imagen NO espejada de la cámara).
 *  - Cuaterniones [x, y, z, w].
 */
export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

export const QUAT_IDENTITY: Quat = [0, 0, 0, 1];
export const ZERO3: Vec3 = [0, 0, 0];

export const cmToM = (cm: number): number => cm / 100;
export const mToCm = (m: number): number => m * 100;
export const degToRad = (d: number): number => (d * Math.PI) / 180;
export const radToDeg = (r: number): number => (r * 180) / Math.PI;
export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

export const v3 = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  length: (a: Vec3): number => Math.hypot(a[0], a[1], a[2]),
  distance: (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  lerp: (a: Vec3, b: Vec3, t: number): Vec3 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ],
  /** Normaliza; devuelve `fallback` si la longitud es ~0 o no finita (nunca NaN). */
  normalize: (a: Vec3, fallback: Vec3 = [0, 1, 0]): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l > 1e-12 && Number.isFinite(l) ? [a[0] / l, a[1] / l, a[2] / l] : fallback;
  },
  isFinite: (a: Vec3): boolean =>
    Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]),
};

export const q = {
  multiply: (a: Quat, b: Quat): Quat => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ],
  conjugate: (a: Quat): Quat => [-a[0], -a[1], -a[2], a[3]],
  normalize: (a: Quat): Quat => {
    const l = Math.hypot(a[0], a[1], a[2], a[3]);
    return l > 1e-12 && Number.isFinite(l)
      ? [a[0] / l, a[1] / l, a[2] / l, a[3] / l]
      : QUAT_IDENTITY;
  },
  fromAxisAngle: (axis: Vec3, angle: number): Quat => {
    const n = v3.normalize(axis);
    const s = Math.sin(angle / 2);
    return [n[0] * s, n[1] * s, n[2] * s, Math.cos(angle / 2)];
  },
  /** Rotación mínima (swing) que lleva el vector unitario `from` sobre `to`. */
  fromUnitVectors: (from: Vec3, to: Vec3): Quat => {
    const d = v3.dot(from, to);
    if (d > 1 - 1e-9) return QUAT_IDENTITY;
    if (d < -1 + 1e-9) {
      // 180°: elegir un eje perpendicular estable
      const helper: Vec3 = Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      return q.fromAxisAngle(v3.cross(from, helper), Math.PI);
    }
    const c = v3.cross(from, to);
    return q.normalize([c[0], c[1], c[2], 1 + d]);
  },
  rotate: (r: Quat, v: Vec3): Vec3 => {
    // v' = v + 2w(u×v) + 2 u×(u×v)
    const u: Vec3 = [r[0], r[1], r[2]];
    const t = v3.scale(v3.cross(u, v), 2);
    return v3.add(v3.add(v, v3.scale(t, r[3])), v3.cross(u, t));
  },
  slerp: (a: Quat, b: Quat, t: number): Quat => {
    let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    let bx = b[0],
      by = b[1],
      bz = b[2],
      bw = b[3];
    if (cos < 0) {
      cos = -cos;
      bx = -bx;
      by = -by;
      bz = -bz;
      bw = -bw;
    }
    if (cos > 0.9995) {
      return q.normalize([
        a[0] + (bx - a[0]) * t,
        a[1] + (by - a[1]) * t,
        a[2] + (bz - a[2]) * t,
        a[3] + (bw - a[3]) * t,
      ]);
    }
    const theta = Math.acos(clamp(cos, -1, 1));
    const sin = Math.sin(theta);
    const wa = Math.sin((1 - t) * theta) / sin;
    const wb = Math.sin(t * theta) / sin;
    return [wa * a[0] + wb * bx, wa * a[1] + wb * by, wa * a[2] + wb * bz, wa * a[3] + wb * bw];
  },
  isFinite: (a: Quat): boolean =>
    Number.isFinite(a[0]) &&
    Number.isFinite(a[1]) &&
    Number.isFinite(a[2]) &&
    Number.isFinite(a[3]),
  /** Ángulo (rad) de la rotación entre a y b. */
  angleBetween: (a: Quat, b: Quat): number => {
    const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
    return 2 * Math.acos(clamp(d, 0, 1));
  },
};
