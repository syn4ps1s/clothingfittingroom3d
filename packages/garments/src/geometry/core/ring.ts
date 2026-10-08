import { rayExit, type BodyField } from './bodyField.js';

/**
 * Anillos (contornos cerrados en un plano) alrededor de un eje: la base de todas las prendas tubulares.
 * Un anillo son K puntos con ángulo polar uniforme θ_i = 2π·i/K en el plano (u,v) alrededor de un centro.
 */
export interface RingFrame {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  /** direcciones unitarias del plano: θ=0 → u, θ=π/2 → v */
  readonly ux: number;
  readonly uy: number;
  readonly uz: number;
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
}

export const makeFrame = (
  c: readonly [number, number, number],
  u: readonly [number, number, number],
  v: readonly [number, number, number],
): RingFrame => ({
  cx: c[0],
  cy: c[1],
  cz: c[2],
  ux: u[0],
  uy: u[1],
  uz: u[2],
  vx: v[0],
  vy: v[1],
  vz: v[2],
});

/** Radios del cuerpo (primer cruce dentro→fuera) en K direcciones; los fallos se rellenan por vecinos. */
export function bodyRadii(
  field: BodyField,
  fr: RingFrame,
  K: number,
  rmax: number,
  rmin: number,
  out: Float64Array = new Float64Array(K),
): Float64Array {
  let anyOk = false;
  for (let i = 0; i < K; i++) {
    const th = (2 * Math.PI * i) / K;
    const c = Math.cos(th),
      s = Math.sin(th);
    const t = rayExit(
      field.sdf,
      fr.cx,
      fr.cy,
      fr.cz,
      c * fr.ux + s * fr.vx,
      c * fr.uy + s * fr.vy,
      c * fr.uz + s * fr.vz,
      rmax,
    );
    if (Number.isNaN(t)) out[i] = Number.NaN;
    else {
      out[i] = Math.min(Math.max(t, rmin), rmax);
      anyOk = true;
    }
  }
  if (!anyOk) {
    out.fill(rmin);
    return out;
  }
  // rellena huecos con interpolación circular
  for (let i = 0; i < K; i++) {
    if (!Number.isNaN(out[i]!)) continue;
    let a = 1;
    while (Number.isNaN(out[(i - a + K) % K]!)) a++;
    let b = 1;
    while (Number.isNaN(out[(i + b) % K]!)) b++;
    const ra = out[(i - a + K) % K]!,
      rb = out[(i + b) % K]!;
    out[i] = ra + ((rb - ra) * a) / (a + b);
  }
  return out;
}

/** Suavizado circular (3 puntos) de radios. */
export function smoothCircular(r: Float64Array, iterations = 1, w = 0.25): Float64Array {
  const K = r.length;
  const tmp = new Float64Array(K);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < K; i++) {
      tmp[i] = r[i]! * (1 - 2 * w) + w * (r[(i + K - 1) % K]! + r[(i + 1) % K]!);
    }
    r.set(tmp);
  }
  return r;
}

/** Convierte radios polares en puntos 2D (a lo largo de u, v). */
export function radiiToPoints(r: ArrayLike<number>, out?: Float64Array): Float64Array {
  const K = r.length;
  const p = out ?? new Float64Array(K * 2);
  for (let i = 0; i < K; i++) {
    const th = (2 * Math.PI * i) / K;
    p[i * 2] = r[i]! * Math.cos(th);
    p[i * 2 + 1] = r[i]! * Math.sin(th);
  }
  return p;
}

/** Envolvente convexa (cadena monótona) de puntos 2D intercalados; devuelve índices de vértices en CCW. */
export function convexHull2D(p: ArrayLike<number>): number[] {
  const n = p.length / 2;
  const idx = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => p[a * 2]! - p[b * 2]! || p[a * 2 + 1]! - p[b * 2 + 1]!,
  );
  const cross = (o: number, a: number, b: number): number =>
    (p[a * 2]! - p[o * 2]!) * (p[b * 2 + 1]! - p[o * 2 + 1]!) -
    (p[a * 2 + 1]! - p[o * 2 + 1]!) * (p[b * 2]! - p[o * 2]!);
  const lower: number[] = [];
  for (const i of idx) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, i) <= 0)
      lower.pop();
    lower.push(i);
  }
  const upper: number[] = [];
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, i) <= 0)
      upper.pop();
    upper.push(i);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Radios (a K ángulos uniformes) de la envolvente convexa de unos puntos 2D, medidos desde el origen. */
export function hullRadii(p: ArrayLike<number>, K: number, out = new Float64Array(K)): Float64Array {
  const hull = convexHull2D(p);
  const m = hull.length;
  for (let i = 0; i < K; i++) {
    const th = (2 * Math.PI * i) / K;
    const dx = Math.cos(th),
      dy = Math.sin(th);
    let best = 0;
    for (let e = 0; e < m; e++) {
      const a = hull[e]!,
        b = hull[(e + 1) % m]!;
      const ax = p[a * 2]!,
        ay = p[a * 2 + 1]!,
        bx = p[b * 2]!,
        by = p[b * 2 + 1]!;
      // intersección rayo (0,0)+t(dx,dy) con segmento a-b
      const ex = bx - ax,
        ey = by - ay;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-14) continue;
      const t = (ax * ey - ay * ex) / den;
      const s = (ax * dy - ay * dx) / den;
      if (t > 0 && s >= -1e-9 && s <= 1 + 1e-9 && t > best) best = t;
    }
    out[i] = best;
  }
  return out;
}

export function perimeter2D(p: ArrayLike<number>): number {
  const K = p.length / 2;
  let len = 0;
  for (let i = 0; i < K; i++) {
    const j = (i + 1) % K;
    len += Math.hypot(p[j * 2]! - p[i * 2]!, p[j * 2 + 1]! - p[i * 2 + 1]!);
  }
  return len;
}

/**
 * Desplaza cada punto del contorno (CCW) `e` metros a lo largo de su normal exterior suave.
 * `eVar` opcional: e por punto (campo de holgura variable). El perímetro cambia ≈ 2π·e (contorno convexo).
 */
export function offsetContour(
  p: ArrayLike<number>,
  e: number,
  out: Float64Array,
  eVar?: ArrayLike<number>,
): Float64Array {
  const K = p.length / 2;
  for (let i = 0; i < K; i++) {
    const a = (i + K - 1) % K,
      b = (i + 1) % K;
    let tx = p[b * 2]! - p[a * 2]!,
      ty = p[b * 2 + 1]! - p[a * 2 + 1]!;
    const l = Math.hypot(tx, ty) || 1;
    tx /= l;
    ty /= l;
    const ee = e + (eVar ? eVar[i]! : 0);
    out[i * 2] = p[i * 2]! + ty * ee;
    out[i * 2 + 1] = p[i * 2 + 1]! - tx * ee;
  }
  return out;
}

/** Desplazamiento uniforme que lleva el perímetro del contorno exactamente a `target` (iteración secante). */
export function solveOffsetForPerimeter(
  p: ArrayLike<number>,
  target: number,
  tmp: Float64Array,
  eVar?: ArrayLike<number>,
): number {
  const P0 = perimeter2D(p);
  let e = (target - P0) / (2 * Math.PI);
  // limita retrocesos grandes: un offset negativo mayor que el radio de curvatura invierte el contorno
  for (let it = 0; it < 4; it++) {
    offsetContour(p, e, tmp, eVar);
    const P = perimeter2D(tmp);
    const err = target - P;
    if (Math.abs(err) < 5e-5) break;
    e += err / (2 * Math.PI);
  }
  return e;
}

/** Radio efectivo (circular) de un perímetro. */
export const circleRadius = (perimeter: number): number => perimeter / (2 * Math.PI);

// ---------------------------------------------------------------------------------------------
// Variantes con ángulos arbitrarios (no uniformes): anillos de manga/pernera cuya numeración debe
// coincidir con un lazo ya existente (p. ej. la sisa del torso).
// ---------------------------------------------------------------------------------------------

/** Radios del cuerpo en una lista de ángulos (primer cruce dentro→fuera). Los fallos se interpolan por vecinos. */
export function bodyRadiiAt(
  field: BodyField,
  fr: RingFrame,
  angles: ArrayLike<number>,
  rmax: number,
  rmin: number,
  out: Float64Array = new Float64Array(angles.length),
): Float64Array {
  const K = angles.length;
  let anyOk = false;
  for (let i = 0; i < K; i++) {
    const c = Math.cos(angles[i]!),
      s = Math.sin(angles[i]!);
    const t = rayExit(
      field.sdf,
      fr.cx,
      fr.cy,
      fr.cz,
      c * fr.ux + s * fr.vx,
      c * fr.uy + s * fr.vy,
      c * fr.uz + s * fr.vz,
      rmax,
    );
    if (Number.isNaN(t)) out[i] = Number.NaN;
    else {
      out[i] = Math.min(Math.max(t, rmin), rmax);
      anyOk = true;
    }
  }
  if (!anyOk) {
    out.fill(rmin);
    return out;
  }
  for (let i = 0; i < K; i++) {
    if (!Number.isNaN(out[i]!)) continue;
    let a = 1;
    while (Number.isNaN(out[(i - a + K) % K]!)) a++;
    let b = 1;
    while (Number.isNaN(out[(i + b) % K]!)) b++;
    const ra = out[(i - a + K) % K]!,
      rb = out[(i + b) % K]!;
    out[i] = ra + ((rb - ra) * a) / (a + b);
  }
  return out;
}

/** Puntos 2D a partir de radios y ángulos arbitrarios. */
export function polarToPoints(r: ArrayLike<number>, angles: ArrayLike<number>, out?: Float64Array): Float64Array {
  const K = r.length;
  const p = out ?? new Float64Array(K * 2);
  for (let i = 0; i < K; i++) {
    p[i * 2] = r[i]! * Math.cos(angles[i]!);
    p[i * 2 + 1] = r[i]! * Math.sin(angles[i]!);
  }
  return p;
}

/** Radios de la envolvente convexa de unos puntos 2D en ángulos arbitrarios. */
export function hullRadiiAt(
  p: ArrayLike<number>,
  angles: ArrayLike<number>,
  out = new Float64Array(angles.length),
): Float64Array {
  const hull = convexHull2D(p);
  const m = hull.length;
  for (let i = 0; i < angles.length; i++) {
    const dx = Math.cos(angles[i]!),
      dy = Math.sin(angles[i]!);
    let best = 0;
    for (let e = 0; e < m; e++) {
      const a = hull[e]!,
        b = hull[(e + 1) % m]!;
      const ax = p[a * 2]!,
        ay = p[a * 2 + 1]!,
        bx = p[b * 2]!,
        by = p[b * 2 + 1]!;
      const ex = bx - ax,
        ey = by - ay;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-14) continue;
      const t = (ax * ey - ay * ex) / den;
      const s = (ax * dy - ay * dx) / den;
      if (t > 0 && s >= -1e-9 && s <= 1 + 1e-9 && t > best) best = t;
    }
    out[i] = best;
  }
  return out;
}
