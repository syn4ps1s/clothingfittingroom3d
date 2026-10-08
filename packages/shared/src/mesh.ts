/**
 * Mallas como arrays tipados planos: portables entre Node (tests), workers y three.js
 * (se convierten a BufferGeometry sin copias en la capa web).
 */
export interface MeshData {
  /** xyz por vértice (m) */
  readonly positions: Float32Array;
  /** xyz por vértice, unitarias */
  readonly normals: Float32Array;
  /** uv por vértice (opcional para el cuerpo; obligatorio para prendas) */
  readonly uvs?: Float32Array;
  /** triángulos CCW visto desde fuera */
  readonly indices: Uint32Array;
}

/** Skinning de hasta 4 influencias por vértice. */
export interface SkinnedMeshData extends MeshData {
  /** 4 índices de joint por vértice (se rellenan con 0 cuando el peso es 0) */
  readonly skinIndices: Uint16Array;
  /** 4 pesos por vértice, suman 1 */
  readonly skinWeights: Float32Array;
}

export const vertexCount = (m: MeshData): number => m.positions.length / 3;
export const triangleCount = (m: MeshData): number => m.indices.length / 3;

export interface MeshIssue {
  readonly code:
    | 'non-finite'
    | 'index-out-of-range'
    | 'degenerate-triangle'
    | 'bad-normal'
    | 'bad-skin-weights'
    | 'bad-skin-index'
    | 'attribute-length-mismatch';
  readonly detail: string;
}

/**
 * Valida una malla. Devuelve la lista de problemas (vacía = válida).
 * Es la red de seguridad de TODAS las mallas generadas (cuerpo y prendas) y de las que cargue el usuario.
 */
export function validateMesh(m: MeshData | SkinnedMeshData, jointCount = 21): MeshIssue[] {
  const issues: MeshIssue[] = [];
  const n = vertexCount(m);
  if (!Number.isInteger(n)) {
    return [{ code: 'attribute-length-mismatch', detail: 'positions.length no es múltiplo de 3' }];
  }
  if (m.normals.length !== m.positions.length) {
    issues.push({ code: 'attribute-length-mismatch', detail: 'normals != positions' });
  }
  if (m.uvs && m.uvs.length !== n * 2) {
    issues.push({ code: 'attribute-length-mismatch', detail: 'uvs != 2*vertexCount' });
  }
  for (let i = 0; i < m.positions.length; i++) {
    if (!Number.isFinite(m.positions[i]!)) {
      issues.push({ code: 'non-finite', detail: `positions[${i}]` });
      break;
    }
  }
  if (m.indices.length % 3 !== 0) {
    issues.push({ code: 'index-out-of-range', detail: 'indices.length no es múltiplo de 3' });
  }
  let degenerate = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t]!,
      b = m.indices[t + 1]!,
      c = m.indices[t + 2]!;
    if (a >= n || b >= n || c >= n) {
      issues.push({ code: 'index-out-of-range', detail: `triángulo ${t / 3}` });
      break;
    }
    if (a === b || b === c || a === c) degenerate++;
  }
  if (degenerate > 0) {
    issues.push({
      code: 'degenerate-triangle',
      detail: `${degenerate} triángulos con índices repetidos`,
    });
  }
  if (m.normals.length === m.positions.length) {
    for (let i = 0; i < n; i++) {
      const l = Math.hypot(m.normals[i * 3]!, m.normals[i * 3 + 1]!, m.normals[i * 3 + 2]!);
      if (!(l > 0.99 && l < 1.01)) {
        issues.push({ code: 'bad-normal', detail: `vértice ${i} |n|=${l}` });
        break;
      }
    }
  }
  if ('skinIndices' in m) {
    if (m.skinIndices.length !== n * 4 || m.skinWeights.length !== n * 4) {
      issues.push({ code: 'attribute-length-mismatch', detail: 'skin attrs != 4*vertexCount' });
    } else {
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          const w = m.skinWeights[i * 4 + k]!;
          const ji = m.skinIndices[i * 4 + k]!;
          if (!(w >= 0) || !Number.isFinite(w)) {
            issues.push({ code: 'bad-skin-weights', detail: `vértice ${i}` });
            return issues;
          }
          if (ji >= jointCount) {
            issues.push({ code: 'bad-skin-index', detail: `vértice ${i}` });
            return issues;
          }
          sum += w;
        }
        if (Math.abs(sum - 1) > 1e-3) {
          issues.push({ code: 'bad-skin-weights', detail: `vértice ${i} suma=${sum}` });
          break;
        }
      }
    }
  }
  return issues;
}

/**
 * Normales suaves por vértice (promedio ponderado por área). Escribe en `out` si se da (sin asignaciones).
 */
export function computeVertexNormals(
  positions: Float32Array,
  indices: Uint32Array,
  out: Float32Array = new Float32Array(positions.length),
): Float32Array {
  out.fill(0);
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t]! * 3,
      ib = indices[t + 1]! * 3,
      ic = indices[t + 2]! * 3;
    const ax = positions[ia]!,
      ay = positions[ia + 1]!,
      az = positions[ia + 2]!;
    const e1x = positions[ib]! - ax,
      e1y = positions[ib + 1]! - ay,
      e1z = positions[ib + 2]! - az;
    const e2x = positions[ic]! - ax,
      e2y = positions[ic + 1]! - ay,
      e2z = positions[ic + 2]! - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const i of [ia, ib, ic]) {
      out[i] = out[i]! + nx;
      out[i + 1] = out[i + 1]! + ny;
      out[i + 2] = out[i + 2]! + nz;
    }
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i]!, out[i + 1]!, out[i + 2]!);
    if (l > 1e-20) {
      out[i] = out[i]! / l;
      out[i + 1] = out[i + 1]! / l;
      out[i + 2] = out[i + 2]! / l;
    } else {
      out[i] = 0;
      out[i + 1] = 1;
      out[i + 2] = 0;
    }
  }
  return out;
}

/**
 * Linear Blend Skinning en CPU. `skinMatrices` = salida de `computeSkinMatrices` (16 floats por joint).
 * Se usa en CPU (no GPU) porque la simulación de tela necesita las posiciones skinneadas.
 */
export function skinPositions(
  restPositions: Float32Array,
  skinIndices: Uint16Array,
  skinWeights: Float32Array,
  skinMatrices: Float32Array,
  out: Float32Array = new Float32Array(restPositions.length),
): Float32Array {
  const n = restPositions.length / 3;
  for (let i = 0; i < n; i++) {
    const px = restPositions[i * 3]!,
      py = restPositions[i * 3 + 1]!,
      pz = restPositions[i * 3 + 2]!;
    let ox = 0,
      oy = 0,
      oz = 0;
    for (let k = 0; k < 4; k++) {
      const w = skinWeights[i * 4 + k]!;
      if (w === 0) continue;
      const m = skinIndices[i * 4 + k]! * 16;
      ox +=
        w *
        (skinMatrices[m]! * px +
          skinMatrices[m + 4]! * py +
          skinMatrices[m + 8]! * pz +
          skinMatrices[m + 12]!);
      oy +=
        w *
        (skinMatrices[m + 1]! * px +
          skinMatrices[m + 5]! * py +
          skinMatrices[m + 9]! * pz +
          skinMatrices[m + 13]!);
      oz +=
        w *
        (skinMatrices[m + 2]! * px +
          skinMatrices[m + 6]! * py +
          skinMatrices[m + 10]! * pz +
          skinMatrices[m + 14]!);
    }
    out[i * 3] = ox;
    out[i * 3 + 1] = oy;
    out[i * 3 + 2] = oz;
  }
  return out;
}

/** Caja envolvente [minX,minY,minZ,maxX,maxY,maxZ]. */
export function computeBounds(
  positions: Float32Array,
): [number, number, number, number, number, number] {
  let a = Infinity,
    b = Infinity,
    c = Infinity,
    d = -Infinity,
    e = -Infinity,
    f = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!,
      y = positions[i + 1]!,
      z = positions[i + 2]!;
    if (x < a) a = x;
    if (x > d) d = x;
    if (y < b) b = y;
    if (y > e) e = y;
    if (z < c) c = z;
    if (z > f) f = z;
  }
  return [a, b, c, d, e, f];
}
