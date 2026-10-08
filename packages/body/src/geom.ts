/**
 * Utilidades geométricas puras y sin asignaciones en los caminos calientes.
 * Unidades SI (metros) salvo que se indique lo contrario.
 */

export const BIG = 1e3;

/** Unión suave polinómica cuadrática (C1). Conmutativa. Con |a-b| >= k es exactamente min(a, b). */
export function smin(a: number, b: number, k: number): number {
  const d = a > b ? a - b : b - a;
  if (d >= k) return a < b ? a : b;
  const h = (k - d) / k;
  return (a < b ? a : b) - h * h * k * 0.25;
}

/** Intersección suave (dual de smin). */
export function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export function clampN(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Interpolador cúbico de Hermite monótono (Fritsch–Carlson / PCHIP): sin sobreoscilaciones entre nudos,
 * ideal para perfiles de radio. `xs` estrictamente creciente.
 */
export function pchip(xs: readonly number[], ys: readonly number[]): (x: number) => number {
  const n = xs.length;
  if (n === 1) return () => ys[0]!;
  const h: number[] = [];
  const delta: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1]! - xs[i]!);
    delta.push((ys[i + 1]! - ys[i]!) / h[i]!);
  }
  const m: number[] = new Array<number>(n).fill(0);
  if (n === 2) {
    m[0] = delta[0]!;
    m[1] = delta[0]!;
  } else {
    for (let i = 1; i < n - 1; i++) {
      if (delta[i - 1]! * delta[i]! > 0) {
        const w1 = 2 * h[i]! + h[i - 1]!;
        const w2 = h[i]! + 2 * h[i - 1]!;
        m[i] = (w1 + w2) / (w1 / delta[i - 1]! + w2 / delta[i]!);
      }
    }
    m[0] = endSlope(h[0]!, h[1]!, delta[0]!, delta[1]!);
    m[n - 1] = endSlope(h[n - 2]!, h[n - 3]!, delta[n - 2]!, delta[n - 3]!);
  }
  return (x: number): number => {
    if (x <= xs[0]!) return ys[0]!;
    if (x >= xs[n - 1]!) return ys[n - 1]!;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid]! <= x) lo = mid;
      else hi = mid;
    }
    const hh = h[lo]!;
    const t = (x - xs[lo]!) / hh;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[lo]! +
      (t3 - 2 * t2 + t) * hh * m[lo]! +
      (-2 * t3 + 3 * t2) * ys[lo + 1]! +
      (t3 - t2) * hh * m[lo + 1]!
    );
  };
}

function endSlope(h0: number, h1: number, d0: number, d1: number): number {
  let s = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
  if (Math.sign(s) !== Math.sign(d0)) s = 0;
  else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(s) > 3 * Math.abs(d0)) s = 3 * d0;
  return s;
}

/** Muestrea `f` en `n` puntos uniformes de [0, 1] a un Float64Array. */
export function sampleTable(f: (t: number) => number, n: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = f(i / (n - 1));
  return out;
}

/** Perímetro de una elipse de semiejes a, b (aproximación de Ramanujan II, error < 1e-4 relativo). */
export function ellipsePerimeter(a: number, b: number): number {
  const h = ((a - b) * (a - b)) / ((a + b) * (a + b));
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

/**
 * Perímetro de una superelipse asimétrica |x/a|^n + |z/b|^n = 1 con semieje delantero bF (z>0) y trasero bB (z<0).
 * Integración poligonal con 720 muestras.
 */
export function superEllipsePerimeter(
  a: number,
  bF: number,
  bB: number,
  n: number,
  samples = 720,
): number {
  let prevX = a;
  let prevZ = 0;
  const x0 = a;
  let sum = 0;
  for (let i = 1; i <= samples; i++) {
    const th = (i / samples) * Math.PI * 2;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const b = s >= 0 ? bF : bB;
    const r = Math.pow(Math.pow(Math.abs(c) / a, n) + Math.pow(Math.abs(s) / b, n), -1 / n);
    const x = r * c;
    const z = r * s;
    sum += Math.hypot(x - prevX, z - prevZ);
    prevX = x;
    prevZ = z;
  }
  sum += Math.hypot(x0 - prevX, 0 - prevZ);
  return sum;
}
