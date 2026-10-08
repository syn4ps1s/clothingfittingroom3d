import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  J,
  LM,
  JOINT_NAMES,
  REFERENCE_MEASUREMENTS,
  buildRestSkeleton,
  type Measurements,
  type PoseFrame,
} from '@fitroom/shared';
import { createSyntheticPoseProvider } from './synthetic.js';
import { createPoseRetargeter, poseToSkeleton } from './retarget.js';
import { ALL_POSE_NAMES, samplePlausiblePose, evalPose, type AnyPoseName } from './poses.js';
import { jointPositionErrors, poseIsSane, roundTrip } from './testing.js';
import { mulberry32 } from './geom.js';
import { defaultMeasurementsForHeight } from './rig.js';

const cm = (m: number): string => (m * 100).toFixed(2);

describe('poseToSkeleton — ida y vuelta con el proveedor sintético', () => {
  const observed: Record<string, number> = {};

  for (const [name, m] of Object.entries(REFERENCE_MEASUREMENTS)) {
    const rest = buildRestSkeleton(m);
    for (const pose of ALL_POSE_NAMES.filter((p) => p !== 'jitter')) {
      it(`${name} / ${pose}: error de articulaciones < 1,5 cm`, () => {
        const prov = createSyntheticPoseProvider({
          heightCm: m.heightCm,
          measurements: m,
          script: [{ pose, durationMs: 4000 }],
        });
        let worst = 0;
        let worstJoint = '';
        for (let t = 0; t < 4000; t += 97) {
          const frame = prov.frameAt(t)!;
          const out = poseToSkeleton(frame, rest, prov.camera);
          expect(out, `${pose}@${t}`).not.toBeNull();
          expect(poseIsSane(out!)).toBe(true);
          const errs = jointPositionErrors(rest, prov.groundTruth(t), out!);
          errs.forEach((e, j) => {
            if (e > worst) {
              worst = e;
              worstJoint = JOINT_NAMES[j]!;
            }
          });
        }
        observed[`${name}/${pose}`] = worst;
        // `lean` flexiona ≈ 20° el tronco: la curvatura de columna no es observable (ver ACCURACY.md)
        const limit = pose === 'lean' ? 0.025 : 0.015;
        expect(worst, `peor articulación ${worstJoint}`).toBeLessThan(limit);
      });
    }
  }

  it('informa del máximo observado', () => {
    const entries = Object.entries(observed);
    expect(entries.length).toBeGreaterThan(0);
    const max = Math.max(...entries.map(([, v]) => v));
    const worst = entries.find(([, v]) => v === max)!;
    console.warn(`[round-trip] máximo observado: ${cm(max)} cm en ${worst[0]}`);
  });
});

describe('poseToSkeleton — propiedades con poses aleatorias plausibles', () => {
  it('error de articulaciones: p99 < 1,5 cm; extremidades < 1 cm; tronco/cuello/cabeza < 3 cm', () => {
    const rest = buildRestSkeleton(REFERENCE_MEASUREMENTS.adultA);
    const all: number[] = [];
    const limbs: number[] = [];
    const inferred: number[] = [];
    // articulaciones SIN landmark propio: dependen de la curvatura (no observable) de la columna
    const inferredSet = new Set<number>([
      J.spine,
      J.chest,
      J.neck,
      J.head,
      J.l_clavicle,
      J.r_clavicle,
    ]);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 30 }), (seed) => {
        const st = samplePlausiblePose(mulberry32(seed));
        const r = roundTrip(rest, st);
        expect(r.estimate).not.toBeNull();
        expect(poseIsSane(r.estimate!)).toBe(true);
        r.errors.forEach((e, j) => {
          all.push(e);
          (inferredSet.has(j) ? inferred : limbs).push(e);
        });
      }),
      { seed: 20260101, numRuns: 400 },
    );
    const sorted = [...all].sort((a, b) => a - b);
    const p99 = sorted[Math.floor(sorted.length * 0.99)]!;
    const maxLimbs = Math.max(...limbs);
    const maxInf = Math.max(...inferred);
    console.warn(
      `[aleatorias] n=${all.length} mediana=${cm(sorted[sorted.length >> 1]!)} cm p99=${cm(p99)} cm ` +
        `máx(extremidades)=${cm(maxLimbs)} cm máx(inferidas)=${cm(maxInf)} cm`,
    );
    expect(p99).toBeLessThan(0.015);
    expect(maxLimbs).toBeLessThan(0.01);
    expect(maxInf).toBeLessThan(0.03);
  });

  it('robusto a la estatura (120–230 cm), FOV (40°–80°) y distancia (2–5 m)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 120, max: 230 }),
        fc.integer({ min: 40, max: 80 }),
        fc.double({ min: 2, max: 5, noNaN: true }),
        fc.integer({ min: 1, max: 2 ** 30 }),
        (h, fov, dist, seed) => {
          const m = defaultMeasurementsForHeight(h);
          const rest = buildRestSkeleton(m);
          const st = samplePlausiblePose(mulberry32(seed));
          const r = roundTrip(rest, st, {
            camera: { verticalFovDeg: fov, aspect: 16 / 9 },
            distanceM: dist,
          });
          expect(r.estimate).not.toBeNull();
          expect(poseIsSane(r.estimate!)).toBe(true);
          // las articulaciones fuera de cuadro (visibilidad ~0) pueden desviarse; las de dentro no
          const inside = (lm: number): boolean => {
            const p = r.frame.image[lm]!;
            return p.x > 0.02 && p.x < 0.98 && p.y > 0.02 && p.y < 0.98;
          };
          const allIn = Object.values(LM).every(inside);
          if (allIn) expect(Math.max(...r.errors) / rest.height).toBeLessThan(0.02);
        },
      ),
      { seed: 7, numRuns: 200 },
    );
  });

  it('la raíz coincide con la verdad (profundidad por pinhole)', () => {
    const rest = buildRestSkeleton(REFERENCE_MEASUREMENTS.adultB);
    for (const dist of [2, 3, 5]) {
      const r = roundTrip(rest, evalPose('a-pose', 0, 1000), { distanceM: dist });
      expect(r.estimate).not.toBeNull();
      const e = r.estimate!.rootPosition.map((v, i) => v - r.truth.rootPosition[i]!);
      expect(Math.hypot(...e)).toBeLessThan(0.005);
    }
  });
});

describe('poseToSkeleton — casos de borde y adversariales', () => {
  const m: Measurements = REFERENCE_MEASUREMENTS.adultA;
  const rest = buildRestSkeleton(m);
  const prov = createSyntheticPoseProvider({
    heightCm: m.heightCm,
    measurements: m,
    script: [{ pose: 'arms-up', durationMs: 2000 }],
  });
  const base = prov.frameAt(1500)!;
  const camera = prov.camera;

  const mapFrame = (
    f: PoseFrame,
    fn: (i: number) => { x?: number; y?: number; z?: number; v?: number },
  ): PoseFrame => ({
    ...f,
    image: f.image.map((l, i) => {
      const o = fn(i);
      return { x: o.x ?? l.x, y: o.y ?? l.y, z: o.z ?? l.z, visibility: o.v ?? l.visibility };
    }),
    world: f.world.map((l, i) => {
      const o = fn(i);
      return { x: o.x ?? l.x, y: o.y ?? l.y, z: o.z ?? l.z, visibility: o.v ?? l.visibility };
    }),
  });

  it('todas las visibilidades 0 ⇒ null', () => {
    expect(
      poseToSkeleton(
        mapFrame(base, () => ({ v: 0 })),
        rest,
        camera,
      ),
    ).toBeNull();
  });

  it('visibilidad NaN / negativa / >1 no rompe nada', () => {
    for (const v of [NaN, -3, 7, Infinity]) {
      const out = poseToSkeleton(
        mapFrame(base, () => ({ v })),
        rest,
        camera,
      );
      if (out) expect(poseIsSane(out)).toBe(true);
    }
  });

  it('NaN / ±Inf en cualquier landmark ⇒ salida finita o null (nunca excepción)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 32 }),
        fc.constantFrom(NaN, Infinity, -Infinity, 1e300, -1e300),
        fc.constantFrom('x', 'y', 'z') as fc.Arbitrary<'x' | 'y' | 'z'>,
        (idx, bad, coord) => {
          const f = mapFrame(base, (i) => (i === idx ? { [coord]: bad } : {}));
          const out = poseToSkeleton(f, rest, camera);
          if (out) expect(poseIsSane(out)).toBe(true);
        },
      ),
      { seed: 11, numRuns: 200 },
    );
  });

  it('coordenadas de imagen fuera de [0,1] o no finitas', () => {
    for (const bad of [-5, 9, NaN, Infinity]) {
      const out = poseToSkeleton(
        mapFrame(base, () => ({ x: bad, y: bad })),
        rest,
        camera,
      );
      if (out) expect(poseIsSane(out)).toBe(true);
    }
  });

  it('frame con landmarks insuficientes o vacíos', () => {
    const short: PoseFrame = {
      ...base,
      world: base.world.slice(0, 5),
      image: base.image.slice(0, 5),
    };
    const out = poseToSkeleton(short, rest, camera);
    if (out) expect(poseIsSane(out)).toBe(true);
    const empty: PoseFrame = { ...base, world: [], image: [] };
    expect(poseToSkeleton(empty, rest, camera)).toBeNull();
  });

  it('persona de espaldas (180°): raíz girada ≈ π y sin NaN', () => {
    const back = createSyntheticPoseProvider({
      heightCm: m.heightCm,
      measurements: m,
      baseYawDeg: 180,
      script: [{ pose: 'a-pose', durationMs: 1000 }],
    });
    const f = back.frameAt(200)!;
    // de espaldas el hombro izquierdo queda a la izquierda de la imagen
    expect(f.image[LM.l_shoulder]!.x).toBeLessThan(f.image[LM.r_shoulder]!.x);
    const out = poseToSkeleton(f, rest, back.camera)!;
    expect(poseIsSane(out)).toBe(true);
    const errs = jointPositionErrors(rest, back.groundTruth(200), out);
    expect(Math.max(...errs)).toBeLessThan(0.015);
  });

  it('timestamps repetidos / hacia atrás no afectan (el retargeting es por fotograma)', () => {
    const rt = createPoseRetargeter(rest, camera);
    const a = rt.update({ ...base, timestampMs: 100 })!;
    const b = rt.update({ ...base, timestampMs: 100 })!;
    const c = rt.update({ ...base, timestampMs: 50 })!;
    for (const p of [a, b, c]) expect(poseIsSane(p)).toBe(true);
    const d = rt.update({ ...base, timestampMs: NaN })!;
    expect(poseIsSane(d)).toBe(true);
  });

  it('salto de 5 m entre fotogramas: sigue siendo coherente y finito', () => {
    const jump = createSyntheticPoseProvider({
      heightCm: m.heightCm,
      measurements: m,
      script: [{ pose: 'a-pose', durationMs: 2000 }],
      faults: { teleports: [{ atMs: 1000, dxM: 5, dzM: -3, durationMs: 100 }] },
    });
    const rt = createPoseRetargeter(rest, jump.camera);
    for (let t = 900; t < 1300; t += 33) {
      const f = jump.frameAt(t);
      if (!f) continue;
      const out = rt.update(f);
      if (out) expect(poseIsSane(out)).toBe(true);
    }
  });

  it('articulaciones con baja visibilidad se mezclan con el reposo (sin parpadeos)', () => {
    const occl = (v: number): PoseFrame =>
      mapFrame(base, (i) =>
        i === LM.l_wrist ||
        i === LM.l_elbow ||
        i === LM.l_pinky ||
        i === LM.l_index ||
        i === LM.l_thumb
          ? { v }
          : {},
      );
    const angleOf = (r: readonly number[]): number => 2 * Math.acos(Math.min(1, Math.abs(r[3]!)));
    // sin estado: la rotación del brazo/antebrazo evoluciona de forma continua hasta el reposo exacto
    const vs = [0.99, 0.6, 0.45, 0.35, 0.25, 0.15, 0.05, 0];
    const ua = vs.map((v) =>
      angleOf(poseToSkeleton(occl(v), rest, camera)!.rotations[J.l_upper_arm]!),
    );
    const fa = vs.map((v) =>
      angleOf(poseToSkeleton(occl(v), rest, camera)!.rotations[J.l_forearm]!),
    );
    for (let i = 1; i < ua.length; i++) expect(ua[i]!).toBeLessThanOrEqual(ua[i - 1]! + 1e-9);
    for (let i = 1; i < fa.length; i++) expect(Math.abs(fa[i]! - fa[i - 1]!)).toBeLessThan(0.5);
    expect(ua[0]!).toBeGreaterThan(1.5); // brazos arriba: gran rotación respecto al reposo
    expect(ua[ua.length - 1]!).toBeLessThan(1e-9);
    expect(fa[fa.length - 1]!).toBeLessThan(1e-9);
    // con estado: cuando pasa `holdMs` se vuelve despacio al reposo, sin saltos
    const rts = createPoseRetargeter(rest, camera, { holdMs: 100 });
    rts.update({ ...base, timestampMs: 0 });
    const decay: number[] = [];
    for (let t = 33; t <= 3000; t += 33) {
      const out = rts.update({ ...occl(0), timestampMs: t })!;
      decay.push(angleOf(out.rotations[J.l_forearm]!));
    }
    for (let i = 1; i < decay.length; i++) {
      expect(decay[i]!).toBeLessThanOrEqual(decay[i - 1]! + 1e-9);
      expect(decay[i - 1]! - decay[i]!).toBeLessThan(0.2); // sin saltos bruscos
    }
    expect(decay[decay.length - 1]!).toBeLessThan(1e-6);
  });

  it('retargeter con estado mantiene la última pose buena durante una oclusión corta', () => {
    const rts = createPoseRetargeter(rest, camera, { holdMs: 1000 });
    const good = rts.update({ ...base, timestampMs: 1000 })!;
    const occluded = mapFrame(base, (i) =>
      [LM.l_wrist, LM.l_elbow, LM.l_pinky, LM.l_index, LM.l_thumb].includes(i as 15)
        ? { v: 0 }
        : {},
    );
    const out = rts.update({ ...occluded, timestampMs: 1033 })!;
    const a = good.rotations[J.l_forearm]!;
    const b = out.rotations[J.l_forearm]!;
    const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
    expect(dot).toBeGreaterThan(0.9999);
  });

  it('estaturas extremas con parámetros inválidos de cámara se saneaban', () => {
    const out = poseToSkeleton(base, rest, { verticalFovDeg: NaN, aspect: -1 });
    if (out) expect(poseIsSane(out)).toBe(true);
  });

  it('nombres de pose cubiertos', () => {
    const names: AnyPoseName[] = [...ALL_POSE_NAMES];
    expect(names.length).toBeGreaterThanOrEqual(7);
  });
});
