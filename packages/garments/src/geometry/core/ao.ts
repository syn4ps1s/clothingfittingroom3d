import { sampleSdf } from './sdfGrid.js';
import { NF, type GarmentMesh } from './mesh.js';
import type { BodyField } from './bodyField.js';
import type { Adjacency } from './relax.js';

/**
 * Oclusión ambiental horneada por nodo (1 = abierto, 0 = muy ocluido):
 *  - cavidades respecto al cuerpo: cono a lo largo de la normal contra el SDF (axila, entrepierna, bajo la manga);
 *  - concavidad geométrica de la propia prenda (pliegues, cuello) por el laplaciano frente a la normal;
 *  - capas interiores (vueltas de dobladillo, forro, interior de mangas) oscurecidas.
 */
export function bakeNodeAo(
  f: BodyField,
  mesh: GarmentMesh,
  adj: Adjacency,
  nodeNormals: Float32Array,
): Float32Array {
  const n = mesh.nodeCount;
  const P = mesh.pos.data;
  const ao = new Float32Array(n);
  const dists = [0.006, 0.018, 0.04, 0.075];
  const wts = [1, 0.7, 0.5, 0.35];
  const wsum = wts.reduce((a, b) => a + b, 0);
  for (let i = 0; i < n; i++) {
    const nx = nodeNormals[i * 3]!,
      ny = nodeNormals[i * 3 + 1]!,
      nz = nodeNormals[i * 3 + 2]!;
    const x = P[i * 3]!,
      y = P[i * 3 + 1]!,
      z = P[i * 3 + 2]!;
    let occ = 0;
    for (let k = 0; k < dists.length; k++) {
      const d = dists[k]!;
      const s = sampleSdf(f.sdf, x + nx * d, y + ny * d, z + nz * d);
      occ += (wts[k]! * Math.max(0, d - s)) / d;
    }
    occ /= wsum;
    let v = 1 - Math.min(1, occ * 1.15);
    // concavidad propia
    const s0 = adj.start[i]!,
      e0 = adj.start[i + 1]!;
    if (e0 > s0) {
      let ax = 0,
        ay = 0,
        az = 0;
      for (let k = s0; k < e0; k++) {
        const j = adj.items[k]!;
        ax += P[j * 3]!;
        ay += P[j * 3 + 1]!;
        az += P[j * 3 + 2]!;
      }
      const inv = 1 / (e0 - s0);
      const lx = ax * inv - x,
        ly = ay * inv - y,
        lz = az * inv - z;
      const conc = Math.max(0, (lx * nx + ly * ny + lz * nz) / 0.0035);
      v *= 1 - 0.45 * Math.min(1, conc);
    }
    if (mesh.flags[i]! & NF.inner) v *= 0.45;
    ao[i] = Math.min(1, Math.max(0.05, v));
  }
  return ao;
}
