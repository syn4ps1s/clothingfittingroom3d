import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import type { GarmentGeometry, WorldCapsule } from '@fitroom/shared';
import { createClothSolver, ClothSolverError } from './index.js';
import { makeSkirt, makeTube, poseCapsules, poseSkirt, skirtCapsules } from './synthetic.js';

const quiet = { warn: () => undefined };
const FRAME = 1 / 60;

/** PRNG determinista (mulberry32) para los tests de caos */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Checked {
  maxLeashExcess: number;
  maxPenetration: number;
  nonFinite: number;
  wrinkleOutOfRange: number;
}

/**
 * Comprueba los invariantes de un paso:
 *  - nada no finito en `out`/`wrinkle`; wrinkle ∈ [0,1];
 *  - |out − skinned| ≤ correa efectiva (sólo en vértices con objetivo finito);
 *  - si el objetivo skinneado queda fuera de las cápsulas válidas (inflado por el margen), la salida también.
 */
function check(
  g: GarmentGeometry,
  skinned: Float32Array,
  out: Float32Array,
  wrinkle: Float32Array,
  caps: readonly WorldCapsule[],
  margin: number,
): Checked {
  const n = g.mesh.positions.length / 3;
  const res: Checked = { maxLeashExcess: -Infinity, maxPenetration: 0, nonFinite: 0, wrinkleOutOfRange: 0 };
  const valid = caps.filter(
    (c) =>
      c &&
      c.a &&
      c.b &&
      [...c.a, ...c.b, c.radius].every((x) => Number.isFinite(x)) &&
      c.radius > 0 &&
      c.radius < 1e4,
  );
  for (let v = 0; v < n; v++) {
    const o = v * 3;
    const sx = skinned[o]!,
      sy = skinned[o + 1]!,
      sz = skinned[o + 2]!;
    const ox = out[o]!,
      oy = out[o + 1]!,
      oz = out[o + 2]!;
    if (!Number.isFinite(ox + oy + oz)) {
      res.nonFinite++;
      continue;
    }
    const w = wrinkle[v]!;
    if (!(w >= 0 && w <= 1)) res.wrinkleOutOfRange++;
    if (!Number.isFinite(sx + sy + sz)) continue;
    const md = g.cloth.maxDistance[v]!;
    const im = g.cloth.invMass[v]!;
    const leash = im > 0 && md > 0 ? Math.min(md, 1) : 0;
    const d = Math.hypot(ox - sx, oy - sy, oz - sz);
    res.maxLeashExcess = Math.max(res.maxLeashExcess, d - leash);
    // factibilidad del objetivo
    let feasible = true;
    for (const c of valid) {
      if (distToCapsule([sx, sy, sz], c) < c.radius + margin - 1e-9) {
        feasible = false;
        break;
      }
    }
    if (feasible) {
      for (const c of valid) {
        const pen = c.radius + margin - distToCapsule([ox, oy, oz], c);
        if (pen > res.maxPenetration) res.maxPenetration = pen;
      }
    }
  }
  return res;
}

function distToCapsule(p: readonly [number, number, number], c: WorldCapsule): number {
  const ab = [c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]];
  const l2 = ab[0]! * ab[0]! + ab[1]! * ab[1]! + ab[2]! * ab[2]!;
  let t = l2 > 1e-12 ? ((p[0] - c.a[0]) * ab[0]! + (p[1] - c.a[1]) * ab[1]! + (p[2] - c.a[2]) * ab[2]!) / l2 : 0;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(p[0] - (c.a[0] + ab[0]! * t), p[1] - (c.a[1] + ab[1]! * t), p[2] - (c.a[2] + ab[2]! * t));
}

const expectClean = (r: Checked, tol = 1e-4): void => {
  expect(r.nonFinite).toBe(0);
  expect(r.wrinkleOutOfRange).toBe(0);
  expect(r.maxLeashExcess).toBeLessThanOrEqual(tol);
  expect(r.maxPenetration).toBeLessThanOrEqual(tol);
};

describe('construcción y contrato', () => {
  it('cumple la interfaz ClothSolver y respeta el presupuesto de partículas', () => {
    const g = makeSkirt({ rings: 80, segments: 100 }); // 8 100 vértices
    const s = createClothSolver(g, { particleBudget: 600, ...quiet });
    expect(s.vertexCount).toBe(8100);
    expect(s.wrinkle).toBeInstanceOf(Float32Array);
    expect(s.wrinkle.length).toBe(8100);
    expect(s.particleCount).toBeLessThanOrEqual(600);
    expect(s.particleCount).toBeGreaterThan(100);
    expect(typeof s.step).toBe('function');
    expect(typeof s.reset).toBe('function');
    expect(s.collisionMargin).toBeCloseTo(0.004, 9);
    expect(createClothSolver(g, { thicknessMm: 2.5, ...quiet }).collisionMargin).toBeCloseTo(0.0055, 9);
  });

  it('mallas pequeñas se simulan 1:1 (una partícula por vértice)', () => {
    const g = makeSkirt({ rings: 6, segments: 10 });
    const s = createClothSolver(g, quiet);
    expect(s.particleCount).toBe(g.mesh.positions.length / 3);
  });

  it('el clustering no mezcla partes no conexas ni huesos distintos', () => {
    // dos faldas separadas 2 m en una sola malla: ningún cluster puede contener vértices de ambas
    const a = makeSkirt({ rings: 20, segments: 24 });
    const n = a.mesh.positions.length / 3;
    const pos = new Float32Array(n * 6);
    pos.set(a.mesh.positions, 0);
    for (let i = 0; i < n; i++) {
      pos[n * 3 + i * 3] = a.mesh.positions[i * 3]! + 2;
      pos[n * 3 + i * 3 + 1] = a.mesh.positions[i * 3 + 1]!;
      pos[n * 3 + i * 3 + 2] = a.mesh.positions[i * 3 + 2]!;
    }
    const idx = new Uint32Array(a.mesh.indices.length * 2);
    idx.set(a.mesh.indices, 0);
    for (let i = 0; i < a.mesh.indices.length; i++) idx[a.mesh.indices.length + i] = a.mesh.indices[i]! + n;
    const dbl = (arr: Float32Array): Float32Array => {
      const o = new Float32Array(arr.length * 2);
      o.set(arr, 0);
      o.set(arr, arr.length);
      return o;
    };
    const skinIdx = new Uint16Array(a.mesh.skinIndices.length * 2);
    skinIdx.set(a.mesh.skinIndices, 0);
    skinIdx.set(a.mesh.skinIndices, a.mesh.skinIndices.length);
    const g: GarmentGeometry = {
      ...a,
      mesh: {
        positions: pos,
        normals: new Float32Array(n * 6),
        uvs: new Float32Array(n * 4),
        indices: idx,
        skinIndices: skinIdx,
        skinWeights: dbl(a.mesh.skinWeights),
      },
      cloth: { ...a.cloth, maxDistance: dbl(a.cloth.maxDistance), invMass: dbl(a.cloth.invMass) },
      ao: new Float32Array(n * 2).fill(1),
    };
    const s = createClothSolver(g, { particleBudget: 120, ...quiet });
    // la salida de cada mitad sólo depende de su propia mitad: mover una falda no mueve la otra
    const sk = Float32Array.from(pos);
    const out = new Float32Array(sk.length);
    for (let f = 0; f < 5; f++) s.step(FRAME, sk, [], out);
    const base = Float32Array.from(out);
    for (let i = 0; i < n; i++) sk[n * 3 + i * 3] = sk[n * 3 + i * 3]! + 0.1; // sólo la segunda falda
    s.step(FRAME, sk, [], out);
    let moved = 0;
    for (let i = 0; i < n * 3; i++) moved = Math.max(moved, Math.abs(out[i]! - base[i]!));
    expect(moved).toBeLessThan(0.02); // la primera falda casi no se entera
  });

  it('geometría inconsistente → ClothSolverError tipado', () => {
    const g = makeSkirt({ rings: 4, segments: 6 });
    expect(() =>
      createClothSolver({ ...g, cloth: { ...g.cloth, maxDistance: new Float32Array(3) } }, quiet),
    ).toThrow(ClothSolverError);
    const bad = Float32Array.from(g.mesh.positions);
    bad[4] = NaN;
    expect(() => createClothSolver({ ...g, mesh: { ...g.mesh, positions: bad } }, quiet)).toThrow(
      ClothSolverError,
    );
    const s = createClothSolver(g, quiet);
    expect(() => s.step(FRAME, new Float32Array(3), [], new Float32Array(3))).toThrow(ClothSolverError);
  });

  it('malla vacía y triángulos inválidos no rompen', () => {
    const g = makeSkirt({ rings: 3, segments: 5 });
    const empty: GarmentGeometry = {
      ...g,
      mesh: {
        positions: new Float32Array(0),
        normals: new Float32Array(0),
        uvs: new Float32Array(0),
        indices: new Uint32Array(0),
        skinIndices: new Uint16Array(0),
        skinWeights: new Float32Array(0),
      },
      cloth: { ...g.cloth, maxDistance: new Float32Array(0), invMass: new Float32Array(0) },
      ao: new Float32Array(0),
    };
    const s0 = createClothSolver(empty, quiet);
    s0.step(FRAME, new Float32Array(0), [], new Float32Array(0));
    // índices fuera de rango y degenerados se ignoran
    const idx = Uint32Array.from([...g.mesh.indices, 9999, 0, 1, 2, 2, 2]);
    const s1 = createClothSolver({ ...g, mesh: { ...g.mesh, indices: idx } }, quiet);
    const out = new Float32Array(g.mesh.positions.length);
    s1.step(FRAME, g.mesh.positions, [], out);
    expect(Number.isFinite(out[0]!)).toBe(true);
  });

  it('vértices aislados (sin triángulos) y atributos de piel ausentes funcionan', () => {
    const g = makeSkirt({ rings: 3, segments: 5 });
    const s = createClothSolver(
      {
        ...g,
        mesh: {
          ...g.mesh,
          indices: new Uint32Array(0),
          skinIndices: new Uint16Array(0),
          skinWeights: new Float32Array(0),
        },
      },
      quiet,
    );
    const out = new Float32Array(g.mesh.positions.length);
    for (let f = 0; f < 10; f++) s.step(FRAME, g.mesh.positions, [], out);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('comportamiento físico', () => {
  const g = makeSkirt({ rings: 30, segments: 40 });
  const n = g.mesh.positions.length / 3;
  const ringOf = (v: number): number => Math.floor(v / 40);

  it('en reposo (sin cápsulas) el desplazamiento es pequeño, hacia abajo y la cintura no se mueve', () => {
    const s = createClothSolver(g, quiet);
    const out = new Float32Array(n * 3);
    for (let f = 0; f < 240; f++) s.step(FRAME, g.mesh.positions, [], out);
    let hemDy = 0;
    let hemCount = 0;
    let maxD = 0;
    for (let v = 0; v < n; v++) {
      const d = Math.hypot(
        out[v * 3]! - g.mesh.positions[v * 3]!,
        out[v * 3 + 1]! - g.mesh.positions[v * 3 + 1]!,
        out[v * 3 + 2]! - g.mesh.positions[v * 3 + 2]!,
      );
      maxD = Math.max(maxD, d);
      if (ringOf(v) === 30) {
        hemDy += out[v * 3 + 1]! - g.mesh.positions[v * 3 + 1]!;
        hemCount++;
      }
      if (ringOf(v) === 0) expect(d).toBe(0); // anclado: exactamente en su sitio
    }
    expect(hemDy / hemCount).toBeLessThan(-0.0005); // cuelga un poco
    expect(maxD).toBeLessThan(0.02); // pero no se desploma: la prenda ya viene "caída"
  });

  it('la tela más rígida cuelga menos que la fluida', () => {
    const sag = (stiffness: number): number => {
      const s = createClothSolver({ ...g, cloth: { ...g.cloth, stiffness } }, quiet);
      const out = new Float32Array(n * 3);
      for (let f = 0; f < 300; f++) s.step(FRAME, g.mesh.positions, [], out);
      let tot = 0;
      for (let i = 0; i < 40; i++) tot += out[(30 * 40 + i) * 3 + 1]! - g.mesh.positions[(30 * 40 + i) * 3 + 1]!;
      return -tot / 40;
    };
    expect(sag(1)).toBeLessThan(sag(0));
  });

  it('el bajo se retrasa respecto al movimiento (inercia) y vuelve a asentarse', () => {
    const s = createClothSolver(g, { ...quiet });
    const sk = Float32Array.from(g.mesh.positions);
    const out = new Float32Array(n * 3);
    for (let f = 0; f < 60; f++) s.step(FRAME, sk, [], out);
    const meanHemDx = (): number => {
      let t = 0;
      for (let i = 0; i < 40; i++) t += out[(30 * 40 + i) * 3]! - sk[(30 * 40 + i) * 3]!;
      return t / 40;
    };
    let minLag = 0;
    for (let f = 0; f < 12; f++) {
      for (let v = 0; v < n; v++) sk[v * 3] = sk[v * 3]! + 0.04; // 2,4 m/s hacia +x
      s.step(FRAME, sk, [], out);
      minLag = Math.min(minLag, meanHemDx());
    }
    expect(minLag).toBeLessThan(-0.003); // se queda atrás (−x)
    for (let f = 0; f < 240; f++) s.step(FRAME, sk, [], out);
    expect(Math.abs(meanHemDx())).toBeLessThan(0.004); // y se asienta
  });

  it('el amortiguamiento reduce la oscilación tras un tirón', () => {
    const run = (damping: number): number => {
      const s = createClothSolver({ ...g, cloth: { ...g.cloth, damping } }, quiet);
      const sk = Float32Array.from(g.mesh.positions);
      const out = new Float32Array(n * 3);
      for (let f = 0; f < 60; f++) s.step(FRAME, sk, [], out);
      for (let v = 0; v < n; v++) sk[v * 3] = sk[v * 3]! + 0.12;
      s.step(FRAME, sk, [], out);
      for (let f = 0; f < 18; f++) s.step(FRAME, sk, [], out);
      let e = 0;
      for (let i = 0; i < 40; i++) e += Math.abs(out[(30 * 40 + i) * 3]! - sk[(30 * 40 + i) * 3]!);
      return e / 40;
    };
    expect(run(0.6)).toBeLessThanOrEqual(run(0) + 1e-6);
  });

  it('misma entrada → misma salida (determinismo entre instancias) y out puede ser skinned (in place)', () => {
    const a = createClothSolver(g, quiet);
    const b = createClothSolver(g, quiet);
    const c = createClothSolver(g, quiet);
    const outA = new Float32Array(n * 3);
    const outB = new Float32Array(n * 3);
    const inplace = new Float32Array(n * 3);
    const caps0 = skirtCapsules();
    for (let f = 0; f < 90; f++) {
      const sk = new Float32Array(n * 3);
      const pose = poseSkirt(g.mesh.positions, sk, f / 60);
      const caps = poseCapsules(caps0, pose);
      a.step(FRAME, sk, caps, outA);
      b.step(FRAME, sk, caps, outB);
      inplace.set(sk);
      c.step(FRAME, inplace, caps, inplace);
    }
    expect(Buffer.from(outA.buffer).equals(Buffer.from(outB.buffer))).toBe(true);
    expect(Buffer.from(outA.buffer).equals(Buffer.from(inplace.buffer))).toBe(true);
    expect(Buffer.from(a.wrinkle.buffer).equals(Buffer.from(b.wrinkle.buffer))).toBe(true);
  });

  it('el movimiento rígido genera poca arruga; un pliegue fuerte genera arrugas, suavizadas en el tiempo', () => {
    const tube = makeTube({ rings: 40, segments: 24, length: 0.5, radius: 0.05, maxDistance: 0.03, pinnedRings: 0 });
    const m = tube.mesh.positions.length / 3;
    const s = createClothSolver(tube, quiet);
    const sk = Float32Array.from(tube.mesh.positions);
    const out = new Float32Array(m * 3);
    for (let f = 0; f < 30; f++) s.step(FRAME, sk, [], out);
    let w0 = 0;
    for (const w of s.wrinkle) w0 = Math.max(w0, w);
    expect(w0).toBeLessThan(0.05);
    // codo: la mitad inferior gira 110° alrededor de un eje horizontal en y = −0.25
    const bend = (angle: number): Float32Array => {
      const r = new Float32Array(m * 3);
      const c = Math.cos(angle),
        sn = Math.sin(angle);
      for (let v = 0; v < m; v++) {
        const x = tube.mesh.positions[v * 3]!,
          y = tube.mesh.positions[v * 3 + 1]!,
          z = tube.mesh.positions[v * 3 + 2]!;
        if (y >= -0.25) {
          r[v * 3] = x;
          r[v * 3 + 1] = y;
          r[v * 3 + 2] = z;
        } else {
          const dy = y + 0.25;
          // gira en el plano YZ
          r[v * 3] = x;
          r[v * 3 + 1] = -0.25 + dy * c - z * sn;
          r[v * 3 + 2] = dy * sn + z * c;
        }
      }
      return r;
    };
    const bent = bend((110 * Math.PI) / 180);
    s.step(FRAME, bent, [], out);
    let w1 = 0;
    for (const w of s.wrinkle) w1 = Math.max(w1, w);
    for (let f = 0; f < 30; f++) s.step(FRAME, bent, [], out);
    let w2 = 0;
    for (const w of s.wrinkle) w2 = Math.max(w2, w);
    expect(w2).toBeGreaterThan(0.25); // el pliegue arruga
    expect(w1).toBeLessThan(w2); // sube con el tiempo (suavizado temporal)
    // al estirar de nuevo baja despacio, no de golpe
    s.step(FRAME, Float32Array.from(tube.mesh.positions), [], out);
    let w3 = 0;
    for (const w of s.wrinkle) w3 = Math.max(w3, w);
    expect(w3).toBeGreaterThan(w2 * 0.6);
    for (let f = 0; f < 120; f++) s.step(FRAME, Float32Array.from(tube.mesh.positions), [], out);
    let w4 = 0;
    for (const w of s.wrinkle) w4 = Math.max(w4, w);
    expect(w4).toBeLessThan(0.05);
  });
});

describe('colisión con cápsulas', () => {
  it('la tela que cae sobre una cápsula queda fuera (objetivo factible) y exactamente a margen', () => {
    // tubo de radio 0.1 a cuyo alrededor hay una cápsula de radio 0.095 (+ margen 4 mm → 0.099)
    const tube = makeTube({ rings: 20, segments: 36, length: 0.5, radius: 0.1, maxDistance: 0.05 });
    const n = tube.mesh.positions.length / 3;
    const s = createClothSolver(tube, quiet);
    const caps: WorldCapsule[] = [{ a: [0, 0.1, 0], b: [0, -0.6, 0], radius: 0.095 }];
    const out = new Float32Array(n * 3);
    for (let f = 0; f < 120; f++) s.step(FRAME, tube.mesh.positions, caps, out);
    const r = check(tube, tube.mesh.positions, out, s.wrinkle, caps, s.collisionMargin);
    expectClean(r);
  });

  it('empuja la tela cuando la cápsula invade el objetivo (dentro de la correa) y respeta la correa', () => {
    const tube = makeTube({ rings: 20, segments: 36, length: 0.5, radius: 0.1, maxDistance: 0.03 });
    const n = tube.mesh.positions.length / 3;
    const s = createClothSolver(tube, quiet);
    const caps: WorldCapsule[] = [{ a: [0, 0.1, 0], b: [0, -0.6, 0], radius: 0.11 }]; // más ancha que la tela
    const out = new Float32Array(n * 3);
    for (let f = 0; f < 120; f++) s.step(FRAME, tube.mesh.positions, caps, out);
    const r = check(tube, tube.mesh.positions, out, s.wrinkle, caps, s.collisionMargin);
    expect(r.nonFinite).toBe(0);
    expect(r.maxLeashExcess).toBeLessThanOrEqual(1e-4);
    // los vértices anclados (anillo 0) no se mueven; el resto se aleja del eje hasta la superficie inflada
    const R = 0.11 + s.collisionMargin;
    let pushed = 0;
    for (let v = 36; v < n; v++) {
      const rad = Math.hypot(out[v * 3]!, out[v * 3 + 2]!);
      if (rad > 0.1 + 0.01) pushed++;
      expect(rad).toBeGreaterThan(R - 1e-4); // y nunca queda dentro
    }
    expect(pushed).toBeGreaterThan(n / 2);
    for (let v = 0; v < 36; v++) expect(Math.hypot(out[v * 3]!, out[v * 3 + 2]!)).toBeCloseTo(0.1, 5);
  });

  it('cápsulas en movimiento: ningún vértice con objetivo factible queda dentro (falda animada)', () => {
    const g = makeSkirt({ rings: 40, segments: 60 });
    const n = g.mesh.positions.length / 3;
    const s = createClothSolver(g, { particleBudget: 300, ...quiet });
    const sk = new Float32Array(n * 3);
    const out = new Float32Array(n * 3);
    const caps0 = skirtCapsules();
    for (let f = 0; f < 300; f++) {
      const pose = poseSkirt(g.mesh.positions, sk, f / 60, 1.5);
      const caps = poseCapsules(caps0, pose);
      s.step(FRAME, sk, caps, out);
      expectClean(check(g, sk, out, s.wrinkle, caps, s.collisionMargin));
    }
  });

  it('cápsulas degeneradas (radio 0, a=b, NaN, Inf, negativas, ausentes) se descartan sin NaN; una esfera (a=b, r>0) colisiona', () => {
    const tube = makeTube({ rings: 12, segments: 24, length: 0.4, radius: 0.1, maxDistance: 0.08 });
    const n = tube.mesh.positions.length / 3;
    const warn = vi.fn();
    const s = createClothSolver(tube, { warn });
    const out = new Float32Array(n * 3);
    const caps = [
      { a: [0, 0, 0], b: [0, -0.3, 0], radius: 0 },
      { a: [NaN, 0, 0], b: [0, -0.3, 0], radius: 0.05 },
      { a: [0, 0, 0], b: [0, Infinity, 0], radius: 0.05 },
      { a: [0, 0, 0], b: [0, -0.3, 0], radius: -1 },
      { a: [0, 0, 0], b: [0, -0.3, 0], radius: NaN },
      { a: [0, 0, 0], b: [0, -0.3, 0], radius: 1e12 },
      undefined,
      { a: undefined, b: [0, 0, 0], radius: 1 },
      // esfera sobre la pared de la tela
      { a: [0.1, -0.2, 0], b: [0.1, -0.2, 0], radius: 0.05 },
    ] as unknown as WorldCapsule[];
    for (let f = 0; f < 60; f++) s.step(FRAME, tube.mesh.positions, caps, out);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
    expect(s.stats.skippedCapsules).toBeGreaterThanOrEqual(8 * 60);
    // la esfera valida empuja la tela cercana
    const r = check(tube, tube.mesh.positions, out, s.wrinkle, [caps[8]!], s.collisionMargin);
    expectClean(r);
  });

  it('más de 120 cápsulas: se usan las primeras 120 y las demás se cuentan como descartadas', () => {
    const tube = makeTube({ rings: 6, segments: 8 });
    const s = createClothSolver(tube, quiet);
    const caps: WorldCapsule[] = [];
    for (let i = 0; i < 150; i++) caps.push({ a: [3, i * 0.01, 0], b: [3, i * 0.01 + 0.005, 0], radius: 0.01 });
    const out = new Float32Array(tube.mesh.positions.length);
    s.step(FRAME, tube.mesh.positions, caps, out);
    expect(s.stats.skippedCapsules).toBe(30);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('entradas adversariales', () => {
  const g = makeSkirt({ rings: 16, segments: 24 });
  const n = g.mesh.positions.length / 3;

  it('NaN/±Inf en skinned: salida finita, correa respetada en vértices válidos, contador y aviso limitado', () => {
    const warn = vi.fn();
    const s = createClothSolver(g, { warn });
    const out = new Float32Array(n * 3);
    for (let f = 0; f < 10; f++) s.step(FRAME, g.mesh.positions, [], out);
    const sk = Float32Array.from(g.mesh.positions);
    sk[30] = NaN;
    sk[100] = Infinity;
    sk[200] = -Infinity;
    sk[203] = NaN;
    for (let f = 0; f < 20; f++) s.step(FRAME, sk, [], out);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
    for (const w of s.wrinkle) expect(w >= 0 && w <= 1).toBe(true);
    expectClean(check(g, sk, out, s.wrinkle, [], s.collisionMargin));
    expect(s.stats.nonFiniteInputVertices).toBeGreaterThanOrEqual(4 * 20);
    expect(warn.mock.calls.length).toBeGreaterThan(0);
    expect(warn.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('todo el skinned NaN, y luego recuperación', () => {
    const s = createClothSolver(g, quiet);
    const out = new Float32Array(n * 3);
    const nanAll = new Float32Array(n * 3).fill(NaN);
    for (let f = 0; f < 5; f++) s.step(FRAME, g.mesh.positions, [], out);
    for (let f = 0; f < 5; f++) {
      s.step(FRAME, nanAll, [], out);
      for (const v of out) expect(Number.isFinite(v)).toBe(true);
    }
    for (let f = 0; f < 60; f++) s.step(FRAME, g.mesh.positions, [], out);
    expectClean(check(g, g.mesh.positions, out, s.wrinkle, [], s.collisionMargin));
  });

  it('saltos de metros (teleport): el estado se reinicia sobre el nuevo objetivo y no explota', () => {
    const s = createClothSolver(g, quiet);
    const out = new Float32Array(n * 3);
    const sk = Float32Array.from(g.mesh.positions);
    for (let f = 0; f < 30; f++) s.step(FRAME, sk, [], out);
    for (const jump of [3, 50, 1e4, 1e9]) {
      for (let v = 0; v < n; v++) sk[v * 3] = g.mesh.positions[v * 3]! + jump;
      s.step(FRAME, sk, [], out);
      for (let v = 0; v < n * 3; v++) expect(Number.isFinite(out[v]!)).toBe(true);
      // tras el salto la tela reaparece prácticamente sobre su objetivo
      let maxD = 0;
      for (let v = 0; v < n; v++) maxD = Math.max(maxD, Math.abs(out[v * 3]! - sk[v * 3]!));
      expect(maxD).toBeLessThan(0.05);
    }
    expect(s.stats.teleports).toBeGreaterThanOrEqual(4);
  });

  it('un solo vértice que salta no arrastra al resto (teleport individual acotado por la correa)', () => {
    const s = createClothSolver(g, quiet);
    const out = new Float32Array(n * 3);
    const sk = Float32Array.from(g.mesh.positions);
    for (let f = 0; f < 30; f++) s.step(FRAME, sk, [], out);
    const before = Float32Array.from(out);
    sk[(10 * 24 + 3) * 3] += 5; // un vértice a 5 m
    s.step(FRAME, sk, [], out);
    expectClean(check(g, sk, out, s.wrinkle, [], s.collisionMargin));
    let other = 0;
    for (let v = 0; v < n; v++) {
      if (v === 10 * 24 + 3) continue;
      other = Math.max(other, Math.abs(out[v * 3]! - before[v * 3]!));
    }
    expect(other).toBeLessThan(0.05);
  });

  it('dt = 0, negativo, NaN, ±Inf, enorme: siempre finito y acotado; dt ≤ 0 no avanza la simulación', () => {
    const s = createClothSolver(g, quiet);
    const out = new Float32Array(n * 3);
    const sk = Float32Array.from(g.mesh.positions);
    for (let f = 0; f < 40; f++) s.step(FRAME, sk, [], out);
    for (const dt of [0, -1, -1e-9, NaN, Infinity, -Infinity, 1e-12, 1e-3, 0.0333, 0.1, 0.49, 0.51, 5, 1e9]) {
      for (let v = 0; v < n; v++) sk[v * 3 + 1] = g.mesh.positions[v * 3 + 1]! + 0.01 * Math.sin(v + dt);
      s.step(dt, sk, [], out);
      expectClean(check(g, sk, out, s.wrinkle, [], s.collisionMargin));
    }
    expect(s.stats.badDt).toBeGreaterThanOrEqual(6);
    // dt = 0 repetido es un punto fijo
    s.step(FRAME, sk, [], out);
    const a = Float32Array.from(out);
    s.step(0, sk, [], out);
    const b = Float32Array.from(out);
    s.step(0, sk, [], out);
    for (let i = 0; i < out.length; i++) {
      expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(0.005);
      expect(out[i]).toBe(b[i]);
    }
  });

  it('dt > 0,5 s (pestaña dormida) se trata como discontinuidad: reinicio duro', () => {
    const s = createClothSolver(g, quiet);
    const out = new Float32Array(n * 3);
    const sk = Float32Array.from(g.mesh.positions);
    for (let f = 0; f < 30; f++) s.step(FRAME, sk, [], out);
    for (let v = 0; v < n; v++) sk[v * 3] = sk[v * 3]! + 0.2;
    s.step(3, sk, [], out);
    let maxD = 0;
    for (let v = 0; v < n; v++) maxD = Math.max(maxD, Math.hypot(out[v * 3]! - sk[v * 3]!, out[v * 3 + 1]! - sk[v * 3 + 1]!));
    expect(maxD).toBeLessThan(1e-4);
  });

  it('reset() descarta el estado: el resultado coincide con un solver nuevo', () => {
    const fresh = createClothSolver(g, quiet);
    const used = createClothSolver(g, quiet);
    const o1 = new Float32Array(n * 3);
    const o2 = new Float32Array(n * 3);
    const r = rng(7);
    const sk = Float32Array.from(g.mesh.positions);
    for (let f = 0; f < 100; f++) {
      for (let i = 0; i < sk.length; i++) sk[i] = g.mesh.positions[i]! + (r() - 0.5) * 0.3;
      used.step(FRAME, sk, [], o2);
    }
    used.reset();
    for (const w of used.wrinkle) expect(w).toBe(0);
    for (let f = 0; f < 30; f++) {
      fresh.step(FRAME, g.mesh.positions, [], o1);
      used.step(FRAME, g.mesh.positions, [], o2);
    }
    expect(Buffer.from(o1.buffer).equals(Buffer.from(o2.buffer))).toBe(true);
  });

  it('10 000 pasos de movimiento caótico con entradas adversariales: invariantes en cada paso', () => {
    const gg = makeSkirt({ rings: 10, segments: 16 });
    const m = gg.mesh.positions.length / 3;
    const s = createClothSolver(gg, { particleBudget: 60, ...quiet });
    const r = rng(20260101);
    const sk = new Float32Array(m * 3);
    const out = new Float32Array(m * 3);
    const caps: WorldCapsule[] = [];
    const dts = [FRAME, FRAME, FRAME, 1 / 30, 1 / 120, 0, -1, NaN, 0.2, 1e-6, Infinity, 0.7];
    let worstLeash = -Infinity;
    let worstPen = 0;
    for (let step = 0; step < 10000; step++) {
      const mode = r();
      // base: pose rígida aleatoria suave + ruido; a veces saltos, NaN, Inf
      const jitter = mode < 0.6 ? 0.02 : mode < 0.9 ? 0.5 : 3;
      const ox = (r() - 0.5) * jitter,
        oy = (r() - 0.5) * jitter,
        oz = (r() - 0.5) * jitter;
      for (let i = 0; i < m; i++) {
        sk[i * 3] = gg.mesh.positions[i * 3]! + ox + (r() - 0.5) * jitter * 0.3;
        sk[i * 3 + 1] = gg.mesh.positions[i * 3 + 1]! + oy + (r() - 0.5) * jitter * 0.3;
        sk[i * 3 + 2] = gg.mesh.positions[i * 3 + 2]! + oz + (r() - 0.5) * jitter * 0.3;
      }
      if (r() < 0.04) sk[Math.floor(r() * sk.length)] = NaN;
      if (r() < 0.02) sk[Math.floor(r() * sk.length)] = r() < 0.5 ? Infinity : -Infinity;
      if (r() < 0.01) sk[Math.floor(r() * sk.length)] = 1e30;
      caps.length = 0;
      const nc = Math.floor(r() * 5);
      for (let c = 0; c < nc; c++) {
        const k = r();
        caps.push({
          a: [(r() - 0.5) * 0.6, 0.5 + r() * 0.6, (r() - 0.5) * 0.6],
          b: k < 0.15 ? [NaN, 0, 0] : k < 0.3 ? [0, 0, 0] : [(r() - 0.5) * 0.6, 0.2 + r() * 0.6, (r() - 0.5) * 0.6],
          radius: k < 0.1 ? 0 : k < 0.2 ? -0.1 : 0.02 + r() * 0.15,
        });
      }
      const dt = r() < 0.15 ? dts[Math.floor(r() * dts.length)]! : FRAME;
      s.step(dt, sk, caps, out);
      const c = check(gg, sk, out, s.wrinkle, caps, s.collisionMargin);
      if (c.nonFinite > 0 || c.wrinkleOutOfRange > 0) throw new Error(`paso ${step}: no finito (${JSON.stringify(c)})`);
      worstLeash = Math.max(worstLeash, c.maxLeashExcess);
      worstPen = Math.max(worstPen, c.maxPenetration);
    }
    expect(worstLeash).toBeLessThanOrEqual(1e-4);
    expect(worstPen).toBeLessThanOrEqual(1e-4);
    // recuperación tras reset()
    s.reset();
    for (let f = 0; f < 120; f++) s.step(FRAME, gg.mesh.positions, [], out);
    expectClean(check(gg, gg.mesh.positions, out, s.wrinkle, [], s.collisionMargin));
    let maxD = 0;
    for (let i = 0; i < out.length; i++) maxD = Math.max(maxD, Math.abs(out[i]! - gg.mesh.positions[i]!));
    expect(maxD).toBeLessThan(0.05);
  }, 120000);

  it('memoria estable: sin asignar buffers tipados por paso', () => {
    const s = createClothSolver(g, quiet);
    const out = new Float32Array(n * 3);
    const sk = new Float32Array(n * 3);
    const caps = skirtCapsules();
    for (let f = 0; f < 50; f++) {
      const pose = poseSkirt(g.mesh.positions, sk, f / 60);
      s.step(FRAME, sk, poseCapsules(caps, pose), out);
    }
    const before = process.memoryUsage().arrayBuffers;
    const heapBefore = process.memoryUsage().heapUsed;
    const capsFixed = poseCapsules(caps, { yaw: 0.1, roll: 0.05, dx: 0.01, dz: 0 });
    for (let f = 0; f < 4000; f++) {
      poseSkirt(g.mesh.positions, sk, f / 60);
      s.step(FRAME, sk, capsFixed, out);
    }
    const after = process.memoryUsage().arrayBuffers;
    expect(after - before).toBeLessThan(256 * 1024);
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(40 * 1024 * 1024);
  });
});

describe('propiedades (fast-check)', () => {
  it('para cualquier malla pequeña, pose rígida, dt y cápsulas: salida finita, correa y penetración dentro de tolerancia', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 14 }),
        fc.integer({ min: 4, max: 20 }),
        fc.double({ min: 0, max: 0.2, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 0.12, noNaN: true }),
        fc.double({ min: 0.3, max: 3, noNaN: true }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (rings, segs, dt, stiffness, damping, hemMax, amp, seed) => {
          const gg = makeSkirt({
            rings,
            segments: segs,
            stiffness,
            damping,
            hemMaxDistance: hemMax,
          });
          const m = gg.mesh.positions.length / 3;
          const s = createClothSolver(gg, { particleBudget: 40, ...quiet });
          const sk = new Float32Array(m * 3);
          const out = new Float32Array(m * 3);
          const caps0 = skirtCapsules();
          const r = rng(seed);
          for (let f = 0; f < 40; f++) {
            const pose = poseSkirt(gg.mesh.positions, sk, f * 0.02 + r(), amp);
            const caps = poseCapsules(caps0, pose);
            s.step(dt, sk, caps, out);
            expectClean(check(gg, sk, out, s.wrinkle, caps, s.collisionMargin));
          }
        },
      ),
      { numRuns: 60, seed: 123456 },
    );
  });

  it('la correa por vértice se respeta aunque maxDistance/invMass tengan valores raros', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.double({ min: -1, max: 3, noNaN: true }), fc.constant(NaN), fc.constant(Infinity), fc.constant(-Infinity), fc.constant(0)), {
          minLength: 7 * 12,
          maxLength: 7 * 12,
        }),
        fc.array(fc.oneof(fc.double({ min: -1, max: 2, noNaN: true }), fc.constant(NaN), fc.constant(Infinity), fc.constant(0)), {
          minLength: 7 * 12,
          maxLength: 7 * 12,
        }),
        (md, im) => {
          const gg = makeSkirt({ rings: 6, segments: 12 });
          const n2 = gg.mesh.positions.length / 3;
          expect(n2).toBe(84);
          const g2: GarmentGeometry = {
            ...gg,
            cloth: { ...gg.cloth, maxDistance: Float32Array.from(md), invMass: Float32Array.from(im) },
          };
          const s = createClothSolver(g2, quiet);
          const sk = new Float32Array(n2 * 3);
          const out = new Float32Array(n2 * 3);
          for (let f = 0; f < 15; f++) {
            poseSkirt(gg.mesh.positions, sk, f * 0.05, 2);
            s.step(FRAME, sk, [], out);
            const c = check(g2, sk, out, s.wrinkle, [], s.collisionMargin);
            expect(c.nonFinite).toBe(0);
            // la correa efectiva ya está saneada: negativa/NaN → 0; Inf → ≤ 1 m
            expect(c.maxLeashExcess).toBeLessThanOrEqual(1e-4);
          }
        },
      ),
      { numRuns: 40, seed: 99 },
    );
  });
});

describe('rendimiento (cota holgada; las cifras reales van en el informe)', () => {
  it('50 k vértices de render: construcción y paso dentro de presupuesto', () => {
    const g = makeSkirt({ rings: 200, segments: 250 });
    const n = g.mesh.positions.length / 3;
    expect(n).toBeGreaterThan(50000);
    const t0 = performance.now();
    const s = createClothSolver(g, quiet);
    const build = performance.now() - t0;
    expect(s.particleCount).toBeLessThanOrEqual(2500);
    const sk = new Float32Array(n * 3);
    const out = new Float32Array(n * 3);
    const caps0 = skirtCapsules();
    const times: number[] = [];
    for (let f = 0; f < 150; f++) {
      const pose = poseSkirt(g.mesh.positions, sk, f / 60);
      const caps = poseCapsules(caps0, pose);
      const a = performance.now();
      s.step(FRAME, sk, caps, out);
      times.push(performance.now() - a);
    }
    times.sort((x, y) => x - y);
    const median = times[Math.floor(times.length / 2)]!;
    // objetivo de producción: ≤ 4 ms; la cota del test es holgada para máquinas cargadas/CI
    expect(median).toBeLessThan(10);
    expect(build).toBeLessThan(5000);
  }, 60000);
});
