import { beforeAll, describe, expect, it } from 'vitest';
import {
  BODY_REGIONS,
  J,
  JOINT_COUNT,
  MEASUREMENT_KEYS,
  REFERENCE_MEASUREMENTS,
  buildRestSkeleton,
  computeSkinMatrices,
  computeVertexNormals,
  restPose,
  triangleCount,
  validateMesh,
  vertexCount,
  type BodyModel,
  type Measurements,
} from '@fitroom/shared';
import { buildBody, buildBodyAsync, buildBodyUncached, clearBodyCache, setBodyCacheCapacity } from './index.js';
import { analyzeTopology, estimateSelfIntersections } from './meshops.js';
import { measureBody, type MeasuredBody } from './measure.js';
import { isInside, mirrorError, signedVolume, MAX_MEASUREMENTS, MIN_MEASUREMENTS } from './test-helpers.js';
import { gridStep, measurementsKey } from './build.js';
import { deriveDims } from './dims.js';
import { worldColliders } from './colliders.js';

type RefName = keyof typeof REFERENCE_MEASUREMENTS;
const REF_NAMES = Object.keys(REFERENCE_MEASUREMENTS) as RefName[];

const bodies = new Map<string, BodyModel>();
const measured = new Map<string, MeasuredBody>();
const EXTREMES: Record<string, Measurements> = {
  minLimits: MIN_MEASUREMENTS('neutral'),
  maxLimits: MAX_MEASUREMENTS('masculine'),
};
const ALL: Record<string, Measurements> = { ...REFERENCE_MEASUREMENTS, ...EXTREMES };

beforeAll(() => {
  for (const [name, m] of Object.entries(ALL)) {
    bodies.set(name, buildBodyUncached(m));
    measured.set(name, measureBody(bodies.get(name)!));
  }
});

const body = (n: string): BodyModel => bodies.get(n)!;

describe.each(Object.keys(ALL))('buildBody(%s): malla', (name) => {
  it('pasa validateMesh y tiene entre 15 k y 30 k vértices', () => {
    const b = body(name);
    expect(validateMesh(b.mesh)).toEqual([]);
    const n = vertexCount(b.mesh);
    expect(n).toBeGreaterThanOrEqual(15_000);
    expect(n).toBeLessThanOrEqual(30_000);
    expect(triangleCount(b.mesh)).toBe(2 * (n - 2)); // característica de Euler de la esfera
  });

  it('es cerrada, 2-manifold, con orientación consistente y una sola pieza', () => {
    const b = body(name);
    expect(analyzeTopology(vertexCount(b.mesh), b.mesh.indices)).toMatchObject({
      badEdges: 0,
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      inconsistentEdges: 0,
      nonManifoldVertices: 0,
      components: 1,
      euler: 2,
    });
    expect(signedVolume(b.mesh.positions, b.mesh.indices)).toBeGreaterThan(0.02);
  });

  it('las normales son unitarias, coinciden con la geometría y apuntan hacia fuera', () => {
    const { mesh } = body(name);
    const n = vertexCount(mesh);
    const recomputed = computeVertexNormals(mesh.positions, mesh.indices);
    let worst = 0;
    for (let i = 0; i < n * 3; i++) worst = Math.max(worst, Math.abs(recomputed[i]! - mesh.normals[i]!));
    expect(worst).toBeLessThan(1e-5);
    // sonda: a 4 mm por fuera según la normal el punto está fuera de la malla; a 4 mm por dentro, dentro
    const step = Math.floor(n / 120);
    let wrong = 0;
    let probes = 0;
    for (let v = 0; v < n; v += step) {
      const p = [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!] as const;
      const nr = [mesh.normals[v * 3]!, mesh.normals[v * 3 + 1]!, mesh.normals[v * 3 + 2]!] as const;
      const out = [p[0] + nr[0] * 0.004, p[1] + nr[1] * 0.004, p[2] + nr[2] * 0.004] as const;
      const inn = [p[0] - nr[0] * 0.004, p[1] - nr[1] * 0.004, p[2] - nr[2] * 0.004] as const;
      probes++;
      if (isInside(mesh.positions, mesh.indices, out) || !isInside(mesh.positions, mesh.indices, inn)) wrong++;
    }
    expect(wrong / probes).toBeLessThan(0.03);
  });

  it('pesos de piel válidos: 4 influencias, suman 1, índices < 21, ordenados por peso', () => {
    const { mesh } = body(name);
    const n = vertexCount(mesh);
    for (let v = 0; v < n; v++) {
      let s = 0;
      for (let k = 0; k < 4; k++) {
        const w = mesh.skinWeights[v * 4 + k]!;
        expect(w).toBeGreaterThanOrEqual(0);
        expect(mesh.skinIndices[v * 4 + k]!).toBeLessThan(JOINT_COUNT);
        s += w;
        if (k > 0) expect(w).toBeLessThanOrEqual(mesh.skinWeights[v * 4 + k - 1]! + 1e-6);
      }
      expect(Math.abs(s - 1)).toBeLessThan(1e-5);
    }
  });

  it('regiones: una por vértice, todas presentes y razonablemente simétricas', () => {
    const b = body(name);
    const n = vertexCount(b.mesh);
    expect(b.regions.length).toBe(n);
    const count = new Array<number>(BODY_REGIONS.length).fill(0);
    for (let v = 0; v < n; v++) {
      expect(b.regions[v]!).toBeLessThan(BODY_REGIONS.length);
      count[b.regions[v]!]!++;
    }
    for (let r = 0; r < count.length; r++) expect(count[r]!).toBeGreaterThan(30);
    const idx = (r: (typeof BODY_REGIONS)[number]): number => BODY_REGIONS.indexOf(r);
    for (const [l, r] of [
      ['l_arm', 'r_arm'],
      ['l_hand', 'r_hand'],
      ['l_leg', 'r_leg'],
      ['l_foot', 'r_foot'],
    ] as const) {
      const a = count[idx(l)]!;
      const c = count[idx(r)]!;
      expect(Math.abs(a - c) / Math.max(a, c)).toBeLessThan(0.15);
    }
  });

  it('pies sobre y = 0, centrado en x = 0 y simétrico respecto al plano X', () => {
    const b = body(name);
    const mb = measured.get(name)!;
    expect(mb.minYCm).toBeGreaterThanOrEqual(-1e-6);
    expect(mb.minYCm).toBeLessThan(0.05);
    expect(Math.abs(mb.centerXCm)).toBeLessThan(0.3);
    // los dos pies se apoyan: hay muchos vértices en y ≈ 0 a ambos lados
    let left = 0;
    let right = 0;
    for (let v = 0; v < vertexCount(b.mesh); v++) {
      if (b.mesh.positions[v * 3 + 1]! < 0.0005) {
        if (b.mesh.positions[v * 3]! > 0) left++;
        else right++;
      }
    }
    expect(left).toBeGreaterThan(40);
    expect(Math.abs(left - right) / Math.max(left, right)).toBeLessThan(0.1);
    expect(mirrorError(b.mesh.positions)).toBeLessThan(0.004);
  });

  it('el esqueleto es exactamente el de buildRestSkeleton(m) y las medidas son las pedidas', () => {
    const b = body(name);
    expect(b.skeleton).toEqual(buildRestSkeleton(ALL[name]!));
    expect(b.measurements).toEqual(ALL[name]);
  });

  it('colisionadores: cápsulas válidas por segmento, ancladas a joints y por dentro de la piel', () => {
    const b = body(name);
    const names = b.colliders.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const must of ['head', 'neck', 'chest', 'waist', 'pelvis', 'thigh_l', 'thigh_r', 'calf_l', 'calf_r', 'upper_arm_l', 'upper_arm_r', 'forearm_l', 'forearm_r'])
      expect(names).toContain(must);
    expect(names.filter((n) => /chest|waist|pelvis/.test(n)).length).toBeGreaterThanOrEqual(2);
    for (const c of b.colliders) {
      expect(c.jointA).toBeGreaterThanOrEqual(0);
      expect(c.jointA).toBeLessThan(JOINT_COUNT);
      expect(c.jointB).toBeLessThan(JOINT_COUNT);
      expect(c.radius).toBeGreaterThan(0.005);
      expect(c.radius).toBeLessThan(0.25 * b.skeleton.height);
    }
    // ligeramente por dentro: el anillo medio de cada cápsula (al 97 % del radio) queda dentro de la malla
    const rest = computeSkinMatrices(b.skeleton, restPose(b.skeleton));
    const caps = worldColliders(b, rest);
    let inside = 0;
    let total = 0;
    for (const cap of caps) {
      const mid = [(cap.a[0] + cap.b[0]) / 2, (cap.a[1] + cap.b[1]) / 2, (cap.a[2] + cap.b[2]) / 2] as const;
      const ax = [cap.b[0] - cap.a[0], cap.b[1] - cap.a[1], cap.b[2] - cap.a[2]];
      const al = Math.hypot(ax[0]!, ax[1]!, ax[2]!) || 1;
      const u = [ax[0]! / al, ax[1]! / al, ax[2]! / al];
      // base ortonormal
      const h = Math.abs(u[1]!) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const e1 = [u[1]! * h[2]! - u[2]! * h[1]!, u[2]! * h[0]! - u[0]! * h[2]!, u[0]! * h[1]! - u[1]! * h[0]!];
      const e1l = Math.hypot(e1[0]!, e1[1]!, e1[2]!);
      const f1 = e1.map((x) => x / e1l);
      const f2 = [u[1]! * f1[2]! - u[2]! * f1[1]!, u[2]! * f1[0]! - u[0]! * f1[2]!, u[0]! * f1[1]! - u[1]! * f1[0]!];
      for (let k = 0; k < 8; k++) {
        const th = (k / 8) * Math.PI * 2;
        const r = cap.radius * 0.97;
        const pt = [
          mid[0] + r * (Math.cos(th) * f1[0]! + Math.sin(th) * f2[0]!),
          mid[1] + r * (Math.cos(th) * f1[1]! + Math.sin(th) * f2[1]!),
          mid[2] + r * (Math.cos(th) * f1[2]! + Math.sin(th) * f2[2]!),
        ] as const;
        total++;
        if (isInside(b.mesh.positions, b.mesh.indices, pt)) inside++;
      }
    }
    expect(inside / total).toBeGreaterThan(0.93);
  });

  it('tasa de autointersecciones despreciable', () => {
    const b = body(name);
    const r = estimateSelfIntersections(b.mesh.positions, b.mesh.indices);
    expect(r.rate).toBeLessThan(0.002);
  });
});

describe.each(Object.keys(ALL))('buildBody(%s): fidelidad métrica', (name) => {
  const m = ALL[name]!;
  const isCoherent = name in REFERENCE_MEASUREMENTS;
  it('estatura ±1 cm y las circunferencias principales ±1,5 %', () => {
    const mb = measured.get(name)!;
    expect(Math.abs(mb.heightCm - m.heightCm)).toBeLessThanOrEqual(1);
    if (!isCoherent) return; // los límites simultáneos son incoherentes: sólo se exige validez geométrica
    for (const [got, want] of [
      [mb.chestCm, m.chestCm],
      [mb.waistCm, m.waistCm],
      [mb.hipCm, m.hipCm],
      [mb.neckCm, m.neckCm],
      [mb.thighCm, m.thighCm],
    ] as const)
      expect(Math.abs(got - want) / want).toBeLessThanOrEqual(0.015);
  });

  it('hombros ±1 cm, brazo y entrepierna ±1,5 cm', () => {
    const mb = measured.get(name)!;
    if (!isCoherent) return;
    expect(Math.abs(mb.shoulderWidthCm - m.shoulderWidthCm)).toBeLessThanOrEqual(1);
    expect(Math.abs(mb.armLengthCm - m.armLengthCm)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(mb.inseamCm - m.inseamCm)).toBeLessThanOrEqual(1.5);
  });

  it('el volumen es coherente con el peso (densidad corporal ≈ 1 kg/L, tolerancia ±25 %)', () => {
    if (!isCoherent) return;
    const mb = measured.get(name)!;
    expect(mb.volumeL / m.weightKg).toBeGreaterThan(0.75);
    expect(mb.volumeL / m.weightKg).toBeLessThan(1.25);
  });

  it('simetría izquierda/derecha de las medidas (muslos)', () => {
    const mb = measured.get(name)!;
    expect(Math.abs(mb.thighLeftCm - mb.thighRightCm)).toBeLessThan(0.3);
  });
});

describe('buildBody: determinismo, caché y asincronía', () => {
  it('misma entrada → mismos bytes (reconstrucción sin caché)', () => {
    const a = buildBodyUncached(REFERENCE_MEASUREMENTS.adultB);
    const b = body('adultB');
    for (const k of ['positions', 'normals', 'indices', 'skinIndices', 'skinWeights'] as const) {
      expect(Buffer.from(a.mesh[k].buffer).equals(Buffer.from(b.mesh[k].buffer))).toBe(true);
    }
    expect(Buffer.from(a.regions.buffer).equals(Buffer.from(b.regions.buffer))).toBe(true);
    expect(a.colliders).toEqual(b.colliders);
  });

  it('la caché devuelve el mismo objeto y respeta la capacidad LRU', () => {
    clearBodyCache();
    setBodyCacheCapacity(2);
    const m1 = REFERENCE_MEASUREMENTS.small;
    const m2 = REFERENCE_MEASUREMENTS.adultB;
    const m3 = REFERENCE_MEASUREMENTS.adultA;
    const b1 = buildBody(m1);
    expect(buildBody({ ...m1 })).toBe(b1);
    const b2 = buildBody(m2);
    expect(buildBody(m1)).toBe(b1); // m1 pasa a ser el más reciente
    buildBody(m3); // expulsa a m2 (el menos reciente)
    expect(buildBody(m1)).toBe(b1);
    expect(buildBody(m2)).not.toBe(b2); // reconstruido…
    expect(Buffer.from(buildBody(m2).mesh.positions.buffer).equals(Buffer.from(b2.mesh.positions.buffer))).toBe(true); // …idéntico
    setBodyCacheCapacity(8);
    clearBodyCache();
  });

  it('buildBodyAsync cede al bucle de eventos y da el mismo resultado', async () => {
    clearBodyCache();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    const a = await buildBodyAsync(REFERENCE_MEASUREMENTS.adultA);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(3);
    const s = body('adultA');
    expect(Buffer.from(a.mesh.positions.buffer).equals(Buffer.from(s.mesh.positions.buffer))).toBe(true);
    expect(await buildBodyAsync(REFERENCE_MEASUREMENTS.adultA)).toBe(a); // caché
    await expect(buildBodyAsync({ ...REFERENCE_MEASUREMENTS.adultA, heightCm: Number.NaN })).rejects.toMatchObject({ code: 'invalid-measurements' });
    clearBodyCache();
  });

  it('claves de caché y paso de rejilla', () => {
    const m = REFERENCE_MEASUREMENTS.adultA;
    expect(measurementsKey(m)).toBe(measurementsKey({ ...m }));
    expect(measurementsKey(m)).not.toBe(measurementsKey({ ...m, hipCm: m.hipCm + 0.5 }));
    expect(measurementsKey(m)).not.toBe(measurementsKey({ ...m, bodyBase: 'neutral' }));
    expect(MEASUREMENT_KEYS.length).toBe(10);
    const h = gridStep(deriveDims(m));
    expect(h).toBeGreaterThan(0.007);
    expect(h).toBeLessThan(0.013);
  });
});

describe('buildBody: monotonía', () => {
  it('más pecho → más perímetro de pecho; más estatura → cuerpo más alto', () => {
    const base = REFERENCE_MEASUREMENTS.adultB;
    const chestUp = measureBody(buildBodyUncached({ ...base, chestCm: base.chestCm + 8 }));
    const chestDown = measureBody(buildBodyUncached({ ...base, chestCm: base.chestCm - 8 }));
    expect(chestUp.chestCm).toBeGreaterThan(measured.get('adultB')!.chestCm + 6);
    expect(chestDown.chestCm).toBeLessThan(measured.get('adultB')!.chestCm - 6);
    const taller = measureBody(buildBodyUncached({ ...base, heightCm: base.heightCm + 12, inseamCm: base.inseamCm + 5 }));
    expect(taller.heightCm).toBeGreaterThan(measured.get('adultB')!.heightCm + 11);
    const waistUp = measureBody(buildBodyUncached({ ...base, waistCm: base.waistCm + 10 }));
    expect(waistUp.waistCm).toBeGreaterThan(measured.get('adultB')!.waistCm + 8);
  });
});

describe('buildBody: sin NaN en bordes', () => {
  it.each(['minLimits', 'maxLimits'])('límites extremos (%s): todo finito', (name) => {
    const b = body(name);
    for (const arr of [b.mesh.positions, b.mesh.normals, b.mesh.skinWeights]) for (const v of arr) expect(Number.isFinite(v)).toBe(true);
    for (const c of b.colliders) expect(Number.isFinite(c.radius)).toBe(true);
    const mb = measured.get(name)!;
    for (const [k, v] of Object.entries(mb)) if (typeof v === 'number') expect(Number.isFinite(v), k).toBe(true);
  });
});

describe('measureBody es pura', () => {
  it('no modifica el cuerpo y es determinista', () => {
    const b = body('adultA');
    const before = Buffer.from(b.mesh.positions.buffer.slice(0)).toString('base64');
    const a = measureBody(b);
    const c = measureBody(b);
    expect(a).toEqual(c);
    expect(Buffer.from(b.mesh.positions.buffer).toString('base64')).toBe(before);
    expect(J.pelvis).toBe(0);
    expect(REF_NAMES.length).toBe(4);
  });
});
