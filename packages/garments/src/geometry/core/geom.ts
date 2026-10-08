/** Geometría de bajo nivel (sin asignaciones en los bucles calientes). */

/**
 * Punto más cercano de un triángulo a `p` (Ericson, RTCD 5.1.5).
 * Escribe en `out`: [qx, qy, qz, u, v, w] (baricéntricas de a, b, c). Devuelve la distancia al cuadrado.
 */
export function closestPointTriangle(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  out: Float64Array,
): number {
  const abx = bx - ax,
    aby = by - ay,
    abz = bz - az;
  const acx = cx - ax,
    acy = cy - ay,
    acz = cz - az;
  const apx = px - ax,
    apy = py - ay,
    apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let u: number, v: number, w: number;
  if (d1 <= 0 && d2 <= 0) {
    u = 1;
    v = 0;
    w = 0;
  } else {
    const bpx = px - bx,
      bpy = py - by,
      bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) {
      u = 0;
      v = 1;
      w = 0;
    } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const t = d1 / (d1 - d3);
        u = 1 - t;
        v = t;
        w = 0;
      } else {
        const cpx = px - cx,
          cpy = py - cy,
          cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) {
          u = 0;
          v = 0;
          w = 1;
        } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const t = d2 / (d2 - d6);
            u = 1 - t;
            v = 0;
            w = t;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
              u = 0;
              v = 1 - t;
              w = t;
            } else {
              const denom = 1 / (va + vb + vc);
              v = vb * denom;
              w = vc * denom;
              u = 1 - v - w;
            }
          }
        }
      }
    }
  }
  const qx = u * ax + v * bx + w * cx;
  const qy = u * ay + v * by + w * cy;
  const qz = u * az + v * bz + w * cz;
  out[0] = qx;
  out[1] = qy;
  out[2] = qz;
  out[3] = u;
  out[4] = v;
  out[5] = w;
  const dx = px - qx,
    dy = py - qy,
    dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smooth01 = (x: number): number => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
export const smoother01 = (x: number): number => {
  const t = clamp01(x);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clampN = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** Perímetro (polilínea cerrada) de puntos 3D almacenados como xyz consecutivos. */
export function closedLength(p: ArrayLike<number>, offset: number, count: number): number {
  let len = 0;
  for (let i = 0; i < count; i++) {
    const a = offset + i * 3;
    const b = offset + ((i + 1) % count) * 3;
    len += Math.hypot(p[a]! - p[b]!, p[a + 1]! - p[b + 1]!, p[a + 2]! - p[b + 2]!);
  }
  return len;
}
