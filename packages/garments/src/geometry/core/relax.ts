import type { BodyField } from './bodyField.js';
import { sampleSdfGrad } from './sdfGrid.js';
import { GarmentMesh } from './mesh.js';

/** Adyacencia (CSR) entre nodos a partir de las celdas de todas las superficies. */
export interface Adjacency {
  readonly start: Uint32Array;
  readonly items: Uint32Array;
}

export function buildAdjacency(mesh: GarmentMesh): Adjacency {
  const n = mesh.nodeCount;
  const keys: number[] = [];
  for (const s of mesh.surfaces) {
    for (let r = 0; r + 1 < s.rows; r++)
      for (let c = 0; c + 1 < s.cols; c++) {
        if (!s.cellOn[r * (s.cols - 1) + c]) continue;
        const a = s.node[r * s.cols + c]!,
          b = s.node[r * s.cols + c + 1]!,
          d = s.node[(r + 1) * s.cols + c]!,
          e = s.node[(r + 1) * s.cols + c + 1]!;
        if (a < 0 || b < 0 || d < 0 || e < 0) continue;
        const add = (p: number, q: number): void => {
          if (p === q) return;
          keys.push(p < q ? p * n + q : q * n + p);
        };
        add(a, b);
        add(b, e);
        add(e, d);
        add(d, a);
      }
  }
  const sorted = Float64Array.from(keys).sort();
  const edges: number[] = [];
  for (let i = 0; i < sorted.length; i++) if (i === 0 || sorted[i] !== sorted[i - 1]) edges.push(sorted[i]!);
  const deg = new Uint32Array(n + 1);
  for (const k of edges) {
    deg[Math.floor(k / n) + 1]!++;
    deg[(k % n) + 1]!++;
  }
  for (let i = 1; i <= n; i++) deg[i] = deg[i]! + deg[i - 1]!;
  const fill = deg.slice();
  const items = new Uint32Array(deg[n]!);
  for (const k of edges) {
    const a = Math.floor(k / n),
      b = k % n;
    items[fill[a]!++] = b;
    items[fill[b]!++] = a;
  }
  return { start: deg, items };
}

export interface ConformOptions {
  readonly iterations?: number;
  /** peso de difusión del desplazamiento hacia los vecinos (0..1) */
  readonly spread?: number;
}

/**
 * Empuja los nodos fuera del cuerpo hasta su holgura mínima y difunde el desplazamiento por la malla para que
 * las correcciones sean abultamientos suaves y no hoyuelos aislados. Termina con una pasada de cumplimiento estricto.
 * Devuelve el desplazamiento máximo aplicado (m).
 */
export function pushOutAndSpread(
  mesh: GarmentMesh,
  f: BodyField,
  adj: Adjacency,
  opts: ConformOptions = {},
): number {
  const n = mesh.nodeCount;
  const iters = opts.iterations ?? 10;
  const spread = opts.spread ?? 0.5;
  const P = mesh.pos.data;
  const C = mesh.clear.data;
  const p0 = new Float64Array(P.subarray(0, n * 3));
  const D = new Float64Array(n * 3);
  const tmp = new Float64Array(n * 3);
  const g = new Float64Array(3);
  let maxDisp = 0;
  const enforce = (): void => {
    for (let i = 0; i < n; i++) {
      const x = p0[i * 3]! + D[i * 3]!,
        y = p0[i * 3 + 1]! + D[i * 3 + 1]!,
        z = p0[i * 3 + 2]! + D[i * 3 + 2]!;
      const d = sampleSdfGrad(f.sdf, x, y, z, g);
      const need = C[i]! - d;
      if (need > 0) {
        const gl = Math.hypot(g[0]!, g[1]!, g[2]!) || 1;
        const k = (need * 1.05 + 0.0002) / gl;
        D[i * 3] = D[i * 3]! + g[0]! * k;
        D[i * 3 + 1] = D[i * 3 + 1]! + g[1]! * k;
        D[i * 3 + 2] = D[i * 3 + 2]! + g[2]! * k;
      }
    }
  };
  for (let it = 0; it < iters; it++) {
    enforce();
    // difusión: media con vecinos, pero nunca reduce por debajo del desplazamiento actual de un nodo comprimido
    for (let i = 0; i < n; i++) {
      const s = adj.start[i]!,
        e = adj.start[i + 1]!;
      if (e === s) {
        tmp[i * 3] = D[i * 3]!;
        tmp[i * 3 + 1] = D[i * 3 + 1]!;
        tmp[i * 3 + 2] = D[i * 3 + 2]!;
        continue;
      }
      let ax = 0,
        ay = 0,
        az = 0;
      for (let k = s; k < e; k++) {
        const j = adj.items[k]!;
        ax += D[j * 3]!;
        ay += D[j * 3 + 1]!;
        az += D[j * 3 + 2]!;
      }
      const inv = 1 / (e - s);
      tmp[i * 3] = D[i * 3]! + (ax * inv - D[i * 3]!) * spread;
      tmp[i * 3 + 1] = D[i * 3 + 1]! + (ay * inv - D[i * 3 + 1]!) * spread;
      tmp[i * 3 + 2] = D[i * 3 + 2]! + (az * inv - D[i * 3 + 2]!) * spread;
    }
    D.set(tmp);
  }
  enforce();
  enforce();
  for (let i = 0; i < n; i++) {
    const dl = Math.hypot(D[i * 3]!, D[i * 3 + 1]!, D[i * 3 + 2]!);
    if (dl > maxDisp) maxDisp = dl;
    P[i * 3] = p0[i * 3]! + D[i * 3]!;
    P[i * 3 + 1] = p0[i * 3 + 1]! + D[i * 3 + 1]!;
    P[i * 3 + 2] = p0[i * 3 + 2]! + D[i * 3 + 2]!;
  }
  return maxDisp;
}

/** Distancia (en saltos de arista) desde un conjunto de nodos semilla, acotada a `maxHops`. 255 = fuera de la banda. */
export function hopDistance(adj: Adjacency, n: number, seeds: ArrayLike<number>, maxHops: number): Uint8Array {
  const dist = new Uint8Array(n).fill(255);
  let frontier: number[] = [];
  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i]!;
    if (dist[s] !== 0) {
      dist[s] = 0;
      frontier.push(s);
    }
  }
  for (let h = 1; h <= maxHops && frontier.length; h++) {
    const next: number[] = [];
    for (const v of frontier) {
      for (let k = adj.start[v]!; k < adj.start[v + 1]!; k++) {
        const w = adj.items[k]!;
        if (dist[w] === 255) {
          dist[w] = h;
          next.push(w);
        }
      }
    }
    frontier = next;
  }
  return dist;
}

/**
 * Suavizado laplaciano restringido a una banda alrededor de unas semillas (que no se mueven):
 * el peso decae con la distancia en saltos. Sirve para repartir la tensión en una unión (sisa, entrepierna).
 */
export function smoothBand(
  mesh: GarmentMesh,
  adj: Adjacency,
  seeds: ArrayLike<number>,
  hops: number,
  iterations: number,
  lambda = 0.5,
): void {
  const n = mesh.nodeCount;
  const dist = hopDistance(adj, n, seeds, hops);
  const P = mesh.pos.data;
  const tmp = new Float64Array(n * 3);
  for (let it = 0; it < iterations; it++) {
    tmp.set(P.subarray(0, n * 3));
    for (let i = 0; i < n; i++) {
      const d = dist[i]!;
      if (d === 0 || d === 255) continue;
      const s = adj.start[i]!,
        e = adj.start[i + 1]!;
      if (e === s) continue;
      let ax = 0,
        ay = 0,
        az = 0;
      for (let k = s; k < e; k++) {
        const j = adj.items[k]!;
        ax += P[j * 3]!;
        ay += P[j * 3 + 1]!;
        az += P[j * 3 + 2]!;
      }
      const inv = 1 / (e - s);
      const w = lambda * (1 - (d - 1) / hops);
      tmp[i * 3] = P[i * 3]! + (ax * inv - P[i * 3]!) * w;
      tmp[i * 3 + 1] = P[i * 3 + 1]! + (ay * inv - P[i * 3 + 1]!) * w;
      tmp[i * 3 + 2] = P[i * 3 + 2]! + (az * inv - P[i * 3 + 2]!) * w;
    }
    for (let i = 0; i < n * 3; i++) P[i] = tmp[i]!;
  }
}

/**
 * Suavizado laplaciano a lo largo de las COLUMNAS de una superficie (entre filas r0..r1, exclusivas en los extremos):
 * elimina el rizado horizontal por interpolación entre cortes del cuerpo y ruido de muestreo del SDF, sin encoger los anillos.
 */
export function smoothSurfaceRows(
  mesh: GarmentMesh,
  s: import('./mesh.js').Surface,
  r0: number,
  r1: number,
  iterations: number,
  lambda = 0.5,
  fixed?: ReadonlySet<number>,
): void {
  const P = mesh.pos.data;
  const cMax = s.wrap ? s.cols - 1 : s.cols;
  const tmp = new Float64Array(s.rows * 3);
  for (let it = 0; it < iterations; it++) {
    for (let c = 0; c < cMax; c++) {
      for (let r = r0 + 1; r < r1; r++) {
        const n = s.node[r * s.cols + c]!;
        const a = s.node[(r - 1) * s.cols + c]!;
        const b = s.node[(r + 1) * s.cols + c]!;
        tmp[r * 3] = Number.NaN;
        if (n < 0 || a < 0 || b < 0 || (fixed && fixed.has(n))) continue;
        tmp[r * 3] = P[n * 3]! + (0.5 * (P[a * 3]! + P[b * 3]!) - P[n * 3]!) * lambda;
        tmp[r * 3 + 1] = P[n * 3 + 1]! + (0.5 * (P[a * 3 + 1]! + P[b * 3 + 1]!) - P[n * 3 + 1]!) * lambda;
        tmp[r * 3 + 2] = P[n * 3 + 2]! + (0.5 * (P[a * 3 + 2]! + P[b * 3 + 2]!) - P[n * 3 + 2]!) * lambda;
      }
      for (let r = r0 + 1; r < r1; r++) {
        if (Number.isNaN(tmp[r * 3]!)) continue;
        const n = s.node[r * s.cols + c]!;
        P[n * 3] = tmp[r * 3]!;
        P[n * 3 + 1] = tmp[r * 3 + 1]!;
        P[n * 3 + 2] = tmp[r * 3 + 2]!;
      }
    }
  }
}
