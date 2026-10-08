import { BIG } from './geom.js';

import type { BodyField } from './field.js';

export interface GridSpec {
  /** Origen del primer nodo (m) */
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  /** Paso (m) */
  readonly h: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

export type FieldFn = (x: number, y: number, z: number) => number;

/** Rejilla muestreada: valores del campo y lista de bloques 2×2×2 (esquina mínima) que se evaluaron por completo. */
export interface SampledGrid {
  readonly F: Float32Array;
  /** triples (i, j, k) de la esquina mínima de cada bloque de 2×2×2 celdas evaluado */
  readonly blocks: Int32Array;
}

/**
 * Muestrea el campo en la rejilla de forma jerárquica (bloques de 8 → 4 → 2 celdas). El campo es una cota
 * conservadora de la distancia a la superficie, de modo que un bloque sólo puede contener superficie si el menor
 * |valor| de sus esquinas no supera la semidiagonal del bloque: el resto se descarta sin evaluar su interior.
 * Cada bloque evalúa únicamente las primitivas cuya caja lo corta.
 */
export function* sampleFieldSteps(
  spec: GridSpec,
  field: BodyField,
  margin = 1.2,
): Generator<void, SampledGrid, void> {
  const { nx, ny, nz, ox, oy, oz, h } = spec;
  const sy = nx;
  const sz = nx * ny;
  const F = new Float32Array(nx * ny * nz);
  F.fill(NaN);
  const nPrims = field.prims.length;
  const blocks: number[] = [];
  const half = Math.sqrt(3) / 2;
  // holgura absoluta por el exceso de profundidad que añaden las uniones suaves (≤ k/4)
  const slack = 0.01;
  let counter = 0;

  // lista de primitivas en un pool compartido
  let pool = new Int32Array(1 << 16);
  let poolN = 0;
  const reserve = (n: number): void => {
    if (poolN + n > pool.length) {
      const np = new Int32Array(Math.max(pool.length * 2, poolN + n));
      np.set(pool);
      pool = np;
    }
  };
  const tmp = new Int32Array(nPrims);

  const evalNode = (i: number, j: number, k: number): number => {
    const idx = i + j * sy + k * sz;
    let v = F[idx]!;
    if (v !== v) {
      v = field.valueActive(ox + i * h, oy + j * h, oz + k * h);
      F[idx] = v;
    }
    return v;
  };

  // nivel actual: cuádruples (i, j, k, offsetLista) + recuento
  let cells: number[] = [];
  const S0 = 8;
  for (let k = 0; k < nz - 1; k += S0)
    for (let j = 0; j < ny - 1; j += S0)
      for (let i = 0; i < nx - 1; i += S0) {
        const i1 = Math.min(i + S0, nx - 1);
        const j1 = Math.min(j + S0, ny - 1);
        const k1 = Math.min(k + S0, nz - 1);
        const n = field.activeFor(
          ox + i * h,
          oy + j * h,
          oz + k * h,
          ox + i1 * h,
          oy + j1 * h,
          oz + k1 * h,
          undefined,
          tmp,
        );
        if (n === 0) continue;
        reserve(n);
        pool.set(tmp.subarray(0, n), poolN);
        cells.push(i, j, k, poolN, n);
        poolN += n;
      }
  for (let s = S0; s >= 2; s >>= 1) {
    const next: number[] = [];
    const thr = half * s * h * margin + slack;
    const hs = s >> 1;
    for (let c = 0; c < cells.length; c += 5) {
      if ((++counter & 255) === 0) yield;
      const i0 = cells[c]!;
      const j0 = cells[c + 1]!;
      const k0 = cells[c + 2]!;
      const off = cells[c + 3]!;
      const n = cells[c + 4]!;
      const i1 = Math.min(i0 + s, nx - 1);
      const j1 = Math.min(j0 + s, ny - 1);
      const k1 = Math.min(k0 + s, nz - 1);
      field.setActive(pool, n, off);
      let neg = 0;
      let minAbs = Infinity;
      for (let q = 0; q < 8; q++) {
        const v = evalNode(q & 1 ? i1 : i0, q & 2 ? j1 : j0, q & 4 ? k1 : k0);
        if (v < 0) neg++;
        const a = v < 0 ? -v : v;
        if (a < minAbs) minAbs = a;
      }
      if ((neg === 0 || neg === 8) && minAbs > thr) continue;
      if (s > 2) {
        for (let q = 0; q < 8; q++) {
          const ci = i0 + (q & 1 ? hs : 0);
          const cj = j0 + (q & 2 ? hs : 0);
          const ck = k0 + (q & 4 ? hs : 0);
          if (ci >= nx - 1 || cj >= ny - 1 || ck >= nz - 1) continue;
          // sublista: primitivas de la lista del padre cuya caja corta el hijo
          let cn = 0;
          const x0 = ox + ci * h;
          const y0 = oy + cj * h;
          const z0 = oz + ck * h;
          const x1 = ox + Math.min(ci + hs, nx - 1) * h;
          const y1 = oy + Math.min(cj + hs, ny - 1) * h;
          const z1 = oz + Math.min(ck + hs, nz - 1) * h;
          for (let m = 0; m < n; m++) {
            const pi = pool[off + m]!;
            const b = field.prims[pi]!.box;
            if (x1 >= b[0]! && x0 <= b[3]! && y1 >= b[1]! && y0 <= b[4]! && z1 >= b[2]! && z0 <= b[5]!)
              tmp[cn++] = pi;
          }
          if (cn === 0) continue;
          reserve(cn);
          pool.set(tmp.subarray(0, cn), poolN);
          next.push(ci, cj, ck, poolN, cn);
          poolN += cn;
        }
      } else {
        // bloque final de 2×2×2 celdas: evaluar todos sus nodos
        for (let k = k0; k <= k1; k++)
          for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) evalNode(i, j, k);
        blocks.push(i0, j0, k0);
      }
    }
    cells = next;
  }
  field.setActive(pool, 0, 0);
  return { F, blocks: Int32Array.from(blocks) };
}

export function sampleField(spec: GridSpec, field: BodyField): SampledGrid {
  const g = sampleFieldSteps(spec, field);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

export interface RawMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/**
 * Surface Nets ingenuo sobre los bloques evaluados de una rejilla de campo escalar (negativo = dentro).
 * Triángulos CCW vistos desde fuera. El orden de los vértices sigue el orden de los bloques (determinista).
 */
export function surfaceNets(spec: GridSpec, grid: SampledGrid): RawMesh {
  const { nx, ny, nz, ox, oy, oz, h } = spec;
  const F = grid.F;
  const blocks = grid.blocks;
  const sy = nx;
  const sz = nx * ny;
  const cvx = nx - 1;
  const cvy = ny - 1;
  const cvz = nz - 1;
  const cellVert = new Int32Array(cvx * cvy * cvz).fill(-1);
  let cap = 1 << 16;
  let pos = new Float32Array(cap * 3);
  let nv = 0;
  const corner = new Float64Array(8);
  const offs = [0, 1, sy, 1 + sy, sz, 1 + sz, sy + sz, 1 + sy + sz];
  const EA = [0, 2, 4, 6, 0, 1, 4, 5, 0, 1, 2, 3];
  const EB = [1, 3, 5, 7, 2, 3, 6, 7, 4, 5, 6, 7];
  const cx = [0, 1, 0, 1, 0, 1, 0, 1];
  const cy = [0, 0, 1, 1, 0, 0, 1, 1];
  const cz = [0, 0, 0, 0, 1, 1, 1, 1];
  const nb = blocks.length / 3;
  for (let bq = 0; bq < nb; bq++) {
    const bi = blocks[bq * 3]!;
    const bj = blocks[bq * 3 + 1]!;
    const bk = blocks[bq * 3 + 2]!;
    for (let dk = 0; dk < 2; dk++) {
      const k = bk + dk;
      if (k >= cvz) continue;
      for (let dj = 0; dj < 2; dj++) {
        const j = bj + dj;
        if (j >= cvy) continue;
        for (let di = 0; di < 2; di++) {
          const i = bi + di;
          if (i >= cvx) continue;
          const base = i + j * sy + k * sz;
          let mask = 0;
          for (let c = 0; c < 8; c++) {
            const v = F[base + offs[c]!]!;
            corner[c] = v;
            if (v < 0) mask |= 1 << c;
          }
          if (mask === 0 || mask === 255) continue;
          let sxp = 0;
          let syp = 0;
          let szp = 0;
          let cnt = 0;
          for (let e = 0; e < 12; e++) {
            const a = EA[e]!;
            const b = EB[e]!;
            const va = corner[a]!;
            const vb = corner[b]!;
            if (va < 0 !== vb < 0) {
              const t = va / (va - vb);
              sxp += cx[a]! + (cx[b]! - cx[a]!) * t;
              syp += cy[a]! + (cy[b]! - cy[a]!) * t;
              szp += cz[a]! + (cz[b]! - cz[a]!) * t;
              cnt++;
            }
          }
          if (nv >= cap) {
            cap *= 2;
            const np = new Float32Array(cap * 3);
            np.set(pos);
            pos = np;
          }
          cellVert[i + cvx * (j + cvy * k)] = nv;
          pos[nv * 3] = ox + (i + sxp / cnt) * h;
          pos[nv * 3 + 1] = oy + (j + syp / cnt) * h;
          pos[nv * 3 + 2] = oz + (k + szp / cnt) * h;
          nv++;
        }
      }
    }
  }
  let icap = 1 << 18;
  let idx = new Uint32Array(icap);
  let ni = 0;
  const cv = (i: number, j: number, k: number): number => cellVert[i + cvx * (j + cvy * k)]!;
  const dist2 = (p: number, q: number): number => {
    const dx = pos[p * 3]! - pos[q * 3]!;
    const dy = pos[p * 3 + 1]! - pos[q * 3 + 1]!;
    const dz = pos[p * 3 + 2]! - pos[q * 3 + 2]!;
    return dx * dx + dy * dy + dz * dz;
  };
  const quad = (a: number, b: number, c: number, d: number, flip: boolean): void => {
    if (ni + 6 > icap) {
      icap *= 2;
      const nn = new Uint32Array(icap);
      nn.set(idx);
      idx = nn;
    }
    const useAC = dist2(a, c) <= dist2(b, d);
    if (flip) {
      if (useAC) {
        idx[ni++] = a;
        idx[ni++] = c;
        idx[ni++] = b;
        idx[ni++] = a;
        idx[ni++] = d;
        idx[ni++] = c;
      } else {
        idx[ni++] = a;
        idx[ni++] = d;
        idx[ni++] = b;
        idx[ni++] = b;
        idx[ni++] = d;
        idx[ni++] = c;
      }
    } else if (useAC) {
      idx[ni++] = a;
      idx[ni++] = b;
      idx[ni++] = c;
      idx[ni++] = a;
      idx[ni++] = c;
      idx[ni++] = d;
    } else {
      idx[ni++] = a;
      idx[ni++] = b;
      idx[ni++] = d;
      idx[ni++] = b;
      idx[ni++] = c;
      idx[ni++] = d;
    }
  };
  for (let bq = 0; bq < nb; bq++) {
    const bi = blocks[bq * 3]!;
    const bj = blocks[bq * 3 + 1]!;
    const bk = blocks[bq * 3 + 2]!;
    for (let dk = 0; dk < 2; dk++) {
      const k = bk + dk;
      if (k >= nz - 1) continue;
      for (let dj = 0; dj < 2; dj++) {
        const j = bj + dj;
        if (j >= ny - 1) continue;
        for (let di = 0; di < 2; di++) {
          const i = bi + di;
          if (i >= nx - 1) continue;
          const v0 = F[i + j * sy + k * sz]!;
          // arista x
          if (j >= 1 && k >= 1) {
            const v1 = F[i + 1 + j * sy + k * sz]!;
            if (v0 < 0 !== v1 < 0)
              quad(cv(i, j - 1, k - 1), cv(i, j, k - 1), cv(i, j, k), cv(i, j - 1, k), v0 >= 0);
          }
          // arista y
          if (i >= 1 && k >= 1) {
            const v1 = F[i + (j + 1) * sy + k * sz]!;
            if (v0 < 0 !== v1 < 0)
              quad(cv(i - 1, j, k - 1), cv(i - 1, j, k), cv(i, j, k), cv(i, j, k - 1), v0 >= 0);
          }
          // arista z
          if (i >= 1 && j >= 1) {
            const v1 = F[i + j * sy + (k + 1) * sz]!;
            if (v0 < 0 !== v1 < 0)
              quad(cv(i - 1, j - 1, k), cv(i, j - 1, k), cv(i, j, k), cv(i - 1, j, k), v0 >= 0);
          }
        }
      }
    }
  }
  return { positions: pos.slice(0, nv * 3), indices: idx.slice(0, ni) };
}
