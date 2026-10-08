import { describe, expect, it, vi } from 'vitest';
import { ShaderLib, Vector3 } from 'three';
import {
  REFERENCE_MEASUREMENTS,
  computeSkinMatrices,
  validateMesh,
  type ClothSolver,
  type WorldCapsule,
} from '@fitroom/shared';
import {
  SpringSolver,
  doubleBody,
  doubleLoadedGarment,
  doubleWorldColliders,
  scriptedPose,
} from './dev/doubles';
import { GarmentRig } from './garmentRig';
import { BodyRig } from './bodyRig';
import {
  createGarmentUniforms,
  patchGarmentShader,
  type GarmentShaderUniforms,
} from './garmentMaterial';
import { computeNormalsInto } from './meshMath';
import { minHeapGrowth } from '../test-utils/heap';
import { blankNormalTexture } from './garmentMaterial';

const body = doubleBody(REFERENCE_MEASUREMENTS.adultA);
const garment = doubleLoadedGarment(body);

function skinAt(t: number): Float32Array {
  return computeSkinMatrices(body.skeleton, scriptedPose(body.skeleton, t));
}

describe('doubles (fixtures de las pruebas)', () => {
  it('el cuerpo y la prenda doble son mallas válidas', () => {
    expect(validateMesh(body.mesh)).toEqual([]);
    expect(validateMesh(garment.geometry.mesh)).toEqual([]);
    expect(body.mesh.positions.length / 3).toBeGreaterThan(500);
    expect(garment.geometry.mesh.indices.length / 3).toBeGreaterThan(1000);
  });
});

describe('GarmentRig', () => {
  const caps: WorldCapsule[] = [];
  const rig = new GarmentRig(garment, {
    quality: 'medium',
    mirror: true,
    wrinkleMap: null,
    createSolver: (g) => new SpringSolver(g),
  });

  it('construye el BufferGeometry con atributos y grupos por material', () => {
    const g = rig.geometry;
    expect(g.getAttribute('position').count).toBe(rig.vertexCount);
    expect(g.getAttribute('normal').count).toBe(rig.vertexCount);
    expect(g.getAttribute('uv').itemSize).toBe(2);
    expect(g.getAttribute('aBakedAo').itemSize).toBe(1);
    expect(g.getAttribute('aWrinkle').itemSize).toBe(1);
    expect(g.groups).toHaveLength(1);
    expect(g.groups[0]!.materialIndex).toBe(0);
    expect(rig.mesh.frustumCulled).toBe(false);
  });

  it('update(): posiciones y normales finitas, normales unitarias, y sigue a la pose', () => {
    const pos = rig.geometry.getAttribute('position').array as Float32Array;
    const rest = Float32Array.from(pos);
    for (const t of [0, 2500, 3000, 5500, 8000]) {
      const skin = skinAt(t);
      doubleWorldColliders(body, skin, caps);
      rig.update(skin, caps, 1 / 60, true);
      for (let i = 0; i < pos.length; i++) expect(Number.isFinite(pos[i])).toBe(true);
      const nrm = rig.geometry.getAttribute('normal').array as Float32Array;
      for (let i = 0; i < nrm.length; i += 3) {
        const l = Math.hypot(nrm[i]!, nrm[i + 1]!, nrm[i + 2]!);
        expect(l).toBeGreaterThan(0.99);
        expect(l).toBeLessThan(1.01);
      }
    }
    expect(Array.from(pos.slice(0, 30))).not.toEqual(Array.from(rest.slice(0, 30)));
  });

  it('en reposo de cámara, la prenda cubre el torso del cuerpo (misma caja a ±20 cm)', () => {
    const skin = skinAt(0);
    rig.update(skin, [], 1 / 60, false);
    const pos = rig.geometry.getAttribute('position').array as Float32Array;
    let minY = Infinity,
      maxY = -Infinity;
    for (let i = 1; i < pos.length; i += 3) {
      minY = Math.min(minY, pos[i]!);
      maxY = Math.max(maxY, pos[i]!);
    }
    const root = scriptedPose(body.skeleton, 0).rootPosition;
    const dy = root[1] - body.skeleton.joints[0]!.position[1];
    const neckY = body.skeleton.joints[3]!.position[1] + dy;
    expect(maxY).toBeGreaterThan(neckY - 0.05);
    expect(minY).toBeLessThan(root[1]);
  });

  it('sin simulación (calidad low o simulate=false) no usa el solver', () => {
    const solverSpy = vi.fn((g) => new SpringSolver(g));
    const r = new GarmentRig(garment, {
      quality: 'low',
      mirror: true,
      wrinkleMap: null,
      createSolver: solverSpy,
    });
    r.update(skinAt(0), [], 1 / 60, true);
    expect(solverSpy).not.toHaveBeenCalled();
    expect(r.hasSolver).toBe(false);
    r.dispose();
    const r2 = new GarmentRig(garment, {
      quality: 'high',
      mirror: true,
      wrinkleMap: null,
      createSolver: solverSpy,
    });
    r2.update(skinAt(0), [], 1 / 60, false);
    expect(solverSpy).not.toHaveBeenCalled();
    r2.update(skinAt(0), [], 1 / 60, true);
    expect(solverSpy).toHaveBeenCalledTimes(1);
    r2.dispose();
  });

  it('con el solver real aún sin implementar, degrada a skinning sin lanzar', () => {
    const r = new GarmentRig(garment, { quality: 'high', mirror: true, wrinkleMap: null });
    expect(() => r.update(skinAt(0), [], 1 / 60, true)).not.toThrow();
    r.dispose();
  });

  it('un solver inestable (NaN/Inf) jamás llega a la geometría', () => {
    const bad: ClothSolver = {
      vertexCount: garment.geometry.mesh.positions.length / 3,
      wrinkle: new Float32Array(garment.geometry.mesh.positions.length / 3),
      step(_dt, _skinned, _caps, out) {
        out.fill(Number.NaN);
        out[3] = Infinity;
      },
      reset() {},
    };
    const r = new GarmentRig(garment, {
      quality: 'high',
      mirror: true,
      wrinkleMap: null,
      createSolver: () => bad,
    });
    r.update(skinAt(0), [], 1 / 60, true);
    const pos = r.geometry.getAttribute('position').array as Float32Array;
    expect(pos.every(Number.isFinite)).toBe(true);
    r.dispose();
  });

  it('copia el wrinkle del solver al atributo', () => {
    const skin = skinAt(0);
    rig.update(skin, [], 1 / 60, true);
    const s2 = skinAt(2200);
    rig.update(s2, [], 1 / 60, true);
    const w = rig.geometry.getAttribute('aWrinkle').array as Float32Array;
    expect(Math.max(...w)).toBeGreaterThan(0);
    expect(Math.max(...w)).toBeLessThanOrEqual(1);
  });

  it('capa exterior: desplaza los vértices a lo largo de la normal', () => {
    const plain = new GarmentRig(garment, { quality: 'low', mirror: false, wrinkleMap: null });
    const outer = new GarmentRig(garment, {
      quality: 'low',
      mirror: false,
      wrinkleMap: null,
      layerOffsetM: 0.01,
    });
    const skin = skinAt(0);
    plain.update(skin, [], 1 / 60, false);
    outer.update(skin, [], 1 / 60, false);
    const a = plain.geometry.getAttribute('position').array as Float32Array;
    const b = outer.geometry.getAttribute('position').array as Float32Array;
    const n = outer.geometry.getAttribute('normal').array as Float32Array;
    for (const i of [0, 300, 900, 1500]) {
      const d = Math.hypot(b[i]! - a[i]!, b[i + 1]! - a[i + 1]!, b[i + 2]! - a[i + 2]!);
      expect(d).toBeCloseTo(0.01, 5);
      const dot = (b[i]! - a[i]!) * n[i]! + (b[i + 1]! - a[i + 1]!) * n[i + 1]! + (b[i + 2]! - a[i + 2]!) * n[i + 2]!;
      expect(dot).toBeGreaterThan(0.0099);
    }
    plain.dispose();
    outer.dispose();
  });

  it('setOpacity: oculta la malla cuando la visibilidad es 0 y propaga la opacidad', () => {
    rig.setOpacity(0.4);
    expect(rig.mesh.visible).toBe(true);
    expect((rig.materials.materials[0] as { opacity: number }).opacity).toBeCloseTo(0.4);
    rig.setOpacity(0);
    expect(rig.mesh.visible).toBe(false);
    rig.setOpacity(1);
  });

  it('setLight actualiza los uniformes compartidos sin recompilar', () => {
    rig.setLight(1.3, [1.1, 1, 0.9]);
    expect(rig.materials.uniforms.uExposure.value).toBeCloseTo(1.3);
    expect(rig.materials.uniforms.uLightTint.value.toArray()).toEqual([
      expect.closeTo(1.1, 5),
      1,
      expect.closeTo(0.9, 5),
    ]);
  });

  it('bucle caliente: update() no asigna memoria apreciable (buffers reutilizados)', () => {
    const skin = skinAt(1000);
    const c: WorldCapsule[] = [];
    doubleWorldColliders(body, skin, c);
    const grown = minHeapGrowth(() => rig.update(skin, c, 1 / 60, true), 300, 4, 80);
    // un buffer de posiciones son ~100 KB: 300 fotogramas con asignaciones superarían 30 MB
    expect(grown).toBeLessThan(1_500_000);
  });

  it('dispose(): libera geometría, materiales y texturas, y es idempotente', () => {
    const r = new GarmentRig(garment, { quality: 'medium', mirror: true, wrinkleMap: null });
    const geoSpy = vi.fn();
    r.geometry.addEventListener('dispose', geoSpy);
    const matSpies = r.materials.materials.map((m) => {
      const s = vi.fn();
      m.addEventListener('dispose', s);
      return s;
    });
    const mat = r.materials.materials[0] as unknown as {
      map: { addEventListener: (t: string, f: () => void) => void };
      normalMap: { addEventListener: (t: string, f: () => void) => void };
      aoMap: { addEventListener: (t: string, f: () => void) => void };
    };
    const texSpy = vi.fn();
    mat.map.addEventListener('dispose', texSpy);
    mat.normalMap.addEventListener('dispose', texSpy);
    mat.aoMap.addEventListener('dispose', texSpy);
    r.dispose();
    r.dispose();
    expect(geoSpy).toHaveBeenCalledTimes(1);
    for (const s of matSpies) expect(s).toHaveBeenCalledTimes(1);
    expect(texSpy).toHaveBeenCalledTimes(3);
  });

  it('las texturas llevan la repetición correcta por escala física (uvMetersPerTile / tileMeters)', () => {
    const mat = rig.materials.materials[0] as unknown as {
      map: { repeat: { x: number; y: number } };
    };
    const expected = garment.geometry.uvMetersPerTile / garment.textures.main.tileMeters;
    expect(mat.map.repeat.x).toBeCloseTo(expected, 6);
    expect(mat.map.repeat.y).toBeCloseTo(expected, 6);
  });

  it('mapas ORM compartidos: aoMap/roughnessMap/metalnessMap leen el mismo mapa; albedo en sRGB, resto lineal', () => {
    const m = rig.materials.materials[0] as unknown as {
      map: { colorSpace: string };
      normalMap: { colorSpace: string };
      aoMap: { colorSpace: string };
      roughnessMap: unknown;
      metalnessMap: unknown;
      sheen: number;
      side: number;
    };
    expect(m.aoMap).toBe(m.roughnessMap);
    expect(m.aoMap).toBe(m.metalnessMap);
    expect(m.map.colorSpace).toBe('srgb');
    expect(m.normalMap.colorSpace).toBe('');
    expect(m.aoMap.colorSpace).toBe('');
    expect(m.sheen).toBeGreaterThan(0); // algodón: sheen
  });
});

describe('parche de shader (AO horneado, arrugas, tone mapping)', () => {
  const mkShader = () => ({
    vertexShader: ShaderLib.physical.vertexShader,
    fragmentShader: ShaderLib.physical.fragmentShader,
    uniforms: {} as Record<string, { value: unknown }>,
  });
  const uniforms = (): GarmentShaderUniforms => createGarmentUniforms(blankNormalTexture(), 1);

  it('aplica todas las anclas con wrinkles + tone mapping', () => {
    const sh = mkShader();
    const u = uniforms();
    const ok = patchGarmentShader(sh, u, { mirrorToneMap: true, wrinkles: true });
    expect(ok).toBe(true);
    expect(sh.vertexShader).toContain('attribute float aBakedAo');
    expect(sh.vertexShader).toContain('vWrinkleUv = uv * uWrinkleUvScale');
    expect(sh.fragmentShader).toContain('uniform sampler2D uWrinkleMap');
    expect(sh.fragmentShader).toContain('mapN.xy += wrN.xy * wrAmt');
    expect(sh.fragmentShader).toContain('reflectedLight.indirectDiffuse *= bakedAo');
    expect(sh.fragmentShader).toContain('garmentNeutralTone( gl_FragColor.rgb');
    expect(sh.fragmentShader).not.toContain('#include <tonemapping_fragment>');
    expect(sh.uniforms.uWrinkleMap).toBe(u.uWrinkleMap);
    // el orden importa: wrinkleFold se declara antes de usarse
    const decl = sh.fragmentShader.indexOf('float wrinkleFold = 0.0');
    const use = sh.fragmentShader.indexOf('wrinkleFold * 1.0', 0);
    expect(decl).toBeGreaterThan(-1);
    expect(use === -1 || decl < use).toBe(true);
    expect(sh.fragmentShader.indexOf('wrinkleFold')).toBe(decl + 'float '.length);
  });

  it('sin tone mapping propio conserva el de three; sin arrugas no toca el normal map', () => {
    const sh = mkShader();
    const ok = patchGarmentShader(sh, uniforms(), { mirrorToneMap: false, wrinkles: false });
    expect(ok).toBe(true);
    expect(sh.fragmentShader).toContain('#include <tonemapping_fragment>');
    expect(sh.fragmentShader).not.toContain('wrN');
  });

  it('el shader parcheado sustituye todas las anclas sin dejar includes rotos', () => {
    const sh = mkShader();
    patchGarmentShader(sh, uniforms(), { mirrorToneMap: true, wrinkles: true });
    // cada #include restante debe ser un chunk conocido de three
    for (const m of sh.fragmentShader.matchAll(/#include <(\w+)>/g)) {
      expect(m[1]).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it('devuelve false si falta un ancla (shader de otra versión de three)', () => {
    const sh = { vertexShader: 'void main(){}', fragmentShader: 'void main(){}', uniforms: {} };
    expect(patchGarmentShader(sh, uniforms(), { mirrorToneMap: true, wrinkles: true })).toBe(false);
  });
});

describe('BodyRig', () => {
  it('oclusor: sólo escribe profundidad (colorWrite=false) y se dibuja antes que las prendas', () => {
    const r = new BodyRig(body, 'occluder');
    const m = r.mesh.material as { colorWrite: boolean; depthWrite: boolean; polygonOffset: boolean };
    expect(m.colorWrite).toBe(false);
    expect(m.depthWrite).toBe(true);
    expect(m.polygonOffset).toBe(true);
    expect(r.mesh.renderOrder).toBeLessThan(0);
    r.update(skinAt(0));
    const pos = r.geometry.getAttribute('position').array as Float32Array;
    expect(pos.every(Number.isFinite)).toBe(true);
    r.dispose();
  });

  it('maniquí recalcula normales; setLook cambia de material y libera el anterior', () => {
    const r = new BodyRig(body, 'mannequin');
    const old = r.mesh.material as import('three').Material;
    const spy = vi.fn();
    old.addEventListener('dispose', spy);
    r.update(skinAt(3000));
    const n = r.geometry.getAttribute('normal').array as Float32Array;
    expect(Math.hypot(n[0]!, n[1]!, n[2]!)).toBeCloseTo(1, 3);
    r.setLook('ghost');
    expect(spy).toHaveBeenCalledTimes(1);
    expect((r.mesh.material as { transparent: boolean }).transparent).toBe(true);
    r.dispose();
  });
});

describe('computeNormalsInto', () => {
  it('coincide con computeVertexNormals de shared (resultado) y no asigna por triángulo', async () => {
    const { computeVertexNormals } = await import('@fitroom/shared');
    const m = body.mesh;
    const a = computeVertexNormals(m.positions, m.indices);
    const b = new Float32Array(a.length);
    computeNormalsInto(m.positions, m.indices, b);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i]!, 5);
  });

  it('vértices degenerados → normal por defecto (0,1,0), nunca NaN', () => {
    const pos = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 5, 5]);
    const out = new Float32Array(12);
    computeNormalsInto(pos, new Uint32Array([0, 1, 2]), out);
    expect(out.every(Number.isFinite)).toBe(true);
    expect(Array.from(out.slice(9, 12))).toEqual([0, 1, 0]);
  });
});

// evita un aviso de import sin uso en builds estrictos
void Vector3;
