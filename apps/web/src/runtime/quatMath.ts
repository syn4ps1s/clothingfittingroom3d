/**
 * Utilidades de cuaterniones "en sitio" sobre arrays planos [x,y,z,w] (sin asignaciones por llamada).
 * Se usan en el bucle de 60 Hz (predicción/interpolación de pose), donde `q.slerp` de @fitroom/shared
 * crearía un array por articulación y fotograma.
 */
type NumArray = ArrayLike<number>;
type MutNumArray = { [i: number]: number };

/**
 * slerp(a, b, t) → out, admitiendo t fuera de [0,1] (extrapolación). Siempre por el arco corto.
 * `out` puede aliasar a `a` o `b`. Resultado normalizado y finito (identidad si la entrada es degenerada).
 */
export function slerpInto(
  out: MutNumArray,
  oi: number,
  a: NumArray,
  ai: number,
  b: NumArray,
  bi: number,
  t: number,
): void {
  const ax = a[ai]!,
    ay = a[ai + 1]!,
    az = a[ai + 2]!,
    aw = a[ai + 3]!;
  let bx = b[bi]!,
    by = b[bi + 1]!,
    bz = b[bi + 2]!,
    bw = b[bi + 3]!;
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let wa: number;
  let wb: number;
  if (cos > 0.9995) {
    wa = 1 - t;
    wb = t;
  } else {
    const theta = Math.acos(cos > 1 ? 1 : cos);
    const sin = Math.sin(theta);
    wa = Math.sin((1 - t) * theta) / sin;
    wb = Math.sin(t * theta) / sin;
  }
  let x = wa * ax + wb * bx;
  let y = wa * ay + wb * by;
  let z = wa * az + wb * bz;
  let w = wa * aw + wb * bw;
  const l = Math.sqrt(x * x + y * y + z * z + w * w);
  if (l > 1e-12 && Number.isFinite(l)) {
    const inv = 1 / l;
    x *= inv;
    y *= inv;
    z *= inv;
    w *= inv;
  } else {
    x = 0;
    y = 0;
    z = 0;
    w = 1;
  }
  out[oi] = x;
  out[oi + 1] = y;
  out[oi + 2] = z;
  out[oi + 3] = w;
}

/** Ángulo (rad) entre dos cuaterniones. */
export function angleBetweenAt(a: NumArray, ai: number, b: NumArray, bi: number): number {
  const d = Math.abs(
    a[ai]! * b[bi]! + a[ai + 1]! * b[bi + 1]! + a[ai + 2]! * b[bi + 2]! + a[ai + 3]! * b[bi + 3]!,
  );
  return 2 * Math.acos(d > 1 ? 1 : d);
}

/** Copia un cuaternión de `src` (normalizando; identidad si es inválido). */
export function setQuatNormalized(out: MutNumArray, oi: number, src: NumArray, si: number): void {
  const x = src[si]!,
    y = src[si + 1]!,
    z = src[si + 2]!,
    w = src[si + 3]!;
  const l = Math.sqrt(x * x + y * y + z * z + w * w);
  if (l > 1e-12 && Number.isFinite(l)) {
    out[oi] = x / l;
    out[oi + 1] = y / l;
    out[oi + 2] = z / l;
    out[oi + 3] = w / l;
  } else {
    out[oi] = 0;
    out[oi + 1] = 0;
    out[oi + 2] = 0;
    out[oi + 3] = 1;
  }
}
