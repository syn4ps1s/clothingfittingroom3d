import {
  J,
  type BodyModel,
  type Vec3,
} from '@fitroom/shared';
import { buildSdfGrid, sampleSdf, sampleSdfGrad, type SdfGrid } from './sdfGrid.js';
import { buildTriIndex, closestOnMesh, newClosest, type ClosestResult, type TriIndex } from './triIndex.js';

/** Puntos de referencia anatómicos medidos sobre la malla REAL del cuerpo (no sólo fórmulas). */
export interface BodyLandmarks {
  /** estatura (m) */
  readonly H: number;
  /** altura del punto más bajo de la entrepierna (m): por debajo las piernas están separadas */
  readonly yCrotch: number;
  /** altura de la axila (m): por debajo hay hueco entre brazo y tronco */
  readonly yPit: number;
  readonly yShoulder: number;
  readonly yNeckBase: number;
  readonly yWaist: number;
  readonly yHip: number;
  readonly yChest: number;
  readonly yKnee: number;
  readonly yAnkle: number;
  /** semi-ancho lateral del tronco bajo la axila (m) */
  readonly torsoHalfWidthAtPit: number;
}

export interface BodyField {
  readonly body: BodyModel;
  readonly sdf: SdfGrid;
  readonly tris: TriIndex;
  readonly lm: BodyLandmarks;
  /** índices de vértices del cuerpo en una rejilla (celdas de 3 cm) para búsquedas de vecinos */
  readonly vertCellStart: Uint32Array;
  readonly vertCellItems: Uint32Array;
  readonly vertGrid: { ox: number; oy: number; oz: number; cell: number; nx: number; ny: number; nz: number };
}

const cache = new WeakMap<BodyModel, BodyField>();

/** Construye (y cachea por instancia) el campo de consulta espacial del cuerpo. Coste único por cuerpo. */
export function getBodyField(body: BodyModel): BodyField {
  const hit = cache.get(body);
  if (hit) return hit;
  const { positions, normals, indices } = body.mesh;
  const sdf = buildSdfGrid(positions, normals, indices, { cell: 0.01, margin: 0.14 });
  const tris = buildTriIndex(positions, normals, indices, 0.03);
  const { vertCellStart, vertCellItems, vertGrid } = buildVertGrid(positions);
  const partial = { body, sdf, tris, vertCellStart, vertCellItems, vertGrid } as Omit<BodyField, 'lm'>;
  const lm = measureLandmarks(partial);
  const f: BodyField = { ...partial, lm };
  cache.set(body, f);
  return f;
}

function buildVertGrid(positions: Float32Array): {
  vertCellStart: Uint32Array;
  vertCellItems: Uint32Array;
  vertGrid: BodyField['vertGrid'];
} {
  const cell = 0.03;
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
  const nx = Math.ceil((maxX - ox) / cell) + 2,
    ny = Math.ceil((maxY - oy) / cell) + 2,
    nz = Math.ceil((maxZ - oz) / cell) + 2;
  const n = positions.length / 3;
  const counts = new Uint32Array(nx * ny * nz + 1);
  const cellOf = new Uint32Array(n);
  for (let v = 0; v < n; v++) {
    const x = Math.floor((positions[v * 3]! - ox) / cell);
    const y = Math.floor((positions[v * 3 + 1]! - oy) / cell);
    const z = Math.floor((positions[v * 3 + 2]! - oz) / cell);
    const c = x + y * nx + z * nx * ny;
    cellOf[v] = c;
    counts[c + 1]!++;
  }
  for (let i = 1; i < counts.length; i++) counts[i] = counts[i]! + counts[i - 1]!;
  const fill = counts.slice();
  const items = new Uint32Array(n);
  for (let v = 0; v < n; v++) items[fill[cellOf[v]!]!++] = v;
  return {
    vertCellStart: counts,
    vertCellItems: items,
    vertGrid: { ox, oy, oz, cell, nx, ny, nz },
  };
}

/** Vértice del cuerpo más cercano a un punto (búsqueda por capas en la rejilla). */
export function nearestBodyVertex(f: BodyField, x: number, y: number, z: number): number {
  const g = f.vertGrid;
  const P = f.body.mesh.positions;
  const cx = Math.floor((x - g.ox) / g.cell),
    cy = Math.floor((y - g.oy) / g.cell),
    cz = Math.floor((z - g.oz) / g.cell);
  let best = Infinity;
  let bi = -1;
  for (let shell = 0; shell < 40; shell++) {
    if (bi >= 0 && (shell - 1) * g.cell > Math.sqrt(best)) break;
    for (let dz = -shell; dz <= shell; dz++)
      for (let dy = -shell; dy <= shell; dy++)
        for (let dx = -shell; dx <= shell; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== shell) continue;
          const ix = cx + dx,
            iy = cy + dy,
            iz = cz + dz;
          if (ix < 0 || iy < 0 || iz < 0 || ix >= g.nx || iy >= g.ny || iz >= g.nz) continue;
          const c = ix + iy * g.nx + iz * g.nx * g.ny;
          for (let k = f.vertCellStart[c]!; k < f.vertCellStart[c + 1]!; k++) {
            const v = f.vertCellItems[k]!;
            const d =
              (P[v * 3]! - x) ** 2 + (P[v * 3 + 1]! - y) ** 2 + (P[v * 3 + 2]! - z) ** 2;
            if (d < best) {
              best = d;
              bi = v;
            }
          }
        }
  }
  return bi;
}

/**
 * Primer cruce dentro→fuera a lo largo de un rayo desde un punto INTERIOR (sphere-tracing con el SDF).
 * Devuelve la distancia t (m) o NaN si no sale en `maxT` (o el origen no está dentro).
 */
export function rayExit(
  g: SdfGrid,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
): number {
  let t = 0;
  let v = sampleSdf(g, ox, oy, oz);
  if (v >= 0) return Number.NaN;
  for (let it = 0; it < 120; it++) {
    const prevT = t;
    // paso conservador (el SDF interior es una cota aproximada): 60 % de la distancia, entre 1.5 y 25 mm
    t += Math.min(0.025, Math.max(-v * 0.6, 0.0015));
    if (t > maxT) return Number.NaN;
    v = sampleSdf(g, ox + dx * t, oy + dy * t, oz + dz * t);
    if (v >= 0) {
      let lo = prevT,
        hi = t;
      for (let k = 0; k < 10; k++) {
        const mid = 0.5 * (lo + hi);
        if (sampleSdf(g, ox + dx * mid, oy + dy * mid, oz + dz * mid) < 0) lo = mid;
        else hi = mid;
      }
      const tx = 0.5 * (lo + hi);
      // la salida debe ser sostenida (descarta anomalías interiores de pocos mm)
      let sustained = true;
      for (let k = 1; k <= 3; k++) {
        if (sampleSdf(g, ox + dx * (tx + 0.004 * k), oy + dy * (tx + 0.004 * k), oz + dz * (tx + 0.004 * k)) < -0.0008) {
          sustained = false;
          break;
        }
      }
      if (sustained) return tx;
      t = tx + 0.013;
      v = sampleSdf(g, ox + dx * t, oy + dy * t, oz + dz * t);
    }
  }
  return Number.NaN;
}

/** Distancia exacta con signo (lenta; para validación/métricas y refinados puntuales). */
export function exactSignedDistance(
  f: BodyField,
  x: number,
  y: number,
  z: number,
  maxDist = 0.5,
  out: ClosestResult = newClosest(),
): number {
  return closestOnMesh(f.tris, x, y, z, maxDist, out).dist;
}

export function sdfAt(f: BodyField, x: number, y: number, z: number): number {
  return sampleSdf(f.sdf, x, y, z);
}

export function sdfGradAt(f: BodyField, x: number, y: number, z: number, grad: Float64Array): number {
  return sampleSdfGrad(f.sdf, x, y, z, grad);
}

function measureLandmarks(f: Omit<BodyField, 'lm'>): BodyLandmarks {
  const sk = f.body.skeleton;
  const H = sk.height;
  const pos = (j: number): Vec3 => sk.joints[j]!.position;
  const g = f.sdf;

  // --- entrepierna: bajando por la línea central x=0 hasta que deja de haber cuerpo ---
  let yCrotch = (pos(J.l_thigh)[1] + pos(J.r_thigh)[1]) / 2 - 0.1 * H;
  {
    const yHip = pos(J.l_thigh)[1];
    let found = false;
    for (let y = yHip + 0.04; y > 0.2 * H; y -= 0.002) {
      let occupied = false;
      for (let z = -0.14; z <= 0.14; z += 0.01) {
        if (sampleSdf(g, 0, y, z) < 0 || sampleSdf(g, 0.004, y, z) < 0) {
          occupied = true;
          break;
        }
      }
      if (!occupied) {
        yCrotch = y + 0.002;
        found = true;
        break;
      }
    }
    if (!found) yCrotch = pos(J.l_thigh)[1] - 0.12 * H;
  }

  // --- axila: primer y (bajando) donde aparece hueco entre el costado del tronco y el brazo ---
  const yShoulder = pos(J.l_upper_arm)[1];
  let yPit = 0.725 * H;
  let torsoHalfWidthAtPit = 0.17;
  {
    let found = false;
    for (let y = yShoulder + 0.01; y > 0.62 * H; y -= 0.002) {
      const zc = 0;
      const x1 = rayExit(g, 0, y, zc, 1, 0, 0, 0.5);
      if (Number.isNaN(x1)) continue;
      // ¿hay hueco (fuera) después del costado? medimos hasta 12 cm más allá
      let gap = false;
      for (let x = x1 + 0.0015; x < x1 + 0.12; x += 0.0015) {
        if (sampleSdf(g, x, y, zc) > 0.004 && sampleSdf(g, x + 0.004, y, zc) > 0.0) {
          // a continuación debe volver a haber cuerpo (brazo), si no es el exterior total
          for (let xx = x; xx < x + 0.2; xx += 0.003) {
            if (sampleSdf(g, xx, y, zc) < 0) {
              gap = true;
              break;
            }
          }
          break;
        }
      }
      if (gap) {
        yPit = y;
        torsoHalfWidthAtPit = x1;
        found = true;
        break;
      }
    }
    if (!found) {
      const x1 = rayExit(g, 0, yPit, 0, 1, 0, 0, 0.5);
      if (!Number.isNaN(x1)) torsoHalfWidthAtPit = x1;
    }
  }
  return {
    H,
    yCrotch,
    yPit,
    yShoulder,
    yNeckBase: pos(J.neck)[1],
    yWaist: 0.62 * H,
    yHip: 0.52 * H,
    yChest: Math.min(0.72 * H, yPit - 0.02),
    yKnee: pos(J.l_calf)[1],
    yAnkle: pos(J.l_foot)[1],
    torsoHalfWidthAtPit,
  };
}

/** k vértices del cuerpo más cercanos (distancias al cuadrado ascendentes en `outD`). Devuelve cuántos encontró. */
export function nearestBodyVertices(
  f: BodyField,
  x: number,
  y: number,
  z: number,
  k: number,
  outIdx: Int32Array,
  outD: Float64Array,
): number {
  const g = f.vertGrid;
  const P = f.body.mesh.positions;
  const cx = Math.floor((x - g.ox) / g.cell),
    cy = Math.floor((y - g.oy) / g.cell),
    cz = Math.floor((z - g.oz) / g.cell);
  let count = 0;
  for (let shell = 0; shell < 40; shell++) {
    if (count >= k && (shell - 1) * g.cell > Math.sqrt(outD[k - 1]!)) break;
    for (let dz = -shell; dz <= shell; dz++)
      for (let dy = -shell; dy <= shell; dy++)
        for (let dx = -shell; dx <= shell; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== shell) continue;
          const ix = cx + dx,
            iy = cy + dy,
            iz = cz + dz;
          if (ix < 0 || iy < 0 || iz < 0 || ix >= g.nx || iy >= g.ny || iz >= g.nz) continue;
          const c = ix + iy * g.nx + iz * g.nx * g.ny;
          for (let q = f.vertCellStart[c]!; q < f.vertCellStart[c + 1]!; q++) {
            const v = f.vertCellItems[q]!;
            const d = (P[v * 3]! - x) ** 2 + (P[v * 3 + 1]! - y) ** 2 + (P[v * 3 + 2]! - z) ** 2;
            if (count < k || d < outD[count - 1]!) {
              // inserción ordenada
              let pos = count < k ? count : k - 1;
              while (pos > 0 && outD[pos - 1]! > d) {
                outD[pos] = outD[pos - 1]!;
                outIdx[pos] = outIdx[pos - 1]!;
                pos--;
              }
              outD[pos] = d;
              outIdx[pos] = v;
              if (count < k) count++;
            }
          }
        }
  }
  return count;
}
