import { describe, expect, it } from 'vitest';
import { computeVertexNormals, validateMesh } from './mesh.js';

const quad = () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const normals = computeVertexNormals(positions, indices);
  return { positions, normals, indices };
};

describe('mesh', () => {
  it('calcula normales unitarias hacia +Z para un quad CCW', () => {
    const { normals } = quad();
    for (let i = 0; i < 4; i++) expect(normals[i * 3 + 2]).toBeCloseTo(1, 6);
  });

  it('valida una malla correcta', () => {
    expect(validateMesh(quad())).toEqual([]);
  });

  it('detecta NaN, índices fuera de rango y pesos de skin inválidos', () => {
    const m = quad();
    m.positions[3] = Number.NaN;
    expect(validateMesh(m).map((i) => i.code)).toContain('non-finite');

    const m2 = { ...quad(), indices: new Uint32Array([0, 1, 9]) };
    expect(validateMesh(m2).map((i) => i.code)).toContain('index-out-of-range');

    const m3 = {
      ...quad(),
      skinIndices: new Uint16Array(16),
      skinWeights: new Float32Array(16).fill(0.5),
    };
    expect(validateMesh(m3).map((i) => i.code)).toContain('bad-skin-weights');
  });
});
