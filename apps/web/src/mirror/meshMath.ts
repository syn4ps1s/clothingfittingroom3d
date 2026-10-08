/**
 * Cálculos de malla para el bucle caliente (sin asignaciones, sin `hypot`, sin iteradores).
 */

/**
 * Normales suaves por vértice (promedio ponderado por área) escritas en `out`.
 * Equivale a `computeVertexNormals` de @fitroom/shared pero sin crear un array por triángulo
 * (esa versión asigna 1 array por triángulo: inviable a 60 Hz con ~100 k triángulos).
 */
export function computeNormalsInto(
  positions: Float32Array,
  indices: Uint32Array,
  out: Float32Array,
): void {
  out.fill(0);
  const nt = indices.length;
  for (let t = 0; t < nt; t += 3) {
    const ia = indices[t]! * 3;
    const ib = indices[t + 1]! * 3;
    const ic = indices[t + 2]! * 3;
    const ax = positions[ia]!;
    const ay = positions[ia + 1]!;
    const az = positions[ia + 2]!;
    const e1x = positions[ib]! - ax;
    const e1y = positions[ib + 1]! - ay;
    const e1z = positions[ib + 2]! - az;
    const e2x = positions[ic]! - ax;
    const e2y = positions[ic + 1]! - ay;
    const e2z = positions[ic + 2]! - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    out[ia] = out[ia]! + nx;
    out[ia + 1] = out[ia + 1]! + ny;
    out[ia + 2] = out[ia + 2]! + nz;
    out[ib] = out[ib]! + nx;
    out[ib + 1] = out[ib + 1]! + ny;
    out[ib + 2] = out[ib + 2]! + nz;
    out[ic] = out[ic]! + nx;
    out[ic + 1] = out[ic + 1]! + ny;
    out[ic + 2] = out[ic + 2]! + nz;
  }
  const n = out.length;
  for (let i = 0; i < n; i += 3) {
    const x = out[i]!;
    const y = out[i + 1]!;
    const z = out[i + 2]!;
    const l2 = x * x + y * y + z * z;
    if (l2 > 1e-24 && Number.isFinite(l2)) {
      const inv = 1 / Math.sqrt(l2);
      out[i] = x * inv;
      out[i + 1] = y * inv;
      out[i + 2] = z * inv;
    } else {
      out[i] = 0;
      out[i + 1] = 1;
      out[i + 2] = 0;
    }
  }
}

/** `dst[i] += normal[i] * amount` (desplazamiento de capa a lo largo de la normal). */
export function offsetAlongNormals(
  positions: Float32Array,
  normals: Float32Array,
  amount: number,
): void {
  if (amount === 0) return;
  const n = positions.length;
  for (let i = 0; i < n; i++) positions[i] = positions[i]! + normals[i]! * amount;
}

/** Sustituye NaN/Inf por el valor de respaldo (la tela inestable no debe llegar a la GPU). Devuelve nº de valores reparados. */
export function sanitizePositions(positions: Float32Array, fallback: Float32Array): number {
  let bad = 0;
  const n = positions.length;
  for (let i = 0; i < n; i++) {
    const v = positions[i]!;
    if (!Number.isFinite(v) || v > 1e4 || v < -1e4) {
      positions[i] = fallback[i]!;
      bad++;
    }
  }
  return bad;
}
