import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { LM, REFERENCE_MEASUREMENTS, type PoseFrame } from '@fitroom/shared';
import { OneEuroFilter, PoseSmoother } from './filters.js';
import { createSyntheticPoseProvider } from './synthetic.js';
import { gaussian, mulberry32 } from './geom.js';

const std = (xs: number[]): number => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

describe('OneEuroFilter', () => {
  it('es idempotente en señal constante (cualquier dt)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e3, max: 1e3, noNaN: true }),
        fc.array(fc.integer({ min: 1, max: 300 }), { minLength: 2, maxLength: 60 }),
        (c, dts) => {
          const f = new OneEuroFilter({ minCutoff: 1, beta: 5 });
          let t = 0;
          for (const dt of dts) {
            t += dt;
            expect(f.filter(c, t)).toBeCloseTo(c, 9);
          }
        },
      ),
      { seed: 5, numRuns: 100 },
    );
  });

  it('reduce el jitter de forma sustancial y sin sesgo', () => {
    const rand = mulberry32(42);
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0 });
    const raw: number[] = [];
    const out: number[] = [];
    for (let i = 0; i < 600; i++) {
      const x = 0.5 + 0.01 * gaussian(rand);
      raw.push(x);
      const y = f.filter(x, i * 33.3);
      if (i > 60) out.push(y);
    }
    expect(std(out)).toBeLessThan(0.4 * std(raw));
    expect(Math.abs(out.reduce((a, b) => a + b, 0) / out.length - 0.5)).toBeLessThan(0.003);
  });

  it('latencia acotada ante movimiento real (beta alto)', () => {
    // senoide 0.5 Hz, amplitud 0.2: velocidad máx 0.63/s
    const f = new OneEuroFilter({ minCutoff: 1.2, beta: 8 });
    let maxLagMs = 0;
    let maxErr = 0;
    for (let i = 0; i < 300; i++) {
      const t = i * 33.3;
      const x = 0.2 * Math.sin(2 * Math.PI * 0.5 * (t / 1000));
      const y = f.filter(x, t);
      if (i > 60) {
        maxErr = Math.max(maxErr, Math.abs(y - x));
        // lag equivalente = error / velocidad
        const v = Math.abs(0.2 * 2 * Math.PI * 0.5 * Math.cos(2 * Math.PI * 0.5 * (t / 1000)));
        if (v > 0.3) maxLagMs = Math.max(maxLagMs, (Math.abs(y - x) / v) * 1000);
      }
    }
    expect(maxLagMs).toBeLessThan(80);
    expect(maxErr).toBeLessThan(0.04);
  });

  it('beta mayor reduce el retardo en una rampa', () => {
    const run = (beta: number): number => {
      const f = new OneEuroFilter({ minCutoff: 1, beta });
      let y = 0;
      for (let i = 0; i < 60; i++) y = f.filter(i * 0.02, i * 33.3);
      return 59 * 0.02 - y;
    };
    expect(run(20)).toBeLessThan(run(0));
  });

  it('huecos y saltos reinician sin estela', () => {
    const f = new OneEuroFilter({ minCutoff: 1, maxGapMs: 200, jumpThreshold: 1 });
    for (let i = 0; i < 30; i++) f.filter(0, i * 33);
    expect(f.filter(5, 30 * 33)).toBe(5); // salto > umbral
    expect(f.filter(5, 31 * 33)).toBeCloseTo(5, 9);
    expect(f.filter(-3, 31 * 33 + 5000)).toBe(-3); // hueco > maxGapMs
  });

  it('ignora NaN/Inf, repetidos y marcas hacia atrás; nunca devuelve NaN', () => {
    const f = new OneEuroFilter();
    expect(f.filter(NaN, 0)).toBe(0);
    expect(f.filter(1, 10)).toBe(1);
    const v = f.filter(2, 43);
    expect(f.filter(NaN, 76)).toBe(v);
    expect(f.filter(Infinity, 76)).toBe(v);
    expect(f.filter(3, NaN)).toBe(v);
    expect(f.filter(9, 43)).toBe(v); // repetida
    expect(f.filter(9, 30)).toBe(v); // hacia atrás (poco)
    expect(f.filter(7, -5000)).toBe(7); // reloj reiniciado
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.double(), fc.double()), { maxLength: 50 }), (pairs) => {
        const g = new OneEuroFilter({ minCutoff: 0.5, beta: 3 });
        for (const [x, t] of pairs) expect(Number.isFinite(g.filter(x, t))).toBe(true);
      }),
      { seed: 9, numRuns: 100 },
    );
  });

  it('valida parámetros', () => {
    expect(() => new OneEuroFilter({ minCutoff: 0 })).toThrow(RangeError);
    expect(() => new OneEuroFilter({ beta: -1 })).toThrow(RangeError);
    expect(() => new OneEuroFilter({ dCutoff: 0 })).toThrow(RangeError);
  });

  it('reset olvida el estado', () => {
    const f = new OneEuroFilter();
    f.filter(5, 0);
    f.filter(6, 33);
    f.reset();
    expect(f.primed).toBe(false);
    expect(f.filter(-2, 66)).toBe(-2);
    expect(f.velocity).toBe(0);
  });
});

describe('PoseSmoother', () => {
  const m = REFERENCE_MEASUREMENTS.adultA;
  const noisy = createSyntheticPoseProvider({
    heightCm: m.heightCm,
    measurements: m,
    script: [{ pose: 'jitter', durationMs: 20000 }],
    seed: 3,
    noiseSigmaM: 0.004,
  });

  it('reduce el jitter de los landmarks (world e imagen)', () => {
    const sm = new PoseSmoother();
    const rawW: number[] = [];
    const outW: number[] = [];
    const rawI: number[] = [];
    const outI: number[] = [];
    for (let t = 0; t < 8000; t += 33) {
      const f = noisy.frameAt(t)!;
      const o = sm.smooth(f)!;
      if (t > 1000) {
        rawW.push(f.world[LM.l_wrist]!.x);
        outW.push(o.world[LM.l_wrist]!.x);
        rawI.push(f.image[LM.l_wrist]!.y);
        outI.push(o.image[LM.l_wrist]!.y);
      }
    }
    expect(std(outW)).toBeLessThan(0.5 * std(rawW));
    expect(std(outI)).toBeLessThan(0.5 * std(rawI));
  });

  it('sigue un movimiento real con poco retardo', () => {
    const walk = createSyntheticPoseProvider({
      heightCm: m.heightCm,
      measurements: m,
      script: [{ pose: 'walk', durationMs: 10000 }],
    });
    const sm = new PoseSmoother();
    let maxErr = 0;
    for (let t = 0; t < 6000; t += 33) {
      const f = walk.frameAt(t)!;
      const o = sm.smooth(f)!;
      if (t > 1500) {
        const e = Math.hypot(
          o.world[LM.l_wrist]!.x - f.world[LM.l_wrist]!.x,
          o.world[LM.l_wrist]!.y - f.world[LM.l_wrist]!.y,
          o.world[LM.l_wrist]!.z - f.world[LM.l_wrist]!.z,
        );
        maxErr = Math.max(maxErr, e);
      }
    }
    // la muñeca se mueve ≈ 1 m/s: error < 6 cm ⇒ retardo equivalente < 60 ms
    expect(maxErr).toBeLessThan(0.06);
  });

  it('null pasa tal cual, el hueco reinicia y personCount/mask se conservan', () => {
    const sm = new PoseSmoother({ maxGapMs: 300 });
    expect(sm.smooth(null)).toBeNull();
    const f0 = noisy.frameAt(1000)!;
    const o0 = sm.smooth({ ...f0, personCount: 2 })!;
    expect(o0.personCount).toBe(2);
    // tras un hueco, el siguiente fotograma se adopta sin arrastre
    const far = { ...noisy.frameAt(1000 + 5000)!, timestampMs: 6000 };
    const o1 = sm.smooth(far)!;
    expect(o1.world[LM.nose]!.x).toBeCloseTo(far.world[LM.nose]!.x, 9);
  });

  it('salto de 5 m: se adopta la nueva posición de inmediato (sin estela)', () => {
    const sm = new PoseSmoother();
    for (let t = 0; t < 600; t += 33) sm.smooth(noisy.frameAt(t));
    const f = noisy.frameAt(633)!;
    const jumped: PoseFrame = {
      ...f,
      image: f.image.map((l) => ({ ...l, x: l.x + 0.6 })),
      world: f.world.map((l) => ({ ...l, x: l.x + 5 })),
    };
    const o = sm.smooth(jumped)!;
    expect(o.world[LM.l_shoulder]!.x).toBeCloseTo(jumped.world[LM.l_shoulder]!.x, 9);
    expect(o.image[LM.l_shoulder]!.x).toBeCloseTo(jumped.image[LM.l_shoulder]!.x, 9);
  });

  it('marcas repetidas devuelven el último resultado; hacia atrás se ignoran', () => {
    const sm = new PoseSmoother();
    const a = sm.smooth(noisy.frameAt(1000))!;
    const b = sm.smooth(noisy.frameAt(1000))!;
    expect(b).toBe(a);
    const c = sm.smooth({ ...noisy.frameAt(900)!, timestampMs: 900 })!;
    expect(c).toBe(a);
    expect(sm.smooth({ ...noisy.frameAt(1000)!, timestampMs: NaN })).toBe(a);
  });

  it('landmarks NaN/Inf ⇒ salida finita con visibilidad 0; la visibilidad baja deprisa y sube despacio', () => {
    const sm = new PoseSmoother();
    let t = 0;
    for (; t < 400; t += 33) sm.smooth(noisy.frameAt(t));
    const f = noisy.frameAt(t)!;
    const bad: PoseFrame = {
      ...f,
      image: f.image.map((l, i) => (i === LM.l_elbow ? { ...l, x: NaN } : l)),
      world: f.world.map((l, i) => (i === LM.l_wrist ? { ...l, y: Infinity } : l)),
    };
    const o = sm.smooth(bad)!;
    for (const lm of [...o.image, ...o.world]) {
      expect(Number.isFinite(lm.visibility)).toBe(true);
    }
    for (const l of o.world) expect(Number.isFinite(l.x + l.y + l.z)).toBe(true);
    for (const l of o.image) expect(Number.isFinite(l.x + l.y + l.z)).toBe(true);
    expect(o.world[LM.l_wrist]!.visibility).toBeLessThan(0.5);
    // sube despacio: tras una vuelta a vis 0.99, no llega a 0.99 en un solo paso
    t += 33;
    const o2 = sm.smooth({ ...noisy.frameAt(t)!, timestampMs: t })!;
    expect(o2.world[LM.l_wrist]!.visibility).toBeLessThan(0.9);
  });

  it('reset deja el estado limpio', () => {
    const sm = new PoseSmoother();
    sm.smooth(noisy.frameAt(1000));
    sm.reset();
    const f = noisy.frameAt(1033)!;
    const o = sm.smooth(f)!;
    expect(o.world[LM.nose]!.x).toBeCloseTo(f.world[LM.nose]!.x, 12);
  });
});
