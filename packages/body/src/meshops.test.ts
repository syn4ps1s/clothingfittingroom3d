import { describe, expect, it } from 'vitest';
import {
  adjacencyIsClosed,
  analyzeTopology,
  buildAdjacency,
  estimateSelfIntersections,
  isClosedOrientedManifold,
  keepLargestComponent,
  repairLabeling,
  taubinSmooth,
} from './meshops.js';
import { sampleSphereGrid } from './surface.test.js';
import { surfaceNets } from './surface.js';

/** Cubo unidad con triángulos CCW desde fuera. */
function cube(ox = 0, oy = 0, oz = 0, s = 1): { positions: Float32Array; indices: Uint32Array } {
  const p: number[] = [];
  for (const z of [0, 1]) for (const y of [0, 1]) for (const x of [0, 1]) p.push(ox + x * s, oy + y * s, oz + z * s);
  // vértices: idx = x + 2y + 4z
  const quads = [
    [0, 2, 3, 1], // z = 0 (normal −z)
    [4, 5, 7, 6], // z = 1
    [0, 1, 5, 4], // y = 0
    [2, 6, 7, 3], // y = 1
    [0, 4, 6, 2], // x = 0
    [1, 3, 7, 5], // x = 1
  ];
  const idx: number[] = [];
  for (const [a, b, c, d] of quads) idx.push(a!, b!, c!, a!, c!, d!);
  return { positions: Float32Array.from(p), indices: Uint32Array.from(idx) };
}

describe('analyzeTopology', () => {
  it('un cubo es cerrado, manifold, 1 componente, Euler 2', () => {
    const c = cube();
    const r = analyzeTopology(8, c.indices);
    expect(r).toMatchObject({ badEdges: 0, boundaryEdges: 0, nonManifoldEdges: 0, inconsistentEdges: 0, nonManifoldVertices: 0, components: 1, euler: 2 });
    expect(isClosedOrientedManifold(8, c.indices)).toBe(true);
  });

  it('detecta bordes abiertos, aristas no manifold y orientación inconsistente', () => {
    const c = cube();
    const open = c.indices.slice(0, c.indices.length - 3);
    expect(analyzeTopology(8, open).boundaryEdges).toBeGreaterThan(0);
    expect(isClosedOrientedManifold(8, open)).toBe(false);
    const flipped = c.indices.slice();
    [flipped[1], flipped[2]] = [flipped[2]!, flipped[1]!];
    expect(analyzeTopology(8, flipped).inconsistentEdges).toBeGreaterThan(0);
    expect(isClosedOrientedManifold(8, flipped)).toBe(false);
    // tres triángulos comparten la arista 0-1
    const fin = Uint32Array.from([...c.indices, 0, 1, 3]);
    expect(analyzeTopology(8, fin).nonManifoldEdges).toBeGreaterThan(0);
  });

  it('detecta vértices pellizcados (dos cubos que comparten un vértice)', () => {
    const a = cube();
    const b = cube(1, 1, 1);
    const idx = Uint32Array.from([...a.indices, ...Array.from(b.indices, (i) => i + 8)]);
    // fusionar el vértice 7 del primero con el 8+0 del segundo (ambos en (1,1,1))
    for (let i = 0; i < idx.length; i++) if (idx[i] === 8) idx[i] = 7;
    const r = analyzeTopology(16, idx);
    expect(r.nonManifoldVertices).toBeGreaterThan(0);
    expect(r.components).toBe(1);
  });

  it('cuenta componentes', () => {
    const a = cube();
    const b = cube(5, 0, 0);
    const idx = Uint32Array.from([...a.indices, ...Array.from(b.indices, (i) => i + 8)]);
    expect(analyzeTopology(16, idx).components).toBe(2);
  });
});

describe('keepLargestComponent y adyacencia', () => {
  it('descarta la componente pequeña y compacta los índices', () => {
    const a = cube(0, 0, 0, 2);
    const b = cube(10, 0, 0, 1);
    const pos = Float32Array.from([...a.positions, ...b.positions]);
    const idx = Uint32Array.from([...a.indices, ...Array.from(b.indices, (i) => i + 8)]);
    // el cubo grande y el pequeño tienen el mismo nº de triángulos: añadimos subdivisión al grande duplicando nada;
    // desempate determinista: gana la raíz menor (el primero)
    const r = keepLargestComponent(pos, idx);
    expect(r.positions.length / 3).toBe(8);
    expect(Math.max(...r.positions)).toBe(2);
    expect(analyzeTopology(8, r.indices).components).toBe(1);
  });

  it('la adyacencia CSR de una malla cerrada tiene una entrada por arista dirigida', () => {
    const c = cube();
    const adj = buildAdjacency(8, c.indices);
    expect(adj.neighbors.length).toBe(c.indices.length); // 36 aristas dirigidas
    expect(adjacencyIsClosed(8, adj)).toBe(true);
  });
});

describe('taubinSmooth', () => {
  it('conserva aproximadamente el radio de una esfera ruidosa (sin encogerla)', () => {
    const spec = { ox: -0.6, oy: -0.6, oz: -0.6, h: 0.04, nx: 31, ny: 31, nz: 31 };
    const grid = sampleSphereGrid(spec, 0.4);
    const raw = surfaceNets(spec, grid);
    const adj = buildAdjacency(raw.positions.length / 3, raw.indices);
    const pos = raw.positions.slice();
    taubinSmooth(pos, adj, 10);
    let rMean = 0;
    for (let i = 0; i < pos.length; i += 3) rMean += Math.hypot(pos[i]!, pos[i + 1]!, pos[i + 2]!);
    rMean /= pos.length / 3;
    expect(rMean).toBeGreaterThan(0.385);
    expect(rMean).toBeLessThan(0.405);
  });
});

describe('repairLabeling', () => {
  it('corrige una cara en tablero y deja una malla manifold', () => {
    // rejilla 5×5×5 con un tablero en la cara z = 2 : nodos (2,2,2) y (3,3,2) dentro, el resto fuera
    const spec = { ox: 0, oy: 0, oz: 0, h: 1, nx: 6, ny: 6, nz: 6 };
    const F = new Float32Array(216).fill(1);
    const at = (i: number, j: number, k: number): number => i + 6 * (j + 6 * k);
    F[at(2, 2, 2)] = -0.6;
    F[at(3, 3, 2)] = -0.4;
    const blocks: number[] = [];
    for (let k = 0; k < 6; k += 2) for (let j = 0; j < 6; j += 2) for (let i = 0; i < 6; i += 2) blocks.push(i, j, k);
    const grid = { F, blocks: Int32Array.from(blocks) };
    const flips = repairLabeling(spec, grid);
    expect(flips).toBeGreaterThan(0);
    const mesh = surfaceNets(spec, grid);
    expect(isClosedOrientedManifold(mesh.positions.length / 3, mesh.indices)).toBe(true);
    expect(analyzeTopology(mesh.positions.length / 3, mesh.indices).nonManifoldVertices).toBe(0);
  });

  it('corrige la diagonal espacial y no hace nada si el etiquetado ya es correcto', () => {
    const spec = { ox: 0, oy: 0, oz: 0, h: 1, nx: 4, ny: 4, nz: 4 };
    const F = new Float32Array(64).fill(1);
    const at = (i: number, j: number, k: number): number => i + 4 * (j + 4 * k);
    F[at(1, 1, 1)] = -0.3;
    F[at(2, 2, 2)] = -0.5;
    const blocks = Int32Array.from([0, 0, 0, 2, 0, 0, 0, 2, 0, 2, 2, 0, 0, 0, 2, 2, 0, 2, 0, 2, 2, 2, 2, 2]);
    const g = { F, blocks };
    expect(repairLabeling(spec, g)).toBeGreaterThan(0);
    const mesh = surfaceNets(spec, g);
    expect(analyzeTopology(mesh.positions.length / 3, mesh.indices).nonManifoldVertices).toBe(0);
    expect(repairLabeling(spec, g)).toBe(0);
  });
});

describe('estimateSelfIntersections', () => {
  it('detecta dos cubos que se atraviesan y no detecta cubos separados', () => {
    const a = cube(0, 0, 0, 1);
    const b = cube(0.41, 0.33, 0.27, 1);
    const pos = Float32Array.from([...a.positions, ...b.positions]);
    const idx = Uint32Array.from([...a.indices, ...Array.from(b.indices, (i) => i + 8)]);
    const hit = estimateSelfIntersections(pos, idx);
    expect(hit.intersectingTriangles).toBeGreaterThan(0);
    expect(hit.rate).toBeGreaterThan(0);
    const c = cube(3, 0, 0, 1);
    const pos2 = Float32Array.from([...a.positions, ...c.positions]);
    const idx2 = Uint32Array.from([...a.indices, ...Array.from(c.indices, (i) => i + 8)]);
    expect(estimateSelfIntersections(pos2, idx2).intersectingTriangles).toBe(0);
  });
});
