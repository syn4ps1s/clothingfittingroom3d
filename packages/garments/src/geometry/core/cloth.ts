import { sampleSdf } from './sdfGrid.js';
import { NF, type GarmentMesh } from './mesh.js';
import type { BodyField } from './bodyField.js';
import type { Adjacency } from './relax.js';

/** Distancia geodésica (sobre aristas) desde los nodos con la bandera `anchor` (Dijkstra con montículo binario). */
export function geodesicFromAnchors(mesh: GarmentMesh, adj: Adjacency): Float32Array {
  const n = mesh.nodeCount;
  const dist = new Float32Array(n).fill(Infinity);
  const heapNode: number[] = [];
  const heapKey: number[] = [];
  const push = (node: number, key: number): void => {
    heapNode.push(node);
    heapKey.push(key);
    let i = heapNode.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapKey[p]! <= heapKey[i]!) break;
      [heapKey[p], heapKey[i]] = [heapKey[i]!, heapKey[p]!];
      [heapNode[p], heapNode[i]] = [heapNode[i]!, heapNode[p]!];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const rn = heapNode[0]!,
      rk = heapKey[0]!;
    const ln = heapNode.pop()!,
      lk = heapKey.pop()!;
    if (heapNode.length) {
      heapNode[0] = ln;
      heapKey[0] = lk;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i;
        if (l < heapNode.length && heapKey[l]! < heapKey[m]!) m = l;
        if (r < heapNode.length && heapKey[r]! < heapKey[m]!) m = r;
        if (m === i) break;
        [heapKey[m], heapKey[i]] = [heapKey[i]!, heapKey[m]!];
        [heapNode[m], heapNode[i]] = [heapNode[i]!, heapNode[m]!];
        i = m;
      }
    }
    return [rn, rk];
  };
  const P = mesh.pos.data;
  let any = false;
  for (let i = 0; i < n; i++) {
    if (mesh.flags[i]! & NF.anchor) {
      dist[i] = 0;
      push(i, 0);
      any = true;
    }
  }
  if (!any) dist.fill(0);
  while (heapNode.length) {
    const [u, du] = pop();
    if (du > dist[u]!) continue;
    for (let k = adj.start[u]!; k < adj.start[u + 1]!; k++) {
      const v = adj.items[k]!;
      const w = Math.hypot(P[u * 3]! - P[v * 3]!, P[u * 3 + 1]! - P[v * 3 + 1]!, P[u * 3 + 2]! - P[v * 3 + 2]!);
      if (du + w < dist[v]!) {
        dist[v] = du + w;
        push(v, du + w);
      }
    }
  }
  return dist;
}

export interface ClothPaint {
  /** distancia máxima al estado skinneado por nodo (m) */
  maxDistance: Float32Array;
  invMass: Float32Array;
}

export interface ClothPaintOptions {
  /** tope absoluto de libertad (m): ~0.10 camisetas, ~0.25 faldas largas */
  readonly cap: number;
  /** distancia desde un ancla a la que se alcanza el tope (m) */
  readonly ramp: number;
}

/** Pinta maxDistance/invMass por nodo: 0 en las anclas, creciente con la distancia y la holgura local respecto al cuerpo. */
export function paintCloth(
  f: BodyField,
  mesh: GarmentMesh,
  adj: Adjacency,
  opts: ClothPaintOptions,
): ClothPaint {
  const n = mesh.nodeCount;
  const geo = geodesicFromAnchors(mesh, adj);
  const P = mesh.pos.data;
  const maxDistance = new Float32Array(n);
  const invMass = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const fl = mesh.flags[i]!;
    if (fl & (NF.anchor | NF.rigid)) {
      maxDistance[i] = 0;
      invMass[i] = 0;
      continue;
    }
    const sd = sampleSdf(f.sdf, P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!);
    const t = Math.min(1, geo[i]! / opts.ramp);
    const ramp = t * t * (3 - 2 * t);
    const loose = 0.012 + 1.6 * Math.max(0, sd - 0.003);
    maxDistance[i] = Math.max(0.002, Math.min(opts.cap * ramp, loose));
    invMass[i] = fl & NF.inner ? 0.7 : 1;
  }
  return { maxDistance, invMass };
}
