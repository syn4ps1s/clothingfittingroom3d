import { JOINT_COUNT } from '@fitroom/shared';
import { nearestBodyVertices, type BodyField } from './bodyField.js';
import { type GarmentMesh } from './mesh.js';
import { type Adjacency } from './relax.js';

/**
 * Pesos de skinning por NODO copiados de los vértices del cuerpo más cercanos (ponderados por distancia)
 * y suavizados sobre la malla de la prenda para que en las articulaciones no haya saltos (4 influencias, suman 1).
 */
export function computeNodeSkin(
  f: BodyField,
  mesh: GarmentMesh,
  adj: Adjacency,
  smoothIterations = 3,
): { indices: Uint16Array; weights: Float32Array } {
  const n = mesh.nodeCount;
  const body = f.body.mesh;
  const dense = new Float32Array(n * JOINT_COUNT);
  const idx = new Int32Array(6);
  const d2 = new Float64Array(6);
  const P = mesh.pos.data;
  for (let i = 0; i < n; i++) {
    const c = nearestBodyVertices(f, P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!, 6, idx, d2);
    let wsum = 0;
    const tmpW: number[] = [];
    for (let q = 0; q < c; q++) {
      const w = 1 / (Math.sqrt(d2[q]!) + 0.008) ** 2;
      tmpW.push(w);
      wsum += w;
    }
    for (let q = 0; q < c; q++) {
      const bv = idx[q]!;
      const w = tmpW[q]! / wsum;
      for (let k = 0; k < 4; k++) {
        const bw = body.skinWeights[bv * 4 + k]!;
        if (bw > 0) {
          const j = body.skinIndices[bv * 4 + k]!;
          dense[i * JOINT_COUNT + j] = dense[i * JOINT_COUNT + j]! + w * bw;
        }
      }
    }
  }
  const tmp = new Float32Array(dense.length);
  for (let it = 0; it < smoothIterations; it++) {
    for (let i = 0; i < n; i++) {
      const s = adj.start[i]!,
        e = adj.start[i + 1]!;
      const deg = e - s;
      for (let j = 0; j < JOINT_COUNT; j++) {
        let acc = 0;
        for (let k = s; k < e; k++) acc += dense[adj.items[k]! * JOINT_COUNT + j]!;
        tmp[i * JOINT_COUNT + j] = deg > 0 ? 0.5 * dense[i * JOINT_COUNT + j]! + (0.5 * acc) / deg : dense[i * JOINT_COUNT + j]!;
      }
    }
    dense.set(tmp);
  }
  const indices = new Uint16Array(n * 4);
  const weights = new Float32Array(n * 4);
  const order = Array.from({ length: JOINT_COUNT }, (_, j) => j);
  for (let i = 0; i < n; i++) {
    order.sort((a, b) => dense[i * JOINT_COUNT + b]! - dense[i * JOINT_COUNT + a]!);
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += dense[i * JOINT_COUNT + order[k]!]!;
    if (sum < 1e-6) {
      indices[i * 4] = 0;
      weights[i * 4] = 1;
      continue;
    }
    for (let k = 0; k < 4; k++) {
      const w = dense[i * JOINT_COUNT + order[k]!]! / sum;
      weights[i * 4 + k] = w;
      indices[i * 4 + k] = w > 0 ? order[k]! : 0;
    }
  }
  return { indices, weights };
}
