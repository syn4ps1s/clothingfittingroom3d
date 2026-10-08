import { closestPointTriangle } from './geom.js';

/** Índice espacial de triángulos (rejilla uniforme CSR) para consultas exactas de punto más cercano. */
export interface TriIndex {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly cell: number;
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly cellStart: Uint32Array;
  readonly cellTris: Uint32Array;
}

export function buildTriIndex(
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
  cell = 0.03,
): TriIndex {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]!);
    maxX = Math.max(maxX, positions[i]!);
    minY = Math.min(minY, positions[i + 1]!);
    maxY = Math.max(maxY, positions[i + 1]!);
    minZ = Math.min(minZ, positions[i + 2]!);
    maxZ = Math.max(maxZ, positions[i + 2]!);
  }
  const ox = minX - cell,
    oy = minY - cell,
    oz = minZ - cell;
  const nx = Math.ceil((maxX - ox) / cell) + 2;
  const ny = Math.ceil((maxY - oy) / cell) + 2;
  const nz = Math.ceil((maxZ - oz) / cell) + 2;
  const counts = new Uint32Array(nx * ny * nz + 1);
  const nt = indices.length / 3;
  const range = (t: number): [number, number, number, number, number, number] => {
    const a = indices[t * 3]! * 3,
      b = indices[t * 3 + 1]! * 3,
      c = indices[t * 3 + 2]! * 3;
    const lo = (k: number): number => Math.min(positions[a + k]!, positions[b + k]!, positions[c + k]!);
    const hi = (k: number): number => Math.max(positions[a + k]!, positions[b + k]!, positions[c + k]!);
    return [
      Math.floor((lo(0) - ox) / cell),
      Math.floor((lo(1) - oy) / cell),
      Math.floor((lo(2) - oz) / cell),
      Math.floor((hi(0) - ox) / cell),
      Math.floor((hi(1) - oy) / cell),
      Math.floor((hi(2) - oz) / cell),
    ];
  };
  for (let t = 0; t < nt; t++) {
    const [x0, y0, z0, x1, y1, z1] = range(t);
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) counts[x + y * nx + z * nx * ny + 1]!++;
  }
  for (let i = 1; i < counts.length; i++) counts[i] = counts[i]! + counts[i - 1]!;
  const cellStart = counts.slice();
  const fill = counts.slice();
  const cellTris = new Uint32Array(cellStart[cellStart.length - 1]!);
  for (let t = 0; t < nt; t++) {
    const [x0, y0, z0, x1, y1, z1] = range(t);
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const ci = x + y * nx + z * nx * ny;
          cellTris[fill[ci]!++] = t;
        }
  }
  return { positions, normals, indices, cell, ox, oy, oz, nx, ny, nz, cellStart, cellTris };
}

export interface ClosestResult {
  /** distancia con signo (negativa dentro) */
  dist: number;
  tri: number;
  /** punto más cercano */
  x: number;
  y: number;
  z: number;
}

const tmp = new Float64Array(6);

/**
 * Distancia exacta con signo al cuerpo (signo por normal suave interpolada en el punto más cercano).
 * `maxDist` acota la búsqueda: si no hay triángulo más cerca devuelve dist = +maxDist (tri = -1).
 */
export function closestOnMesh(
  idx: TriIndex,
  px: number,
  py: number,
  pz: number,
  maxDist: number,
  out: ClosestResult,
): ClosestResult {
  const { positions: P, normals: N, indices: I, cell } = idx;
  let best = maxDist * maxDist;
  let bestTri = -1;
  let bx = 0,
    by = 0,
    bz = 0,
    bsign = 1;
  const cx = Math.floor((px - idx.ox) / cell);
  const cy = Math.floor((py - idx.oy) / cell);
  const cz = Math.floor((pz - idx.oz) / cell);
  const maxShell = Math.ceil(maxDist / cell) + 1;
  for (let shell = 0; shell <= maxShell; shell++) {
    // una vez hay candidato, sólo las capas que aún pueden contener algo más cerca
    if (bestTri >= 0 && (shell - 1) * cell > Math.sqrt(best)) break;
    for (let dz = -shell; dz <= shell; dz++)
      for (let dy = -shell; dy <= shell; dy++)
        for (let dx = -shell; dx <= shell; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== shell) continue;
          const x = cx + dx,
            y = cy + dy,
            z = cz + dz;
          if (x < 0 || y < 0 || z < 0 || x >= idx.nx || y >= idx.ny || z >= idx.nz) continue;
          const ci = x + y * idx.nx + z * idx.nx * idx.ny;
          for (let k = idx.cellStart[ci]!; k < idx.cellStart[ci + 1]!; k++) {
            const t = idx.cellTris[k]!;
            const a = I[t * 3]! * 3,
              b = I[t * 3 + 1]! * 3,
              c = I[t * 3 + 2]! * 3;
            const d2 = closestPointTriangle(
              px, py, pz,
              P[a]!, P[a + 1]!, P[a + 2]!,
              P[b]!, P[b + 1]!, P[b + 2]!,
              P[c]!, P[c + 1]!, P[c + 2]!,
              tmp,
            );
            if (d2 < best) {
              best = d2;
              bestTri = t;
              bx = tmp[0]!;
              by = tmp[1]!;
              bz = tmp[2]!;
              const u = tmp[3]!,
                v = tmp[4]!,
                w = tmp[5]!;
              const nxs = u * N[a]! + v * N[b]! + w * N[c]!;
              const nys = u * N[a + 1]! + v * N[b + 1]! + w * N[c + 1]!;
              const nzs = u * N[a + 2]! + v * N[b + 2]! + w * N[c + 2]!;
              bsign = (px - bx) * nxs + (py - by) * nys + (pz - bz) * nzs >= 0 ? 1 : -1;
            }
          }
        }
  }
  out.tri = bestTri;
  out.x = bx;
  out.y = by;
  out.z = bz;
  out.dist = bestTri < 0 ? maxDist : bsign * Math.sqrt(best);
  return out;
}

export const newClosest = (): ClosestResult => ({ dist: 0, tri: -1, x: 0, y: 0, z: 0 });
