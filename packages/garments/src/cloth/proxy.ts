import type { GarmentGeometry } from '@fitroom/shared';
import { ClothSolverError } from './types.js';

/**
 * Malla proxy de simulación.
 *
 * La prenda de render (decenas de miles de vértices) se agrupa en ≤ `budget` partículas por "vertex
 * clustering" sobre una rejilla espacial en reposo, con tres salvaguardas:
 *   1. la clave de celda incluye el hueso dominante del vértice (el brazo no se mezcla con el torso
 *      aunque estén cerca en A-pose);
 *   2. cada celda se divide en sus componentes CONEXOS (por aristas del mallado), de modo que nunca se
 *      funden partes de la tela que no están conectadas (p. ej. delantero y trasero de una falda);
 *   3. los fragmentos minúsculos se fusionan con el vecino conexo más grande.
 * Después, para cada vértice de render se precalculan K partículas vecinas (de su cluster y los
 * adyacentes) con pesos de soporte compacto: `out = skinned + Σ w_k · (x_k − tgt_k)`.
 */

export const K_NEIGHBORS = 3;
/** distancia máxima de seguridad al estado skinneado (m) aunque el generador pida más */
export const MAX_LEASH = 1.0;
const COORD_LIMIT = 1e5;
/** tope de partículas (los índices de partícula son uint16) */
const MAX_PARTICLES = 65535;

export interface ProxyData {
  readonly vertexCount: number;
  readonly particleCount: number;
  /** cluster de cada vértice (orden original) */
  readonly clusterOf: Uint16Array;
  /** vértices ordenados por cluster; `memberStart[p]..memberStart[p+1]` indexa `memberIdx` */
  readonly memberStart: Uint32Array;
  readonly memberIdx: Uint32Array;
  /** posiciones de reposo del mallado de render (copia) */
  readonly restPositions: Float32Array;
  /** centroide de reposo de cada partícula (xyz) */
  readonly restPos: Float32Array;
  readonly invMass: Float32Array;
  /** distancia máxima media de los miembros (m); 0 = anclada */
  readonly maxDist: Float32Array;
  /** distancia máxima más grande entre los miembros (m): cota del desplazamiento de cualquier vértice del cluster */
  readonly maxLeash: Float32Array;
  /** aristas estructurales entre partículas */
  readonly edgeA: Uint16Array;
  readonly edgeB: Uint16Array;
  readonly edgeInvRest: Float32Array;
  /** pares de flexión (opuestos a través de una partícula, casi alineados en reposo) */
  readonly bendA: Uint16Array;
  readonly bendB: Uint16Array;
  readonly bendInvRest: Float32Array;
  /** vecindad de partículas (CSR) para cotas locales */
  readonly adjStart: Uint32Array;
  readonly adj: Uint16Array;
  /** interpolación en ORDEN DE MIEMBROS: posición k de `memberIdx` */
  readonly nbrIdx: Uint16Array;
  readonly nbrW: Float32Array;
  /** distancia máxima efectiva (correa) por vértice, en orden de miembros */
  readonly leashSorted: Float32Array;
}

const nextPow2 = (x: number): number => {
  let p = 1;
  while (p < x) p <<= 1;
  return p;
};

/** Sanea masa inversa y distancia máxima por vértice → "correa" efectiva (0 = rígido/anclado). */
export function sanitizeLeash(
  maxDistance: Float32Array,
  invMass: Float32Array,
): { leash: Float32Array; invM: Float32Array } {
  const n = maxDistance.length;
  const leash = new Float32Array(n);
  const invM = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    const im = invMass[v]!;
    const md = maxDistance[v]!;
    const m = Number.isFinite(im) && im > 0 ? Math.min(im, 1e3) : 0;
    invM[v] = m;
    let l = 0;
    if (m > 0) {
      if (md === Infinity) l = MAX_LEASH;
      else if (Number.isFinite(md) && md > 0) l = Math.min(md, MAX_LEASH);
    }
    leash[v] = l;
  }
  return { leash, invM };
}

interface Clusters {
  readonly clusterOf: Uint32Array;
  readonly count: number;
}

function clusterVertices(
  n: number,
  pos: Float32Array,
  tris: Uint32Array,
  dom: Uint8Array,
  target: number,
): Clusters {
  const clusterOf = new Uint32Array(n);
  if (n <= target) {
    for (let v = 0; v < n; v++) clusterOf[v] = v;
    return { clusterOf, count: n };
  }
  let minx = Infinity,
    miny = Infinity,
    minz = Infinity,
    maxx = -Infinity,
    maxy = -Infinity,
    maxz = -Infinity;
  for (let v = 0; v < n; v++) {
    const x = pos[v * 3]!,
      y = pos[v * 3 + 1]!,
      z = pos[v * 3 + 2]!;
    if (x < minx) minx = x;
    if (x > maxx) maxx = x;
    if (y < miny) miny = y;
    if (y > maxy) maxy = y;
    if (z < minz) minz = z;
    if (z > maxz) maxz = z;
  }
  let area = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t]! * 3,
      b = tris[t + 1]! * 3,
      c = tris[t + 2]! * 3;
    const e1x = pos[b]! - pos[a]!,
      e1y = pos[b + 1]! - pos[a + 1]!,
      e1z = pos[b + 2]! - pos[a + 2]!;
    const e2x = pos[c]! - pos[a]!,
      e2y = pos[c + 1]! - pos[a + 1]!,
      e2z = pos[c + 2]! - pos[a + 2]!;
    area += 0.5 * Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
  }
  const extent = Math.max(maxx - minx, maxy - miny, maxz - minz, 1e-3);
  let h = area > 1e-9 ? Math.sqrt(area / target) * 1.2 : extent / Math.cbrt(target);
  h = Math.max(h, extent / 1000, 1e-4);

  const slot = new Int32Array(n);
  const parent = new Int32Array(n);
  const label = new Int32Array(n);
  const tableSize = nextPow2(n * 2 + 16);
  const mask = tableSize - 1;
  const keys = new Float64Array(tableSize);
  const vals = new Int32Array(tableSize);

  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };

  let result: Clusters | null = null;
  for (let attempt = 0; attempt < 24; attempt++) {
    keys.fill(-1);
    const inv = 1 / h;
    let nSlots = 0;
    for (let v = 0; v < n; v++) {
      let ix = Math.floor((pos[v * 3]! - minx) * inv);
      let iy = Math.floor((pos[v * 3 + 1]! - miny) * inv);
      let iz = Math.floor((pos[v * 3 + 2]! - minz) * inv);
      ix = ix < 0 ? 0 : ix > 1023 ? 1023 : ix;
      iy = iy < 0 ? 0 : iy > 1023 ? 1023 : iy;
      iz = iz < 0 ? 0 : iz > 1023 ? 1023 : iz;
      const d = dom[v]!;
      const key = ((ix * 1024 + iy) * 1024 + iz) * 32 + d;
      let hi =
        (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791) ^ Math.imul(d, 40503)) &
        mask;
      while (keys[hi] !== -1 && keys[hi] !== key) hi = (hi + 1) & mask;
      if (keys[hi] === -1) {
        keys[hi] = key;
        vals[hi] = nSlots++;
      }
      slot[v] = vals[hi]!;
    }
    // componentes conexos dentro de cada celda
    for (let v = 0; v < n; v++) parent[v] = v;
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t]!,
        b = tris[t + 1]!,
        c = tris[t + 2]!;
      if (slot[a] === slot[b]) {
        const ra = find(a),
          rb = find(b);
        if (ra !== rb) parent[ra] = rb;
      }
      if (slot[b] === slot[c]) {
        const rb = find(b),
          rc = find(c);
        if (rb !== rc) parent[rb] = rc;
      }
      if (slot[c] === slot[a]) {
        const rc = find(c),
          ra = find(a);
        if (rc !== ra) parent[rc] = ra;
      }
    }
    label.fill(-1);
    let count = 0;
    for (let v = 0; v < n; v++) {
      const r = find(v);
      if (label[r]! < 0) label[r] = count++;
      clusterOf[v] = label[r]!;
    }

    // fusiona fragmentos minúsculos con su vecino conexo más grande
    const size = new Int32Array(count);
    for (let v = 0; v < n; v++) size[clusterOf[v]!] = size[clusterOf[v]!]! + 1;
    const minSize = Math.max(2, Math.floor((n / count) * 0.12));
    const bestNb = new Int32Array(count).fill(-1);
    const bestSz = new Int32Array(count);
    let anySmall = false;
    for (let c = 0; c < count; c++) if (size[c]! < minSize) anySmall = true;
    if (anySmall) {
      const consider = (ca: number, cb: number): void => {
        if (ca !== cb && size[ca]! < minSize && size[cb]! > bestSz[ca]!) {
          bestNb[ca] = cb;
          bestSz[ca] = size[cb]!;
        }
      };
      for (let t = 0; t < tris.length; t += 3) {
        const ca = clusterOf[tris[t]!]!,
          cb = clusterOf[tris[t + 1]!]!,
          cc = clusterOf[tris[t + 2]!]!;
        consider(ca, cb);
        consider(cb, ca);
        consider(cb, cc);
        consider(cc, cb);
        consider(cc, ca);
        consider(ca, cc);
      }
      const cp = new Int32Array(count);
      for (let c = 0; c < count; c++) cp[c] = c;
      const cfind = (x: number): number => {
        while (cp[x] !== x) {
          cp[x] = cp[cp[x]!]!;
          x = cp[x]!;
        }
        return x;
      };
      for (let c = 0; c < count; c++) {
        const nb = bestNb[c]!;
        if (nb >= 0) {
          const ra = cfind(c),
            rb = cfind(nb);
          if (ra !== rb) cp[ra] = rb;
        }
      }
      const relabel = new Int32Array(count).fill(-1);
      let newCount = 0;
      for (let c = 0; c < count; c++) {
        const r = cfind(c);
        if (relabel[r]! < 0) relabel[r] = newCount++;
      }
      for (let v = 0; v < n; v++) clusterOf[v] = relabel[cfind(clusterOf[v]!)]!;
      count = newCount;
    }

    result = { clusterOf, count };
    if (count <= target) break;
    h *= Math.min(2, Math.max(1.08, Math.sqrt(count / target) * 1.05));
  }
  return result!;
}

export function buildProxy(geometry: GarmentGeometry, budgetIn: number): ProxyData {
  const mesh = geometry.mesh;
  const pos = mesh.positions;
  if (pos.length % 3 !== 0) throw new ClothSolverError('positions.length no es múltiplo de 3');
  const n = pos.length / 3;
  const cloth = geometry.cloth;
  if (cloth.maxDistance.length !== n || cloth.invMass.length !== n) {
    throw new ClothSolverError(
      `cloth.maxDistance/invMass (${cloth.maxDistance.length}/${cloth.invMass.length}) no coinciden con ${n} vértices`,
    );
  }
  for (let i = 0; i < pos.length; i++) {
    if (!(Math.abs(pos[i]!) < COORD_LIMIT)) {
      throw new ClothSolverError(`posición de reposo no finita o fuera de rango en el índice ${i}`);
    }
  }
  const budget = Math.max(4, Math.min(MAX_PARTICLES, Math.floor(budgetIn)));

  // triángulos válidos (índices en rango y no degenerados por repetición)
  const idx = mesh.indices;
  const triCount = Math.floor(idx.length / 3);
  let validTris = 0;
  const trisTmp = new Uint32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const a = idx[t * 3]!,
      b = idx[t * 3 + 1]!,
      c = idx[t * 3 + 2]!;
    if (a >= n || b >= n || c >= n || a === b || b === c || a === c) continue;
    trisTmp[validTris * 3] = a;
    trisTmp[validTris * 3 + 1] = b;
    trisTmp[validTris * 3 + 2] = c;
    validTris++;
  }
  const tris = trisTmp.subarray(0, validTris * 3);

  // hueso dominante por vértice
  const dom = new Uint8Array(n);
  const si = (mesh as { skinIndices?: Uint16Array }).skinIndices;
  const sw = (mesh as { skinWeights?: Float32Array }).skinWeights;
  if (si && sw && si.length === n * 4 && sw.length === n * 4) {
    for (let v = 0; v < n; v++) {
      let best = 0;
      let bw = -1;
      for (let k = 0; k < 4; k++) {
        const w = sw[v * 4 + k]!;
        if (w > bw) {
          bw = w;
          best = si[v * 4 + k]!;
        }
      }
      dom[v] = best & 31;
    }
  }

  const { leash, invM } = sanitizeLeash(cloth.maxDistance, cloth.invMass);
  const { clusterOf: clu32, count: P } = clusterVertices(n, pos, tris, dom, budget);
  if (P > MAX_PARTICLES) throw new ClothSolverError(`demasiadas partículas (${P})`);
  const clusterOf = new Uint16Array(n);
  for (let v = 0; v < n; v++) clusterOf[v] = clu32[v]!;

  // miembros (CSR)
  const memberStart = new Uint32Array(P + 1);
  for (let v = 0; v < n; v++) memberStart[clusterOf[v]! + 1] = memberStart[clusterOf[v]! + 1]! + 1;
  for (let p = 0; p < P; p++) memberStart[p + 1] = memberStart[p + 1]! + memberStart[p]!;
  const memberIdx = new Uint32Array(n);
  const fillPos = memberStart.slice(0, P);
  for (let v = 0; v < n; v++) {
    const c = clusterOf[v]!;
    memberIdx[fillPos[c]!] = v;
    fillPos[c] = fillPos[c]! + 1;
  }

  // centroides, masa inversa y distancia máxima por partícula
  const restPos = new Float32Array(P * 3);
  const invMass = new Float32Array(P);
  const maxDist = new Float32Array(P);
  const maxLeash = new Float32Array(P);
  for (let p = 0; p < P; p++) {
    const s = memberStart[p]!,
      e = memberStart[p + 1]!;
    let x = 0,
      y = 0,
      z = 0,
      m = 0,
      l = 0;
    for (let k = s; k < e; k++) {
      const v = memberIdx[k]!;
      x += pos[v * 3]!;
      y += pos[v * 3 + 1]!;
      z += pos[v * 3 + 2]!;
      m += invM[v]!;
      l += leash[v]!;
      if (leash[v]! > maxLeash[p]!) maxLeash[p] = leash[v]!;
    }
    const cnt = Math.max(1, e - s);
    restPos[p * 3] = x / cnt;
    restPos[p * 3 + 1] = y / cnt;
    restPos[p * 3 + 2] = z / cnt;
    m /= cnt;
    l /= cnt;
    // un cluster casi rígido se ancla: no se simula
    if (l < 5e-4 || m < 1e-6) {
      invMass[p] = 0;
      maxDist[p] = 0;
    } else {
      invMass[p] = m;
      maxDist[p] = l;
    }
  }

  // aristas únicas entre clusters
  let cross = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const ca = clusterOf[tris[t]!]!,
      cb = clusterOf[tris[t + 1]!]!,
      cc = clusterOf[tris[t + 2]!]!;
    if (ca !== cb) cross++;
    if (cb !== cc) cross++;
    if (cc !== ca) cross++;
  }
  const keysE = new Float64Array(cross);
  let ke = 0;
  const pushKey = (a: number, b: number): void => {
    if (a === b) return;
    keysE[ke++] = a < b ? a * P + b : b * P + a;
  };
  for (let t = 0; t < tris.length; t += 3) {
    const ca = clusterOf[tris[t]!]!,
      cb = clusterOf[tris[t + 1]!]!,
      cc = clusterOf[tris[t + 2]!]!;
    pushKey(ca, cb);
    pushKey(cb, cc);
    pushKey(cc, ca);
  }
  keysE.sort();
  const eA: number[] = [];
  const eB: number[] = [];
  const eInv: number[] = [];
  let last = -1;
  for (let i = 0; i < ke; i++) {
    const key = keysE[i]!;
    if (key === last) continue;
    last = key;
    const a = Math.floor(key / P);
    const b = key - a * P;
    const d = Math.hypot(
      restPos[a * 3]! - restPos[b * 3]!,
      restPos[a * 3 + 1]! - restPos[b * 3 + 1]!,
      restPos[a * 3 + 2]! - restPos[b * 3 + 2]!,
    );
    if (!(d > 1e-6)) continue;
    eA.push(a);
    eB.push(b);
    eInv.push(1 / d);
  }
  const E = eA.length;

  // vecindad CSR
  const adjStart = new Uint32Array(P + 1);
  for (let e = 0; e < E; e++) {
    adjStart[eA[e]! + 1] = adjStart[eA[e]! + 1]! + 1;
    adjStart[eB[e]! + 1] = adjStart[eB[e]! + 1]! + 1;
  }
  for (let p = 0; p < P; p++) adjStart[p + 1] = adjStart[p + 1]! + adjStart[p]!;
  const adj = new Uint16Array(adjStart[P]!);
  const fillA = adjStart.slice(0, P);
  for (let e = 0; e < E; e++) {
    adj[fillA[eA[e]!]!] = eB[e]!;
    fillA[eA[e]!] = fillA[eA[e]!]! + 1;
    adj[fillA[eB[e]!]!] = eA[e]!;
    fillA[eB[e]!] = fillA[eB[e]!]! + 1;
  }

  // flexión: pares de vecinos casi opuestos respecto a una partícula (no adyacentes entre sí)
  const bendKeys: number[] = [];
  const isAdj = (a: number, b: number): boolean => {
    for (let k = adjStart[a]!; k < adjStart[a + 1]!; k++) if (adj[k] === b) return true;
    return false;
  };
  for (let j = 0; j < P; j++) {
    const s = adjStart[j]!,
      e = adjStart[j + 1]!;
    if (e - s < 2 || e - s > 16) continue;
    for (let i1 = s; i1 < e; i1++) {
      const a = adj[i1]!;
      const ax = restPos[a * 3]! - restPos[j * 3]!,
        ay = restPos[a * 3 + 1]! - restPos[j * 3 + 1]!,
        az = restPos[a * 3 + 2]! - restPos[j * 3 + 2]!;
      const la = Math.hypot(ax, ay, az);
      for (let i2 = i1 + 1; i2 < e; i2++) {
        const b = adj[i2]!;
        const bx = restPos[b * 3]! - restPos[j * 3]!,
          by = restPos[b * 3 + 1]! - restPos[j * 3 + 1]!,
          bz = restPos[b * 3 + 2]! - restPos[j * 3 + 2]!;
        const lb = Math.hypot(bx, by, bz);
        if (!(la > 1e-6 && lb > 1e-6)) continue;
        const cos = (ax * bx + ay * by + az * bz) / (la * lb);
        if (cos < -0.72 && !isAdj(a, b)) bendKeys.push(a < b ? a * P + b : b * P + a);
      }
    }
  }
  bendKeys.sort((x, y) => x - y);
  const bA: number[] = [];
  const bB: number[] = [];
  const bInv: number[] = [];
  last = -1;
  for (const key of bendKeys) {
    if (key === last) continue;
    last = key;
    const a = Math.floor(key / P);
    const b = key - a * P;
    const d = Math.hypot(
      restPos[a * 3]! - restPos[b * 3]!,
      restPos[a * 3 + 1]! - restPos[b * 3 + 1]!,
      restPos[a * 3 + 2]! - restPos[b * 3 + 2]!,
    );
    if (!(d > 1e-6)) continue;
    bA.push(a);
    bB.push(b);
    bInv.push(1 / d);
  }

  // interpolación al mallado de render (en orden de miembros)
  const K = K_NEIGHBORS;
  const nbrIdx = new Uint16Array(n * K);
  const nbrW = new Float32Array(n * K);
  const leashSorted = new Float32Array(n);
  const bd = new Float64Array(K + 1);
  const bi = new Int32Array(K + 1);
  const consider = (cnt: number, d: number, p: number): number => {
    if (cnt < K + 1) {
      let j = cnt;
      while (j > 0 && bd[j - 1]! > d) {
        bd[j] = bd[j - 1]!;
        bi[j] = bi[j - 1]!;
        j--;
      }
      bd[j] = d;
      bi[j] = p;
      return cnt + 1;
    }
    if (d >= bd[K]!) return cnt;
    let j = K;
    while (j > 0 && bd[j - 1]! > d) {
      bd[j] = bd[j - 1]!;
      bi[j] = bi[j - 1]!;
      j--;
    }
    bd[j] = d;
    bi[j] = p;
    return cnt;
  };
  const EPS = 1e-3;
  for (let k = 0; k < n; k++) {
    const v = memberIdx[k]!;
    leashSorted[k] = leash[v]!;
    const c0 = clusterOf[v]!;
    const px = pos[v * 3]!,
      py = pos[v * 3 + 1]!,
      pz = pos[v * 3 + 2]!;
    let cnt = 0;
    cnt = consider(
      cnt,
      Math.hypot(px - restPos[c0 * 3]!, py - restPos[c0 * 3 + 1]!, pz - restPos[c0 * 3 + 2]!),
      c0,
    );
    const s = adjStart[c0]!,
      e = Math.min(adjStart[c0 + 1]!, s + 63);
    for (let i = s; i < e; i++) {
      const q = adj[i]!;
      cnt = consider(
        cnt,
        Math.hypot(px - restPos[q * 3]!, py - restPos[q * 3 + 1]!, pz - restPos[q * 3 + 2]!),
        q,
      );
    }
    const use = Math.min(cnt, K);
    const dref = cnt >= K + 1 ? bd[K]! : bd[cnt - 1]! * 1.7 + 1e-3;
    let sum = 0;
    for (let i = 0; i < use; i++) {
      const w = Math.max(0, 1 / (bd[i]! + EPS) - 1 / (dref + EPS));
      nbrW[k * K + i] = w;
      sum += w;
    }
    if (!(sum > 1e-12)) {
      nbrW[k * K] = 1;
      for (let i = 1; i < use; i++) nbrW[k * K + i] = 0;
      sum = 1;
    }
    for (let i = 0; i < K; i++) {
      if (i < use) {
        nbrIdx[k * K + i] = bi[i]!;
        nbrW[k * K + i] = nbrW[k * K + i]! / sum;
      } else {
        nbrIdx[k * K + i] = bi[0]!;
        nbrW[k * K + i] = 0;
      }
    }
  }

  return {
    vertexCount: n,
    particleCount: P,
    clusterOf,
    memberStart,
    memberIdx,
    restPositions: Float32Array.from(pos),
    restPos,
    invMass,
    maxDist,
    maxLeash,
    edgeA: Uint16Array.from(eA),
    edgeB: Uint16Array.from(eB),
    edgeInvRest: Float32Array.from(eInv),
    bendA: Uint16Array.from(bA),
    bendB: Uint16Array.from(bB),
    bendInvRest: Float32Array.from(bInv),
    adjStart,
    adj,
    nbrIdx,
    nbrW,
    leashSorted,
  };
}
