import type { GridSpec, SampledGrid } from './surface.js';

/** Comprobaciones topológicas de una malla triangular indexada. */
export interface TopologyReport {
  /** aristas usadas por != 2 triángulos */
  readonly badEdges: number;
  /** aristas con una sola cara (borde abierto) */
  readonly boundaryEdges: number;
  /** aristas con más de 2 caras */
  readonly nonManifoldEdges: number;
  /** aristas recorridas dos veces en el mismo sentido (orientación inconsistente) */
  readonly inconsistentEdges: number;
  /** vértices cuya vecindad de triángulos no forma un único abanico */
  readonly nonManifoldVertices: number;
  /** componentes conexas (por vértices usados) */
  readonly components: number;
  /** característica de Euler V − E + F */
  readonly euler: number;
}

/** Análisis topológico completo (se usa en tests y como red de seguridad de `buildBody`). */
export function analyzeTopology(vertexCount: number, indices: Uint32Array): TopologyReport {
  const nT = indices.length / 3;
  const edgeCount = new Map<number, number>();
  const dirCount = new Map<number, number>();
  const M = vertexCount;
  for (let t = 0; t < nT; t++) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t * 3 + e]!;
      const b = indices[t * 3 + ((e + 1) % 3)]!;
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const key = lo * M + hi;
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
      const dk = a * M + b;
      dirCount.set(dk, (dirCount.get(dk) ?? 0) + 1);
    }
  }
  let boundary = 0;
  let nonManifold = 0;
  for (const c of edgeCount.values()) {
    if (c === 1) boundary++;
    else if (c > 2) nonManifold++;
  }
  let inconsistent = 0;
  for (const c of dirCount.values()) if (c > 1) inconsistent++;

  // abanico de triángulos por vértice: aristas del enlace deben formar un único ciclo
  const used = new Uint8Array(M);
  const triOfVertex: number[][] = new Array<number[]>(M);
  for (let t = 0; t < nT; t++) {
    for (let e = 0; e < 3; e++) {
      const v = indices[t * 3 + e]!;
      used[v] = 1;
      (triOfVertex[v] ??= []).push(t);
    }
  }
  let nonManifoldVertices = 0;
  for (let v = 0; v < M; v++) {
    const tris = triOfVertex[v];
    if (!tris) continue;
    // enlace: para cada triángulo con v, la arista opuesta (b -> c)
    const next = new Map<number, number>();
    let ok = true;
    for (const t of tris) {
      const a = indices[t * 3]!;
      const b = indices[t * 3 + 1]!;
      const c = indices[t * 3 + 2]!;
      let from: number;
      let to: number;
      if (a === v) {
        from = b;
        to = c;
      } else if (b === v) {
        from = c;
        to = a;
      } else {
        from = a;
        to = b;
      }
      if (next.has(from)) ok = false;
      next.set(from, to);
    }
    if (ok) {
      // recorrer el ciclo
      const start = next.keys().next().value as number;
      let cur = start;
      let n = 0;
      do {
        const nx = next.get(cur);
        if (nx === undefined) {
          ok = false;
          break;
        }
        cur = nx;
        n++;
      } while (cur !== start && n <= tris.length);
      if (ok && n !== tris.length) ok = false;
    }
    if (!ok) nonManifoldVertices++;
  }
  // componentes conexas con union-find
  const parent = new Int32Array(M);
  for (let i = 0; i < M; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x]! !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  for (let t = 0; t < nT; t++) {
    const a = find(indices[t * 3]!);
    const b = find(indices[t * 3 + 1]!);
    const c = find(indices[t * 3 + 2]!);
    if (a !== b) parent[b] = a;
    const a2 = find(a);
    if (a2 !== c) parent[c] = a2;
  }
  const roots = new Set<number>();
  let usedCount = 0;
  for (let v = 0; v < M; v++) {
    if (used[v]) {
      roots.add(find(v));
      usedCount++;
    }
  }
  return {
    badEdges: boundary + nonManifold,
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    inconsistentEdges: inconsistent,
    nonManifoldVertices,
    components: roots.size,
    euler: usedCount - edgeCount.size + nT,
  };
}

/**
 * Comprobación rápida (O(E)) de que la malla es cerrada, bien orientada y edge-manifold: cada arista dirigida a→b
 * aparece exactamente una vez y su gemela b→a también. Usa la adyacencia CSR de aristas dirigidas.
 */
export function isClosedOrientedManifold(vertexCount: number, indices: Uint32Array): boolean {
  return adjacencyIsClosed(vertexCount, buildAdjacency(vertexCount, indices));
}

/** Igual que `isClosedOrientedManifold` pero reutilizando una adyacencia ya construida. */
export function adjacencyIsClosed(vertexCount: number, adj: Adjacency): boolean {
  const { offsets, neighbors } = adj;
  for (let a = 0; a < vertexCount; a++) {
    const s = offsets[a]!;
    const e = offsets[a + 1]!;
    for (let q = s; q < e; q++) {
      const b = neighbors[q]!;
      // sin duplicados de la arista dirigida a→b
      for (let r = q + 1; r < e; r++) if (neighbors[r]! === b) return false;
      // existe la gemela b→a
      let found = false;
      for (let r = offsets[b]!; r < offsets[b + 1]!; r++) {
        if (neighbors[r]! === a) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
  }
  return true;
}

/** Conserva sólo la mayor componente conexa y compacta los índices. */
export function keepLargestComponent(
  positions: Float32Array,
  indices: Uint32Array,
): { positions: Float32Array; indices: Uint32Array } {
  const n = positions.length / 3;
  const nT = indices.length / 3;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x]! !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  for (let t = 0; t < nT; t++) {
    const a = find(indices[t * 3]!);
    const b = find(indices[t * 3 + 1]!);
    const c = find(indices[t * 3 + 2]!);
    if (a !== b) parent[b] = a;
    const a2 = find(a);
    if (a2 !== c) parent[c] = a2;
  }
  const triCount = new Map<number, number>();
  for (let t = 0; t < nT; t++) {
    const r = find(indices[t * 3]!);
    triCount.set(r, (triCount.get(r) ?? 0) + 1);
  }
  let best = -1;
  let bestN = -1;
  for (const [r, c] of triCount) {
    if (c > bestN || (c === bestN && r < best)) {
      best = r;
      bestN = c;
    }
  }
  const remap = new Int32Array(n).fill(-1);
  let nv = 0;
  const outIdx: number[] = [];
  for (let t = 0; t < nT; t++) {
    if (find(indices[t * 3]!) !== best) continue;
    for (let e = 0; e < 3; e++) {
      const v = indices[t * 3 + e]!;
      if (remap[v]! < 0) remap[v] = nv++;
      outIdx.push(remap[v]!);
    }
  }
  const outPos = new Float32Array(nv * 3);
  for (let v = 0; v < n; v++) {
    const r = remap[v]!;
    if (r >= 0) {
      outPos[r * 3] = positions[v * 3]!;
      outPos[r * 3 + 1] = positions[v * 3 + 1]!;
      outPos[r * 3 + 2] = positions[v * 3 + 2]!;
    }
  }
  return { positions: outPos, indices: Uint32Array.from(outIdx) };
}

/** Adyacencia en formato CSR (offsets + vecinos únicos). */
export interface Adjacency {
  readonly offsets: Uint32Array;
  readonly neighbors: Uint32Array;
}

export function buildAdjacency(vertexCount: number, indices: Uint32Array): Adjacency {
  // En una malla cerrada 2-manifold cada arista dirigida a→b aparece una vez: basta con registrar b en a.
  const offsets = new Uint32Array(vertexCount + 1);
  for (let t = 0; t < indices.length; t++) offsets[indices[t]! + 1]!++;
  for (let i = 0; i < vertexCount; i++) offsets[i + 1] = offsets[i + 1]! + offsets[i]!;
  const fill = new Uint32Array(vertexCount);
  const neighbors = new Uint32Array(offsets[vertexCount]!);
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e]!;
      const b = indices[t + ((e + 1) % 3)]!;
      neighbors[offsets[a]! + fill[a]!++] = b;
    }
  }
  return { offsets, neighbors };
}

/**
 * Suavizado de Taubin (λ|μ): reduce el ruido de escalón de la rejilla sin encoger el volumen apreciablemente.
 * Determinista (orden fijo). Opera en Float64 internamente.
 */
export function taubinSmooth(
  positions: Float32Array,
  adj: Adjacency,
  iterations: number,
  lambda = 0.5,
  mu = -0.53,
): void {
  const n = positions.length / 3;
  let cur = Float64Array.from(positions);
  let nxt = new Float64Array(cur.length);
  const { offsets, neighbors } = adj;
  const pass = (f: number): void => {
    for (let v = 0; v < n; v++) {
      const s = offsets[v]!;
      const e = offsets[v + 1]!;
      const cnt = e - s;
      if (cnt === 0) {
        nxt[v * 3] = cur[v * 3]!;
        nxt[v * 3 + 1] = cur[v * 3 + 1]!;
        nxt[v * 3 + 2] = cur[v * 3 + 2]!;
        continue;
      }
      let ax = 0;
      let ay = 0;
      let az = 0;
      for (let k = s; k < e; k++) {
        const w = neighbors[k]! * 3;
        ax += cur[w]!;
        ay += cur[w + 1]!;
        az += cur[w + 2]!;
      }
      const inv = 1 / cnt;
      nxt[v * 3] = cur[v * 3]! + f * (ax * inv - cur[v * 3]!);
      nxt[v * 3 + 1] = cur[v * 3 + 1]! + f * (ay * inv - cur[v * 3 + 1]!);
      nxt[v * 3 + 2] = cur[v * 3 + 2]! + f * (az * inv - cur[v * 3 + 2]!);
    }
    const tmp = cur;
    cur = nxt;
    nxt = tmp;
  };
  for (let it = 0; it < iterations; it++) {
    pass(lambda);
    pass(mu);
  }
  for (let i = 0; i < cur.length; i++) positions[i] = cur[i]!;
}

/** Orientación de los 8 vértices de una celda: bit c = x + 2y + 4z. */
const CRITICAL = new Uint8Array(256);
(() => {
  const cx = [0, 1, 0, 1, 0, 1, 0, 1];
  const cy = [0, 0, 1, 1, 0, 0, 1, 1];
  const cz = [0, 0, 0, 0, 1, 1, 1, 1];
  const idx = (x: number, y: number, z: number): number => x + 2 * y + 4 * z;
  for (let mask = 1; mask < 255; mask++) {
    const bit = (c: number): boolean => ((mask >> c) & 1) === 1;
    let crit = false;
    // diagonales espaciales: dos esquinas opuestas dentro y el resto fuera (o complementario)
    for (let c = 0; c < 4; c++) {
      const o = 7 - c;
      if (bit(c) && bit(o)) {
        let others = 0;
        for (let k = 0; k < 8; k++) if (k !== c && k !== o && bit(k)) others++;
        if (others === 0) crit = true;
      }
      if (!bit(c) && !bit(o)) {
        let others = 0;
        for (let k = 0; k < 8; k++) if (k !== c && k !== o && !bit(k)) others++;
        if (others === 0) crit = true;
      }
    }
    // caras con patrón de tablero
    for (const axis of [0, 1, 2]) {
      for (const side of [0, 1]) {
        const face: number[] = [];
        for (let c = 0; c < 8; c++) {
          const coord = axis === 0 ? cx[c]! : axis === 1 ? cy[c]! : cz[c]!;
          if (coord === side) face.push(c);
        }
        // face = 4 esquinas; diagonales: (menor, mayor) y las otras dos
        const [p0, p1, p2, p3] = face as [number, number, number, number];
        // en el orden generado: p0=(0,0), p1=(1,0), p2=(0,1), p3=(1,1) en los otros dos ejes
        if (bit(p0) && bit(p3) && !bit(p1) && !bit(p2)) crit = true;
        if (!bit(p0) && !bit(p3) && bit(p1) && bit(p2)) crit = true;
      }
    }
    CRITICAL[mask] = crit ? 1 : 0;
  }
  void idx;
})();

/**
 * Repara el etiquetado dentro/fuera para que sea «bien compuesto» (sin configuraciones críticas en caras ni
 * diagonales espaciales): así el surface-nets resultante es una variedad 2-manifold. Cambia el signo del nodo
 * de menor |valor| de cada celda crítica (cambio geométrico sub-voxel) y revisa las celdas vecinas.
 * Devuelve el número de nodos modificados.
 */
export function repairLabeling(spec: GridSpec, grid: SampledGrid, maxFlips = 200000): number {
  const { nx, ny, nz } = spec;
  const F = grid.F;
  const sy = nx;
  const sz = nx * ny;
  const offs = [0, 1, sy, 1 + sy, sz, 1 + sz, sy + sz, 1 + sy + sz];
  const cvx = nx - 1;
  const cvy = ny - 1;
  const cvz = nz - 1;
  const queue: number[] = [];
  const maskOf = (base: number): number => {
    let mask = 0;
    for (let c = 0; c < 8; c++) if (F[base + offs[c]!]! < 0) mask |= 1 << c;
    return mask;
  };
  const blocks = grid.blocks;
  for (let b = 0; b < blocks.length; b += 3) {
    for (let dk = 0; dk < 2; dk++)
      for (let dj = 0; dj < 2; dj++)
        for (let di = 0; di < 2; di++) {
          const i = blocks[b]! + di;
          const j = blocks[b + 1]! + dj;
          const k = blocks[b + 2]! + dk;
          if (i >= cvx || j >= cvy || k >= cvz) continue;
          const base = i + j * sy + k * sz;
          const m = maskOf(base);
          if (m !== 0 && m !== 255 && CRITICAL[m]! === 1) queue.push(base);
        }
  }
  let flips = 0;
  let head = 0;
  while (head < queue.length && flips < maxFlips) {
    const base = queue[head++]!;
    const m = maskOf(base);
    if (m === 0 || m === 255 || CRITICAL[m]! === 0) continue;
    // nodo de menor |valor| entre las 8 esquinas cuyo cambio de signo resuelve la celda
    let bestNode = -1;
    let bestAbs = Infinity;
    for (let c = 0; c < 8; c++) {
      const m2 = m ^ (1 << c);
      if (m2 !== 0 && m2 !== 255 && CRITICAL[m2]! === 1) continue;
      const node = base + offs[c]!;
      const a = Math.abs(F[node]!);
      if (a < bestAbs) {
        bestAbs = a;
        bestNode = node;
      }
    }
    if (bestNode < 0) {
      // ninguna esquina lo resuelve por sí sola: cambiar la de menor |valor|
      for (let c = 0; c < 8; c++) {
        const node = base + offs[c]!;
        const a = Math.abs(F[node]!);
        if (a < bestAbs) {
          bestAbs = a;
          bestNode = node;
        }
      }
    }
    const v = F[bestNode]!;
    F[bestNode] = v === 0 ? -1e-9 : -v;
    flips++;
    // revisar las 8 celdas que comparten el nodo
    const ni = bestNode % nx;
    const nj = Math.floor(bestNode / nx) % ny;
    const nk = Math.floor(bestNode / sz);
    for (let dk = -1; dk <= 0; dk++)
      for (let dj = -1; dj <= 0; dj++)
        for (let di = -1; di <= 0; di++) {
          const ci = ni + di;
          const cj = nj + dj;
          const ck = nk + dk;
          if (ci < 0 || cj < 0 || ck < 0 || ci >= cvx || cj >= cvy || ck >= cvz) continue;
          queue.push(ci + cj * sy + ck * sz);
        }
  }
  return flips;
}

export interface SelfIntersectionReport {
  /** triángulos distintos implicados en al menos una intersección */
  readonly intersectingTriangles: number;
  readonly triangleCount: number;
  /** pares candidatos (no adyacentes y con cajas solapadas) realmente comprobados */
  readonly pairsTested: number;
  /** intersectingTriangles / triangleCount */
  readonly rate: number;
}

/**
 * Estimación aproximada de autointersecciones: dispersión espacial de triángulos y prueba segmento-triángulo
 * (Möller–Trumbore) entre las aristas de cada par no adyacente (sin vértices comunes). No detecta triángulos
 * coplanares ni contactos exactos; sirve para medir tasas y comparar, no como prueba formal.
 */
export function estimateSelfIntersections(
  positions: Float32Array,
  indices: Uint32Array,
): SelfIntersectionReport {
  const nT = indices.length / 3;
  // tamaño de celda = 3 × longitud media de arista
  let edgeSum = 0;
  let edgeN = 0;
  for (let t = 0; t < nT; t += 7) {
    const a = indices[t * 3]! * 3;
    const b = indices[t * 3 + 1]! * 3;
    edgeSum += Math.hypot(
      positions[a]! - positions[b]!,
      positions[a + 1]! - positions[b + 1]!,
      positions[a + 2]! - positions[b + 2]!,
    );
    edgeN++;
  }
  const cell = Math.max((3 * edgeSum) / Math.max(edgeN, 1), 1e-4);
  const lo = new Float64Array(nT * 3);
  const hi = new Float64Array(nT * 3);
  const grid = new Map<number, number[]>();
  const KX = 4096;
  const key = (i: number, j: number, k: number): number => (i + 2048) + KX * ((j + 2048) + KX * (k + 2048));
  for (let t = 0; t < nT; t++) {
    for (let c = 0; c < 3; c++) {
      lo[t * 3 + c] = Infinity;
      hi[t * 3 + c] = -Infinity;
    }
    for (let e = 0; e < 3; e++) {
      const v = indices[t * 3 + e]! * 3;
      for (let c = 0; c < 3; c++) {
        const x = positions[v + c]!;
        if (x < lo[t * 3 + c]!) lo[t * 3 + c] = x;
        if (x > hi[t * 3 + c]!) hi[t * 3 + c] = x;
      }
    }
    const i0 = Math.floor(lo[t * 3]! / cell);
    const j0 = Math.floor(lo[t * 3 + 1]! / cell);
    const k0 = Math.floor(lo[t * 3 + 2]! / cell);
    const i1 = Math.floor(hi[t * 3]! / cell);
    const j1 = Math.floor(hi[t * 3 + 1]! / cell);
    const k1 = Math.floor(hi[t * 3 + 2]! / cell);
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const kk = key(i, j, k);
          const l = grid.get(kk);
          if (l) l.push(t);
          else grid.set(kk, [t]);
        }
  }
  const hit = new Uint8Array(nT);
  let pairsTested = 0;
  const P = positions;
  const segTri = (
    p: number,
    q: number,
    a: number,
    b: number,
    c: number,
  ): boolean => {
    const px = P[p]!;
    const py = P[p + 1]!;
    const pz = P[p + 2]!;
    const dx = P[q]! - px;
    const dy = P[q + 1]! - py;
    const dz = P[q + 2]! - pz;
    const e1x = P[b]! - P[a]!;
    const e1y = P[b + 1]! - P[a + 1]!;
    const e1z = P[b + 2]! - P[a + 2]!;
    const e2x = P[c]! - P[a]!;
    const e2y = P[c + 1]! - P[a + 1]!;
    const e2z = P[c + 2]! - P[a + 2]!;
    const hx = dy * e2z - dz * e2y;
    const hy = dz * e2x - dx * e2z;
    const hz = dx * e2y - dy * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < 1e-18) return false;
    const inv = 1 / det;
    const sx = px - P[a]!;
    const sy = py - P[a + 1]!;
    const sz = pz - P[a + 2]!;
    const u = (sx * hx + sy * hy + sz * hz) * inv;
    if (u < 1e-6 || u > 1 - 1e-6) return false;
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 1e-6 || u + v > 1 - 1e-6) return false;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return t > 1e-6 && t < 1 - 1e-6;
  };
  for (const [kk, list] of grid) {
    if (list.length < 2) continue;
    const ci = (kk % KX) - 2048;
    const cj = (Math.floor(kk / KX) % KX) - 2048;
    const ck = Math.floor(kk / (KX * KX)) - 2048;
    for (let x = 0; x < list.length; x++) {
      const ta = list[x]!;
      for (let y = x + 1; y < list.length; y++) {
        const tb = list[y]!;
        // celda propietaria: la del mínimo de la intersección de cajas
        const ox = Math.max(lo[ta * 3]!, lo[tb * 3]!);
        const oy = Math.max(lo[ta * 3 + 1]!, lo[tb * 3 + 1]!);
        const oz = Math.max(lo[ta * 3 + 2]!, lo[tb * 3 + 2]!);
        if (
          ox > Math.min(hi[ta * 3]!, hi[tb * 3]!) ||
          oy > Math.min(hi[ta * 3 + 1]!, hi[tb * 3 + 1]!) ||
          oz > Math.min(hi[ta * 3 + 2]!, hi[tb * 3 + 2]!)
        )
          continue;
        if (Math.floor(ox / cell) !== ci || Math.floor(oy / cell) !== cj || Math.floor(oz / cell) !== ck)
          continue;
        const a0 = indices[ta * 3]!;
        const a1 = indices[ta * 3 + 1]!;
        const a2 = indices[ta * 3 + 2]!;
        const b0 = indices[tb * 3]!;
        const b1 = indices[tb * 3 + 1]!;
        const b2 = indices[tb * 3 + 2]!;
        if (a0 === b0 || a0 === b1 || a0 === b2 || a1 === b0 || a1 === b1 || a1 === b2 || a2 === b0 || a2 === b1 || a2 === b2)
          continue;
        pairsTested++;
        const A = [a0 * 3, a1 * 3, a2 * 3];
        const B = [b0 * 3, b1 * 3, b2 * 3];
        let inter = false;
        for (let e = 0; e < 3 && !inter; e++) {
          if (segTri(A[e]!, A[(e + 1) % 3]!, B[0]!, B[1]!, B[2]!)) inter = true;
          else if (segTri(B[e]!, B[(e + 1) % 3]!, A[0]!, A[1]!, A[2]!)) inter = true;
        }
        if (inter) {
          hit[ta] = 1;
          hit[tb] = 1;
        }
      }
    }
  }
  let n = 0;
  for (let t = 0; t < nT; t++) n += hit[t]!;
  return { intersectingTriangles: n, triangleCount: nT, pairsTested, rate: nT > 0 ? n / nT : 0 };
}
