import { type BodyModel, type GarmentGeometry } from '@fitroom/shared';
import { getBodyField } from './core/bodyField.js';
import { closestOnMesh, newClosest } from './core/triIndex.js';
import type { GarmentGeometryEx } from './generate.js';

export interface QualityStats {
  /** fracción de triángulos con calidad radio-aristas ínfima (q = 4√3·A / Σl² < 0.05) */
  sliverFraction: number;
  /** calidad media (1 = equilátero) */
  meanQuality: number;
  /** percentil 5 de calidad */
  p05Quality: number;
  /** relación longitud máx / mín de arista, percentil 95 */
  aspectP95: number;
}

export interface UvStats {
  /** anisotropía √(σmax/σmin) de la parametrización UV→3D (1 = isométrica) */
  p50: number;
  p95: number;
  max: number;
  /** fracción de triángulos con anisotropía > 2 */
  fractionOver2: number;
  /** escala media (m de superficie por unidad UV); ≈ 1 si uvMetersPerTile = 1 */
  meanScale: number;
  /** fracción de triángulos UV con orientación invertida (plegados) */
  flippedFraction: number;
}

export interface PenetrationStats {
  /** % de vértices a menos de `threshold` de la piel (o dentro) */
  percent: number;
  threshold: number;
  minDistance: number;
  /** distancia exacta con signo media de todos los vértices (m): holgura media */
  meanDistance: number;
}

export interface GarmentMetrics {
  triangles: number;
  vertices: number;
  penetration: PenetrationStats;
  quality: QualityStats;
  uv: UvStats;
  /** holgura (cm) respecto al cuerpo: media/mín/máx por zona anatómica de la prenda */
  ease: Record<string, { meanCm: number; minCm: number; maxCm: number; count: number }>;
  /** medidas de la PRENDA (cm), obtenidas por corte de plano / puntos de referencia (si existen) */
  measures: Record<string, number>;
}

/** Percentil de un array ordenado. */
function pct(sorted: Float64Array | number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[i]!;
}

export function meshQuality(positions: Float32Array, indices: Uint32Array): QualityStats {
  const nt = indices.length / 3;
  const q = new Float64Array(nt);
  const aspect = new Float64Array(nt);
  let sliver = 0;
  let sum = 0;
  for (let t = 0; t < nt; t++) {
    const a = indices[t * 3]! * 3,
      b = indices[t * 3 + 1]! * 3,
      c = indices[t * 3 + 2]! * 3;
    const e1 = Math.hypot(positions[b]! - positions[a]!, positions[b + 1]! - positions[a + 1]!, positions[b + 2]! - positions[a + 2]!);
    const e2 = Math.hypot(positions[c]! - positions[b]!, positions[c + 1]! - positions[b + 1]!, positions[c + 2]! - positions[b + 2]!);
    const e3 = Math.hypot(positions[a]! - positions[c]!, positions[a + 1]! - positions[c + 1]!, positions[a + 2]! - positions[c + 2]!);
    const ux = positions[b]! - positions[a]!,
      uy = positions[b + 1]! - positions[a + 1]!,
      uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!,
      vy = positions[c + 1]! - positions[a + 1]!,
      vz = positions[c + 2]! - positions[a + 2]!;
    const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    const l2 = e1 * e1 + e2 * e2 + e3 * e3;
    q[t] = l2 > 0 ? (4 * Math.sqrt(3) * area) / l2 : 0;
    aspect[t] = Math.max(e1, e2, e3) / Math.max(1e-9, Math.min(e1, e2, e3));
    if (q[t]! < 0.05) sliver++;
    sum += q[t]!;
  }
  const qs = Float64Array.from(q).sort();
  const as = Float64Array.from(aspect).sort();
  return {
    sliverFraction: nt ? sliver / nt : 0,
    meanQuality: nt ? sum / nt : 0,
    p05Quality: pct(qs, 0.05),
    aspectP95: pct(as, 0.95),
  };
}

/** Estiramiento UV por triángulo: valores singulares del jacobiano (UV → 3D). */
export function uvStats(positions: Float32Array, uvs: Float32Array, indices: Uint32Array): UvStats {
  const nt = indices.length / 3;
  const aniso = new Float64Array(nt);
  let over2 = 0;
  let flipped = 0;
  let scaleSum = 0;
  let counted = 0;
  for (let t = 0; t < nt; t++) {
    const ia = indices[t * 3]!,
      ib = indices[t * 3 + 1]!,
      ic = indices[t * 3 + 2]!;
    const du1 = uvs[ib * 2]! - uvs[ia * 2]!,
      dv1 = uvs[ib * 2 + 1]! - uvs[ia * 2 + 1]!;
    const du2 = uvs[ic * 2]! - uvs[ia * 2]!,
      dv2 = uvs[ic * 2 + 1]! - uvs[ia * 2 + 1]!;
    const det = du1 * dv2 - du2 * dv1;
    const p1 = [positions[ib * 3]! - positions[ia * 3]!, positions[ib * 3 + 1]! - positions[ia * 3 + 1]!, positions[ib * 3 + 2]! - positions[ia * 3 + 2]!];
    const p2 = [positions[ic * 3]! - positions[ia * 3]!, positions[ic * 3 + 1]! - positions[ia * 3 + 1]!, positions[ic * 3 + 2]! - positions[ia * 3 + 2]!];
    const area3 = 0.5 * Math.hypot(p1[1]! * p2[2]! - p1[2]! * p2[1]!, p1[2]! * p2[0]! - p1[0]! * p2[2]!, p1[0]! * p2[1]! - p1[1]! * p2[0]!);
    if (Math.abs(det) < 1e-14 || area3 < 1e-12) {
      aniso[t] = 1;
      continue;
    }
    // Ps = (p1*dv2 - p2*dv1)/det ; Pt = (p2*du1 - p1*du2)/det
    const sx = (p1[0]! * dv2 - p2[0]! * dv1) / det,
      sy = (p1[1]! * dv2 - p2[1]! * dv1) / det,
      sz = (p1[2]! * dv2 - p2[2]! * dv1) / det;
    const tx = (p2[0]! * du1 - p1[0]! * du2) / det,
      ty = (p2[1]! * du1 - p1[1]! * du2) / det,
      tz = (p2[2]! * du1 - p1[2]! * du2) / det;
    const a = sx * sx + sy * sy + sz * sz;
    const b = sx * tx + sy * ty + sz * tz;
    const c = tx * tx + ty * ty + tz * tz;
    const tr = a + c;
    const disc = Math.sqrt(Math.max(0, (a - c) * (a - c) + 4 * b * b));
    const l1 = 0.5 * (tr + disc),
      l2 = Math.max(1e-18, 0.5 * (tr - disc));
    aniso[t] = Math.sqrt(l1 / l2);
    if (aniso[t]! > 2) over2++;
    scaleSum += Math.sqrt(l1 * l2);
    counted++;
    // los triángulos salen con orientación exterior CCW: un mapa UV sin espejo tiene det > 0
    if (det < 0) flipped++;
  }
  const s = Float64Array.from(aniso).sort();
  const flippedFraction = nt ? flipped / nt : 0;
  return {
    p50: pct(s, 0.5),
    p95: pct(s, 0.95),
    max: s.length ? s[s.length - 1]! : 1,
    fractionOver2: nt ? over2 / nt : 0,
    meanScale: counted ? scaleSum / counted : 1,
    flippedFraction,
  };
}

/** Distancia exacta con signo de cada vértice de la prenda a la piel (lento: sólo auditoría/tests). */
export function exactVertexDistances(g: GarmentGeometry, body: BodyModel, maxDist = 0.6): Float64Array {
  const f = getBodyField(body);
  const P = g.mesh.positions;
  const n = P.length / 3;
  const out = new Float64Array(n);
  const res = newClosest();
  for (let i = 0; i < n; i++) {
    out[i] = closestOnMesh(f.tris, P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!, maxDist, res).dist;
  }
  return out;
}

export function garmentMetrics(g: GarmentGeometry | GarmentGeometryEx, body: BodyModel): GarmentMetrics {
  const dist = exactVertexDistances(g, body);
  const info = (g as GarmentGeometryEx).info;
  const clearance = info?.clearance ?? 0.0014;
  let bad = 0;
  let minD = Infinity;
  let sum = 0;
  for (let i = 0; i < dist.length; i++) {
    if (dist[i]! < clearance - 2e-4) bad++;
    if (dist[i]! < minD) minD = dist[i]!;
    sum += dist[i]!;
  }
  return {
    triangles: g.mesh.indices.length / 3,
    vertices: g.mesh.positions.length / 3,
    penetration: {
      percent: dist.length ? (100 * bad) / dist.length : 0,
      threshold: clearance,
      minDistance: minD,
      meanDistance: dist.length ? sum / dist.length : 0,
    },
    quality: meshQuality(g.mesh.positions, g.mesh.indices),
    uv: uvStats(g.mesh.positions, g.mesh.uvs, g.mesh.indices),
    ease: {},
    measures: {},
  };
}
