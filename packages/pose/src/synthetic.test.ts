import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { J, LM, REFERENCE_MEASUREMENTS, buildRestSkeleton, v3 } from '@fitroom/shared';
import { createSyntheticPoseProvider, synthesizeFrame, skeletonFromState } from './synthetic.js';
import { ALL_POSE_NAMES, evalPose, blendPoseStates, samplePlausiblePose } from './poses.js';
import { gaussian, hash32, mulberry32 } from './geom.js';
import { defaultMeasurementsForHeight, restLandmarks } from './rig.js';
import { rasterizeMeshMask, renderCapsuleMask, ellipseAxes } from './silhouette.js';

const m = REFERENCE_MEASUREMENTS.adultA;
const mk = (extra: Partial<Parameters<typeof createSyntheticPoseProvider>[0]> = {}) =>
  createSyntheticPoseProvider({
    heightCm: m.heightCm,
    measurements: m,
    script: [{ pose: 'a-pose', durationMs: 2000 }],
    ...extra,
  });

describe('createSyntheticPoseProvider — contrato y convenciones', () => {
  it('33 landmarks en imagen y world, visibilidad en [0,1], todo finito', () => {
    const p = mk();
    const f = p.frameAt(500)!;
    expect(f.image).toHaveLength(33);
    expect(f.world).toHaveLength(33);
    expect(f.personCount).toBe(1);
    for (const l of [...f.image, ...f.world]) {
      expect(Number.isFinite(l.x + l.y + l.z)).toBe(true);
      expect(l.visibility).toBeGreaterThanOrEqual(0);
      expect(l.visibility).toBeLessThanOrEqual(1);
    }
  });

  it('convención: +X izquierda de la persona (derecha de la imagen), +Y arriba, +Z hacia la cámara', () => {
    const f = mk().frameAt(100)!;
    const w = f.world;
    expect(w[LM.l_shoulder]!.x).toBeGreaterThan(w[LM.r_shoulder]!.x);
    expect(w[LM.l_hip]!.x).toBeGreaterThan(w[LM.r_hip]!.x);
    expect(w[LM.nose]!.y).toBeGreaterThan(w[LM.l_shoulder]!.y);
    expect(w[LM.l_shoulder]!.y).toBeGreaterThan(w[LM.l_hip]!.y);
    expect(w[LM.l_hip]!.y).toBeGreaterThan(w[LM.l_knee]!.y);
    expect(w[LM.l_knee]!.y).toBeGreaterThan(w[LM.l_ankle]!.y);
    // la nariz y la punta del pie están por delante (hacia la cámara) del cuerpo
    expect(w[LM.nose]!.z).toBeGreaterThan(w[LM.l_ear]!.z);
    expect(w[LM.l_foot_index]!.z).toBeGreaterThan(w[LM.l_heel]!.z);
    // imagen SIN espejar: el lado izquierdo de la persona queda a la derecha de la imagen
    expect(f.image[LM.l_shoulder]!.x).toBeGreaterThan(f.image[LM.r_shoulder]!.x);
    // arriba en el mundo = y menor en la imagen
    expect(f.image[LM.nose]!.y).toBeLessThan(f.image[LM.l_ankle]!.y);
    // origen de world en el centro de caderas
    const mid = [
      (w[LM.l_hip]!.x + w[LM.r_hip]!.x) / 2,
      (w[LM.l_hip]!.y + w[LM.r_hip]!.y) / 2,
      (w[LM.l_hip]!.z + w[LM.r_hip]!.z) / 2,
    ];
    for (const c of mid) expect(Math.abs(c)).toBeLessThan(1e-9);
  });

  it('las proporciones del esqueleto se respetan (hombros, estatura, brazo)', () => {
    const f = mk().frameAt(100)!;
    const w = f.world;
    const d = (a: number, b: number): number =>
      Math.hypot(w[a]!.x - w[b]!.x, w[a]!.y - w[b]!.y, w[a]!.z - w[b]!.z);
    expect(d(LM.l_shoulder, LM.r_shoulder)).toBeCloseTo(m.shoulderWidthCm / 100, 4);
    expect(d(LM.l_shoulder, LM.l_elbow) + d(LM.l_elbow, LM.l_wrist)).toBeCloseTo(
      m.armLengthCm / 100,
      4,
    );
  });

  it('la persona queda dentro de cuadro con la cámara por defecto', () => {
    const f = mk().frameAt(100)!;
    for (const l of f.image) {
      expect(l.x).toBeGreaterThan(0);
      expect(l.x).toBeLessThan(1);
      expect(l.y).toBeGreaterThan(0);
      expect(l.y).toBeLessThan(1);
    }
  });

  it('el pie queda apoyado en el suelo (talón/punta a y = −altura de cámara)', () => {
    const p = mk({ script: [{ pose: 'sit', durationMs: 3000 }] });
    for (const t of [0, 1000, 2500]) {
      const gt = p.groundTruth(t);
      expect(gt.rootPosition[1]).toBeGreaterThan(-p.cameraHeightM);
    }
    const f = p.frameAt(2500)!;
    expect(f.image[LM.l_heel]!.y).toBeLessThan(1);
  });
});

describe('createSyntheticPoseProvider — determinismo y ruido', () => {
  it('misma semilla ⇒ mismos fotogramas (independiente del orden de las llamadas)', () => {
    const a = mk({ seed: 7, noiseSigmaM: 0.01 });
    const b = mk({ seed: 7, noiseSigmaM: 0.01 });
    const fa = [a.frameAt(100), a.frameAt(900), a.frameAt(100)];
    const fb = [b.frameAt(900), b.frameAt(100)];
    expect(fa[0]).toEqual(fa[2]);
    expect(fa[1]).toEqual(fb[0]);
    expect(fa[0]).toEqual(fb[1]);
  });

  it('semillas distintas ⇒ ruido distinto; sin ruido ⇒ idéntico', () => {
    const a = mk({ seed: 1, noiseSigmaM: 0.01 }).frameAt(100)!;
    const b = mk({ seed: 2, noiseSigmaM: 0.01 }).frameAt(100)!;
    expect(a.world[LM.nose]!.x).not.toBe(b.world[LM.nose]!.x);
    const c = mk({ seed: 1 }).frameAt(100)!;
    const d = mk({ seed: 2 }).frameAt(100)!;
    expect(c).toEqual(d);
  });

  it('el ruido world es gaussiano con la σ pedida', () => {
    const sigma = 0.01;
    const clean = mk({ seed: 5 });
    const noisy = mk({ seed: 5, noiseSigmaM: sigma });
    const xs: number[] = [];
    for (let t = 0; t < 2000; t += 3) {
      xs.push(noisy.frameAt(t)!.world[LM.l_wrist]!.x - clean.frameAt(t)!.world[LM.l_wrist]!.x);
    }
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    expect(Math.abs(mean)).toBeLessThan(0.0015);
    expect(sd).toBeGreaterThan(0.85 * sigma);
    expect(sd).toBeLessThan(1.15 * sigma);
  });

  it('detect usa la marca de tiempo recibida y es determinista; dispose es idempotente', async () => {
    const p = mk({ seed: 3, noiseSigmaM: 0.005 });
    await p.init();
    const f1 = p.detect({}, 400)!;
    const f2 = p.detect({}, 400)!;
    expect(f1).toEqual(f2);
    expect(f1.timestampMs).toBe(400);
    p.dispose();
    p.dispose();
    expect(p.detect({}, 400)).toBeNull();
    expect(p.detect({}, NaN)).toBeNull();
  });

  it('startAtFirstDetect: el guion arranca en la primera llamada', () => {
    const p = mk({
      script: [
        { pose: 'a-pose', durationMs: 1000 },
        { pose: 't-pose', durationMs: 1000 },
      ],
      startAtFirstDetect: true,
      transitionMs: 0,
    });
    const first = p.detect({}, 123456)!;
    const later = p.detect({}, 123456 + 1500)!;
    expect(first.world[LM.l_wrist]!.y).toBeLessThan(later.world[LM.l_wrist]!.y - 0.1);
  });

  it('hash32 y gaussian: propiedades básicas', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        expect(hash32(a, b)).toBe(hash32(a, b));
        expect(hash32(a, b)).toBeGreaterThanOrEqual(0);
        expect(hash32(a, b)).toBeLessThan(2 ** 32);
      }),
    );
    const r = mulberry32(1);
    for (let i = 0; i < 1000; i++) expect(Number.isFinite(gaussian(r))).toBe(true);
  });
});

describe('createSyntheticPoseProvider — guiones', () => {
  it('t-pose: brazos horizontales; arms-up: manos por encima de la cabeza', () => {
    const t = mk({ script: [{ pose: 't-pose', durationMs: 1000 }] }).frameAt(500)!;
    expect(Math.abs(t.world[LM.l_wrist]!.y - t.world[LM.l_shoulder]!.y)).toBeLessThan(0.01);
    expect(t.world[LM.l_wrist]!.x).toBeGreaterThan(0.5);
    const u = mk({ script: [{ pose: 'arms-up', durationMs: 2000 }] }).frameAt(1500)!;
    expect(u.world[LM.l_wrist]!.y).toBeGreaterThan(u.world[LM.nose]!.y);
    expect(u.world[LM.r_wrist]!.y).toBeGreaterThan(u.world[LM.nose]!.y);
  });

  it('turn: llega de perfil (línea de hombros paralela al eje Z) y vuelve de frente', () => {
    const p = mk({ script: [{ pose: 'turn', durationMs: 4000 }] });
    const shoulderLine = (t: number): number => {
      const w = p.frameAt(t)!.world;
      const dx = w[LM.l_shoulder]!.x - w[LM.r_shoulder]!.x;
      const dz = w[LM.l_shoulder]!.z - w[LM.r_shoulder]!.z;
      return Math.abs(dz) / Math.hypot(dx, dz);
    };
    expect(shoulderLine(0)).toBeLessThan(0.05);
    expect(shoulderLine(1999)).toBeGreaterThan(0.99);
    expect(shoulderLine(3999)).toBeLessThan(0.05);
    // de perfil, el lado lejano queda con visibilidad reducida
    const w = p.frameAt(2000)!.world;
    const vis = [w[LM.l_shoulder]!.visibility, w[LM.r_shoulder]!.visibility].sort();
    expect(vis[0]!).toBeLessThan(0.6);
  });

  it('walk: las piernas oscilan en contrafase y el pie permanece sobre el suelo', () => {
    const p = mk({ script: [{ pose: 'walk', durationMs: 4000 }] });
    const ys: number[] = [];
    for (let t = 0; t < 2000; t += 50) {
      const w = p.frameAt(t)!.world;
      ys.push(w[LM.l_ankle]!.z - w[LM.r_ankle]!.z);
      const gt = p.groundTruth(t);
      expect(Number.isFinite(gt.rootPosition[1])).toBe(true);
    }
    expect(Math.max(...ys)).toBeGreaterThan(0.1);
    expect(Math.min(...ys)).toBeLessThan(-0.1);
  });

  it('sit: los muslos quedan casi horizontales y la pelvis baja', () => {
    const p = mk({ script: [{ pose: 'sit', durationMs: 3000 }] });
    const w = p.frameAt(2800)!.world;
    expect(Math.abs(w[LM.l_hip]!.y - w[LM.l_knee]!.y)).toBeLessThan(0.08);
    const standing = mk({ script: [{ pose: 'a-pose', durationMs: 3000 }] }).groundTruth(100);
    expect(p.groundTruth(2800).rootPosition[1]).toBeLessThan(standing.rootPosition[1] - 0.2);
  });

  it('fundido entre tramos continuo (sin saltos de más de 15 cm entre fotogramas a 30 fps)', () => {
    const p = mk({
      script: [
        { pose: 'a-pose', durationMs: 500 },
        { pose: 'arms-up', durationMs: 1500 },
        { pose: 'sit', durationMs: 1500 },
      ],
    });
    let prev = p.frameAt(0)!;
    for (let t = 33; t < 3500; t += 33) {
      const f = p.frameAt(t)!;
      for (const i of [LM.l_wrist, LM.r_ankle, LM.nose]) {
        const d = Math.hypot(
          f.world[i]!.x - prev.world[i]!.x,
          f.world[i]!.y - prev.world[i]!.y,
          f.world[i]!.z - prev.world[i]!.z,
        );
        expect(d).toBeLessThan(0.3);
      }
      prev = f;
    }
  });

  it('endBehavior: hold mantiene, loop repite, none devuelve null', () => {
    const base = { script: [{ pose: 'walk' as const, durationMs: 1000 }] };
    const hold = mk(base);
    expect(hold.frameAt(5000)!.world).toEqual(hold.frameAt(9000)!.world);
    const loop = mk({ ...base, endBehavior: 'loop' });
    expect(loop.frameAt(300)!.world[LM.l_wrist]).toEqual(loop.frameAt(2300)!.world[LM.l_wrist]);
    const none = mk({ ...base, endBehavior: 'none' });
    expect(none.frameAt(5000)).toBeNull();
    expect(none.frameAt(500)).not.toBeNull();
  });

  it('valida el guion', () => {
    expect(() => mk({ script: [{ pose: 'a-pose', durationMs: 0 }] })).toThrow(RangeError);
    expect(() => mk({ script: [{ pose: 'a-pose', durationMs: NaN }] })).toThrow(RangeError);
    expect(() => mk({ script: [{ pose: 'nope' as 'a-pose', durationMs: 10 }] })).toThrow(
      RangeError,
    );
    const empty = mk({ script: [] });
    expect(empty.frameAt(0)).not.toBeNull();
    expect(empty.durationMs).toBe(0);
  });

  it('todas las poses (incluidas las extra) generan fotogramas válidos', () => {
    for (const pose of ALL_POSE_NAMES) {
      const p = mk({ script: [{ pose, durationMs: 2000 }] });
      for (let t = 0; t < 2000; t += 200) {
        const f = p.frameAt(t)!;
        expect(f).not.toBeNull();
        for (const l of f.world) expect(Number.isFinite(l.x + l.y + l.z)).toBe(true);
      }
    }
  });
});

describe('createSyntheticPoseProvider — opciones adversariales', () => {
  it('dropouts y dropoutRate devuelven null de forma determinista', () => {
    const p = mk({ faults: { dropouts: [{ fromMs: 500, toMs: 800 }] } });
    expect(p.frameAt(600)).toBeNull();
    expect(p.frameAt(400)).not.toBeNull();
    expect(p.frameAt(800)).not.toBeNull();
    const q1 = mk({ seed: 2, faults: { dropoutRate: 0.3 } });
    const q2 = mk({ seed: 2, faults: { dropoutRate: 0.3 } });
    let nulls = 0;
    for (let t = 0; t < 3000; t++) {
      const a = q1.frameAt(t);
      expect(a === null).toBe(q2.frameAt(t) === null);
      if (a === null) nulls++;
    }
    expect(nulls / 3000).toBeGreaterThan(0.2);
    expect(nulls / 3000).toBeLessThan(0.4);
  });

  it('oclusiones por grupo y por índices', () => {
    const p = mk({
      faults: {
        occlusions: [
          { fromMs: 0, toMs: 1000, landmarks: 'legs', visibility: 0.1 },
          { fromMs: 0, toMs: 1000, landmarks: [LM.l_wrist] },
        ],
      },
    });
    const f = p.frameAt(500)!;
    expect(f.image[LM.l_knee]!.visibility).toBeLessThanOrEqual(0.1);
    expect(f.world[LM.r_ankle]!.visibility).toBeLessThanOrEqual(0.1);
    expect(f.world[LM.l_wrist]!.visibility).toBeLessThanOrEqual(0.05);
    expect(f.world[LM.r_wrist]!.visibility).toBeGreaterThan(0.9);
    const g = p.frameAt(1500)!;
    expect(g.world[LM.l_knee]!.visibility).toBeGreaterThan(0.9);
    for (const grp of [
      'left-arm',
      'right-arm',
      'arms',
      'left-leg',
      'right-leg',
      'lower-body',
      'face',
    ] as const) {
      const h = mk({ faults: { occlusions: [{ fromMs: 0, toMs: 100, landmarks: grp }] } }).frameAt(
        10,
      )!;
      expect(Math.min(...h.world.map((l) => l.visibility))).toBeLessThanOrEqual(0.05);
    }
  });

  it('personas extra y salida de cuadro', () => {
    const p = mk({
      faults: {
        extraPeople: [{ fromMs: 200, toMs: 400, count: 2 }],
        walkOuts: [{ fromMs: 1000, toMs: 2000, side: 'right' }],
      },
      script: [{ pose: 'a-pose', durationMs: 3000 }],
    });
    expect(p.frameAt(100)!.personCount).toBe(1);
    expect(p.frameAt(300)!.personCount).toBe(3);
    // a mitad de la salida la persona ya no está en cuadro
    expect(p.frameAt(1500)).toBeNull();
    // antes de salir hay landmarks fuera de cuadro con visibilidad baja
    let sawPartial = false;
    for (let t = 1000; t < 1500; t += 20) {
      const f = p.frameAt(t);
      if (!f) continue;
      const out = f.image.filter((l) => l.x > 1.04);
      if (out.length > 0) {
        sawPartial = true;
        for (const l of out) expect(l.visibility).toBeLessThan(0.5);
      }
    }
    expect(sawPartial).toBe(true);
  });

  it('teleport: salto de 5 m en un fotograma y recuperación', () => {
    const p = mk({ faults: { teleports: [{ atMs: 1000, dxM: 5, dzM: -2, durationMs: 33 }] } });
    const a = p.frameAt(990);
    const b = p.frameAt(1010);
    const c = p.frameAt(1100);
    expect(a).not.toBeNull();
    expect(c).not.toBeNull();
    if (b) expect(Math.abs(b.image[LM.nose]!.x - a!.image[LM.nose]!.x)).toBeGreaterThan(0.2);
    expect(c!.image[LM.nose]!.x).toBeCloseTo(a!.image[LM.nose]!.x, 6);
  });

  it('de espaldas: izquierda/derecha invertidas en imagen, cara con visibilidad baja', () => {
    const f = mk({ baseYawDeg: 180 }).frameAt(100)!;
    expect(f.image[LM.l_shoulder]!.x).toBeLessThan(f.image[LM.r_shoulder]!.x);
    expect(f.world[LM.nose]!.visibility).toBeLessThan(0.3);
    expect(f.world[LM.nose]!.z).toBeLessThan(f.world[LM.l_ear]!.z + 0.2); // la nariz mira hacia −Z
  });

  it('cámara y distancia: FOV y distancia cambian el tamaño aparente', () => {
    const near = mk({ distanceM: 2 }).frameAt(100)!;
    const far = mk({ distanceM: 5 }).frameAt(100)!;
    const hNear = near.image[LM.l_ankle]!.y - near.image[LM.nose]!.y;
    const hFar = far.image[LM.l_ankle]!.y - far.image[LM.nose]!.y;
    expect(hNear / hFar).toBeGreaterThan(2);
    const wide = mk({ camera: { verticalFovDeg: 80, aspect: 16 / 9 }, distanceM: 3 }).frameAt(100)!;
    const tele = mk({ camera: { verticalFovDeg: 40, aspect: 16 / 9 }, distanceM: 3 }).frameAt(100)!;
    expect(tele.image[LM.l_ankle]!.y - tele.image[LM.nose]!.y).toBeGreaterThan(
      wide.image[LM.l_ankle]!.y - wide.image[LM.nose]!.y,
    );
  });

  it('cámara a 2 m con FOV estrecho deja pies fuera de cuadro con visibilidad baja', () => {
    const f = mk({ distanceM: 2, camera: { verticalFovDeg: 40, aspect: 4 / 3 } }).frameAt(100)!;
    const feet = f.image[LM.l_foot_index]!;
    expect(feet.y).toBeGreaterThan(1);
    expect(feet.visibility).toBeLessThan(0.1);
  });

  it('estaturas extremas: 120 y 230 cm generan cuerpos válidos', () => {
    for (const h of [120, 230]) {
      const p = createSyntheticPoseProvider({
        heightCm: h,
        script: [{ pose: 'walk', durationMs: 1000 }],
      });
      const f = p.frameAt(300)!;
      const top = Math.max(...f.world.map((l) => l.y));
      const bottom = Math.min(...f.world.map((l) => l.y));
      expect(top - bottom).toBeGreaterThan(0.45 * (h / 100));
      expect(top - bottom).toBeLessThan(1.1 * (h / 100));
    }
    // heightCm inválido se sanea
    const bad = createSyntheticPoseProvider({
      heightCm: NaN,
      script: [{ pose: 'a-pose', durationMs: 100 }],
    });
    expect(bad.frameAt(10)).not.toBeNull();
  });

  it('sesgo mediapipe-like estrecha los hombros', () => {
    const plain = mk().frameAt(100)!;
    const biased = mk({ landmarkBias: 'mediapipe-like' }).frameAt(100)!;
    const wd = (f: typeof plain): number => f.world[LM.l_shoulder]!.x - f.world[LM.r_shoulder]!.x;
    expect(wd(plain) - wd(biased)).toBeCloseTo(0.05, 4);
  });
});

describe('poses y rig', () => {
  it('blendPoseStates interpola y evalPose es total', () => {
    const a = evalPose('a-pose', 0, 1000);
    const b = evalPose('t-pose', 0, 1000);
    const mid = blendPoseStates(a, b, 0.5);
    expect(mid.rot).toHaveLength(21);
    expect(blendPoseStates(a, b, -5).yaw).toBe(a.yaw);
    for (const n of ALL_POSE_NAMES) {
      const s = evalPose(n, -100, 0);
      expect(s.rot).toHaveLength(21);
    }
  });

  it('restLandmarks reproduce el esqueleto y defaultMeasurementsForHeight respeta límites', () => {
    const rest = buildRestSkeleton(defaultMeasurementsForHeight(180));
    const lm = restLandmarks(rest);
    expect(lm).toHaveLength(33);
    expect(v3.distance(lm[LM.l_wrist]!, rest.joints[J.l_hand]!.position)).toBe(0);
    for (const h of [120, 150, 230]) {
      const mm = defaultMeasurementsForHeight(h);
      expect(mm.inseamCm).toBeGreaterThanOrEqual(55);
      expect(mm.neckCm).toBeGreaterThanOrEqual(25);
    }
    expect(defaultMeasurementsForHeight(NaN).heightCm).toBe(170);
  });

  it('synthesizeFrame/skeletonFromState: poses aleatorias producen fotogramas finitos', () => {
    const rest = buildRestSkeleton(m);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 30 }), (seed) => {
        const st = samplePlausiblePose(mulberry32(seed));
        const pose = skeletonFromState(rest, st, { distanceM: 3, cameraHeightM: 0.9 });
        const f = synthesizeFrame(rest, pose, 0, {
          camera: { verticalFovDeg: 55, aspect: 4 / 3 },
          imageSize: { width: 960, height: 720 },
          noiseSigmaM: 0.01,
          seed,
        });
        for (const l of f.world) expect(Number.isFinite(l.x + l.y + l.z)).toBe(true);
        for (const l of f.image) expect(Number.isFinite(l.x + l.y + l.z)).toBe(true);
      }),
      { seed: 3, numRuns: 100 },
    );
  });
});

describe('máscara de segmentación sintética', () => {
  it('la silueta de cápsulas tiene la altura y anchura esperadas', () => {
    const p = mk({ mask: { width: 320 }, distanceM: 2.5 });
    const f = p.frameAt(100)!;
    const mask = f.mask!;
    expect(mask.data.length).toBe(mask.width * mask.height);
    let top = mask.height;
    let bottom = -1;
    for (let y = 0; y < mask.height; y++) {
      for (let x = 0; x < mask.width; x++) {
        if (mask.data[y * mask.width + x]! > 128) {
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    }
    expect(bottom).toBeGreaterThan(top);
    // la persona ocupa ≈ H / (D·2·tan(fov/2)) del alto de imagen
    const expected = (m.heightCm / 100 / (2.5 * 2 * Math.tan((55 * Math.PI) / 360))) * mask.height;
    expect(bottom - top).toBeGreaterThan(0.85 * expected);
    expect(bottom - top).toBeLessThan(1.1 * expected);
    // ancho a la altura de la cadera ≈ ancho de cadera (elipse)
    const row = Math.round(f.image[LM.l_hip]!.y * mask.height);
    let xs = [mask.width, -1];
    for (let x = 0; x < mask.width; x++) {
      if (mask.data[row * mask.width + x]! > 128) xs = [Math.min(xs[0]!, x), Math.max(xs[1]!, x)];
    }
    expect(xs[1]! - xs[0]!).toBeGreaterThan(0.1 * mask.width);
  });

  it('ellipseAxes: la circunferencia de Euler se recupera', () => {
    const { a, b } = ellipseAxes(98, 0.7);
    const c = 2 * Math.PI * Math.sqrt((a * a + b * b) / 2);
    expect(c * 100).toBeCloseTo(98, 6);
    expect(b / a).toBeCloseTo(0.7, 9);
  });

  it('rasterizeMeshMask rasteriza una caja; renderCapsuleMask tolera cámaras raras', () => {
    // cubo de 0.4 m a 2 m: ocupa 0.4/(2·2·tan(27.5°)) del alto
    const c = [
      [-0.2, -0.2, -2.2],
      [0.2, -0.2, -2.2],
      [0.2, 0.2, -2.2],
      [-0.2, 0.2, -2.2],
    ].flat();
    const mask = rasterizeMeshMask({
      positions: c,
      indices: [0, 1, 2, 0, 2, 3],
      camera: { verticalFovDeg: 55, aspect: 1 },
      width: 100,
      height: 100,
    });
    const area = mask.data.reduce((acc, v) => acc + v / 255, 0);
    const side = (0.4 / (2.2 * 2 * Math.tan((55 * Math.PI) / 360))) * 100;
    expect(area).toBeGreaterThan(0.9 * side * side);
    expect(area).toBeLessThan(1.1 * side * side);
    expect(() =>
      rasterizeMeshMask({
        positions: [0, 0, 0],
        indices: [0, 1, 2, 9, 9, 9],
        camera: { verticalFovDeg: NaN, aspect: NaN },
        width: 4,
        height: 4,
      }),
    ).not.toThrow();
    const rest = buildRestSkeleton(m);
    expect(() =>
      renderCapsuleMask({
        rest,
        measurements: m,
        fkPositions: rest.joints.map((j) => j.position),
        fkRotations: rest.joints.map(() => [0, 0, 0, 1] as const),
        camera: { verticalFovDeg: 55, aspect: 1.3 },
        width: 16,
        height: 16,
      }),
    ).not.toThrow();
  });
});
