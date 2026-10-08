import { describe, expect, it } from 'vitest';
import { REFERENCE_MEASUREMENTS } from '@fitroom/shared';
import { analyzeTopology, repairLabeling } from './meshops.js';
import { sampleField, surfaceNets, type GridSpec, type SampledGrid } from './surface.js';
import { buildField } from './field.js';
import { deriveDims, UNIT_CALIBRATION } from './dims.js';
import { gridSpecFor } from './build.js';

/** Esfera analítica muestreada en TODA la rejilla (bloques de 2×2×2 que la cubren por completo). */
export function sampleSphereGrid(spec: GridSpec, radius: number): SampledGrid {
  const { nx, ny, nz, ox, oy, oz, h } = spec;
  const F = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++)
        F[i + nx * (j + ny * k)] = Math.hypot(ox + i * h, oy + j * h, oz + k * h) - radius;
  const blocks: number[] = [];
  for (let k = 0; k < nz - 1; k += 2) for (let j = 0; j < ny - 1; j += 2) for (let i = 0; i < nx - 1; i += 2) blocks.push(i, j, k);
  return { F, blocks: Int32Array.from(blocks) };
}

describe('surfaceNets', () => {
  const spec: GridSpec = { ox: -0.55, oy: -0.55, oz: -0.55, h: 0.05, nx: 23, ny: 23, nz: 23 };
  it('una esfera da una malla cerrada con vértices sobre la superficie y normales hacia fuera', () => {
    const grid = sampleSphereGrid(spec, 0.4);
    repairLabeling(spec, grid);
    const m = surfaceNets(spec, grid);
    const n = m.positions.length / 3;
    const topo = analyzeTopology(n, m.indices);
    expect(topo).toMatchObject({ badEdges: 0, inconsistentEdges: 0, nonManifoldVertices: 0, components: 1, euler: 2 });
    for (let i = 0; i < n; i++) {
      const r = Math.hypot(m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!);
      expect(Math.abs(r - 0.4)).toBeLessThan(0.05);
    }
    // volumen firmado positivo ≈ 4/3 π r³
    let vol = 0;
    const P = m.positions;
    for (let t = 0; t < m.indices.length; t += 3) {
      const a = m.indices[t]! * 3;
      const b = m.indices[t + 1]! * 3;
      const c = m.indices[t + 2]! * 3;
      vol += (P[a]! * (P[b + 1]! * P[c + 2]! - P[b + 2]! * P[c + 1]!) - P[a + 1]! * (P[b]! * P[c + 2]! - P[b + 2]! * P[c]!) + P[a + 2]! * (P[b]! * P[c + 1]! - P[b + 1]! * P[c]!)) / 6;
    }
    expect(vol).toBeGreaterThan(0.25);
    expect(Math.abs(vol - (4 / 3) * Math.PI * 0.4 ** 3)).toBeLessThan(0.02);
  });

  it('es determinista', () => {
    const a = surfaceNets(spec, sampleSphereGrid(spec, 0.37));
    const b = surfaceNets(spec, sampleSphereGrid(spec, 0.37));
    expect(Buffer.from(a.positions.buffer).equals(Buffer.from(b.positions.buffer))).toBe(true);
    expect(Buffer.from(a.indices.buffer).equals(Buffer.from(b.indices.buffer))).toBe(true);
  });
});

describe('sampleField (muestreo jerárquico)', () => {
  it('cubre todas las celdas con cambio de signo y coincide con la evaluación directa', () => {
    const dims = deriveDims(REFERENCE_MEASUREMENTS.adultB);
    const field = buildField(dims, UNIT_CALIBRATION);
    const spec = gridSpecFor(field, 0.03);
    const grid = sampleField(spec, field);
    const { nx, ny, nz, ox, oy, oz, h } = spec;
    // celdas cubiertas
    const covered = new Set<number>();
    for (let b = 0; b < grid.blocks.length; b += 3)
      for (let d = 0; d < 8; d++)
        covered.add(
          grid.blocks[b]! + (d & 1) + (nx - 1) * (grid.blocks[b + 1]! + ((d >> 1) & 1) + (ny - 1) * (grid.blocks[b + 2]! + ((d >> 2) & 1))),
        );
    let mixed = 0;
    let uncovered = 0;
    const val = (i: number, j: number, k: number): number => field.value(ox + i * h, oy + j * h, oz + k * h);
    for (let k = 0; k < nz - 1; k++)
      for (let j = 0; j < ny - 1; j++)
        for (let i = 0; i < nx - 1; i++) {
          // sólo las celdas de la envolvente próxima al cuerpo: evaluar directo es caro, así que se filtra por caja
          let neg = 0;
          for (let d = 0; d < 8; d++) if (val(i + (d & 1), j + ((d >> 1) & 1), k + ((d >> 2) & 1)) < 0) neg++;
          if (neg > 0 && neg < 8) {
            mixed++;
            if (!covered.has(i + (nx - 1) * (j + (ny - 1) * k))) uncovered++;
          }
        }
    expect(mixed).toBeGreaterThan(500);
    expect(uncovered).toBe(0);
    // valores evaluados == evaluación directa
    let checked = 0;
    for (let b = 0; b < grid.blocks.length && checked < 400; b += 30) {
      const i = grid.blocks[b]!;
      const j = grid.blocks[b + 1]!;
      const k = grid.blocks[b + 2]!;
      const got = grid.F[i + nx * (j + ny * k)]!;
      const want = val(i, j, k);
      // cerca de la superficie coinciden; lejos (fuera de las cajas de las primitivas) sólo coincide el signo
      if (Math.abs(want) < 0.1) expect(got).toBeCloseTo(want, 4);
      else expect(Math.sign(got)).toBe(Math.sign(want));
      checked++;
    }
    expect(Number.isNaN(grid.F[0]!)).toBe(true); // nodos lejanos no se evalúan
  });
});
