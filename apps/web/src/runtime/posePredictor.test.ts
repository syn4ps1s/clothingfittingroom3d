import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { JOINT_COUNT, q, type Quat, type SkeletonPose } from '@fitroom/shared';
import { PosePredictor } from './posePredictor';
import { angleBetweenAt, slerpInto } from './quatMath';

const IDENT: Quat = [0, 0, 0, 1];

function poseAt(angleRad: number, x = 0, conf = 1): SkeletonPose {
  const rotations: Quat[] = Array.from({ length: JOINT_COUNT }, () => IDENT);
  rotations[6] = q.fromAxisAngle([0, 0, 1], angleRad);
  return {
    timestampMs: 0,
    rootPosition: [x, 1, -2.5],
    rotations,
    confidence: conf,
    jointConfidence: Array.from({ length: JOINT_COUNT }, () => conf),
  };
}

const angleOf = (p: SkeletonPose, j = 6): number => q.angleBetween(p.rotations[j]!, IDENT);

describe('slerpInto', () => {
  it('interpola y extrapola por el arco corto', () => {
    const a = [0, 0, 0, 1];
    const b = q.fromAxisAngle([0, 0, 1], 0.2);
    const out = [0, 0, 0, 0];
    slerpInto(out, 0, a, 0, b, 0, 0.5);
    expect(q.angleBetween(out as unknown as Quat, IDENT)).toBeCloseTo(0.1, 6);
    slerpInto(out, 0, a, 0, b, 0, 2);
    expect(q.angleBetween(out as unknown as Quat, IDENT)).toBeCloseTo(0.4, 5);
    // signo opuesto de b (misma rotación) no cambia el resultado
    const nb = [-b[0], -b[1], -b[2], -b[3]];
    slerpInto(out, 0, a, 0, nb, 0, 2);
    expect(q.angleBetween(out as unknown as Quat, IDENT)).toBeCloseTo(0.4, 5);
  });

  it('degenerados → identidad, nunca NaN', () => {
    const out = [9, 9, 9, 9];
    slerpInto(out, 0, [0, 0, 0, 0], 0, [0, 0, 0, 0], 0, 0.5);
    expect(out).toEqual([0, 0, 0, 1]);
  });
});

describe('PosePredictor', () => {
  it('devuelve null antes de la primera detección', () => {
    const p = new PosePredictor();
    expect(p.sample(100)).toBeNull();
    expect(p.ready).toBe(false);
  });

  it('la primera muestra salta a la detección sin deslizar', () => {
    const p = new PosePredictor();
    p.push(poseAt(0.7, 0.3), 1000);
    const s = p.sample(1005)!;
    expect(angleOf(s)).toBeCloseTo(0.7, 4);
    expect(s.rootPosition[0]).toBeCloseTo(0.3, 6);
  });

  it('reutiliza el mismo objeto de salida (sin asignaciones por fotograma)', () => {
    const p = new PosePredictor();
    p.push(poseAt(0.1), 0);
    const a = p.sample(5)!;
    const b = p.sample(21)!;
    expect(b).toBe(a);
    expect(b.rotations[6]).toBe(a.rotations[6]);
  });

  it('movimiento uniforme: predecir reduce el retardo respecto a mantener la última detección, sin saltos', () => {
    // brazo girando a 1 rad/s; detecciones a 30 Hz con 40 ms de latencia; render a 60 Hz
    const omega = 1 / 1000; // rad/ms
    const latency = 40;
    const p = new PosePredictor();
    let nextDet = 0;
    let prev: number | null = null;
    let maxStep = 0;
    let sqErr = 0;
    let sqHold = 0;
    let count = 0;
    let lastDetAngle = 0;
    for (let t = 0; t <= 2500; t += 1000 / 60) {
      while (nextDet * (1000 / 30) + latency <= t) {
        const capture = nextDet * (1000 / 30);
        lastDetAngle = omega * capture;
        p.push(poseAt(lastDetAngle), capture + latency, latency);
        nextDet++;
      }
      const s = p.sample(t);
      if (!s) continue;
      const ang = angleOf(s);
      if (prev !== null && t > 300) maxStep = Math.max(maxStep, Math.abs(ang - prev));
      prev = ang;
      if (t > 300) {
        sqErr += (ang - omega * t) ** 2;
        sqHold += (lastDetAngle - omega * t) ** 2;
        count++;
      }
    }
    const rms = Math.sqrt(sqErr / count);
    const rmsHold = Math.sqrt(sqHold / count);
    expect(rms).toBeLessThan(rmsHold * 0.6);
    // velocidad real: 1 rad/s · 16.7 ms = 0.0167 rad por fotograma; nunca más del doble (sin saltos)
    expect(maxStep).toBeLessThan(0.0167 * 2);
  });

  it('sin detecciones nuevas la pose se estabiliza (no deriva indefinidamente)', () => {
    const p = new PosePredictor();
    p.push(poseAt(0.0), 0);
    p.push(poseAt(0.1), 33);
    let last = 0;
    for (let t = 33; t < 3000; t += 16.7) last = angleOf(p.sample(t)!);
    const extra = last - 0.1;
    expect(extra).toBeGreaterThanOrEqual(0);
    expect(extra).toBeLessThan(0.42); // acotado por el horizonte (1,5 · 90 ms · 0,1 rad/33 ms)
    const later = angleOf(p.sample(10000)!);
    expect(later).toBeCloseTo(last, 3);
  });

  it('tras un hueco largo re-adquiere sin deslizar (snap)', () => {
    const p = new PosePredictor();
    p.push(poseAt(0), 0);
    p.sample(10);
    p.push(poseAt(1.2, 0.8), 5000);
    const s = p.sample(5001)!;
    expect(angleOf(s)).toBeCloseTo(1.2, 3);
    expect(s.rootPosition[0]).toBeCloseTo(0.8, 3);
  });

  it('ignora detecciones con raíz no finita', () => {
    const p = new PosePredictor();
    p.push(poseAt(0.2), 0);
    const bad = { ...poseAt(0.5), rootPosition: [Number.NaN, 0, 0] as const };
    p.push(bad, 33);
    const s = p.sample(40)!;
    expect(Number.isFinite(s.rootPosition[0])).toBe(true);
    expect(angleOf(s)).toBeCloseTo(0.2, 3);
  });

  it('propiedad: la salida siempre es finita y los cuaterniones son unitarios (entradas arbitrarias)', () => {
    const finiteQuat = fc
      .tuple(
        fc.double({ min: -2, max: 2, noNaN: true }),
        fc.double({ min: -2, max: 2, noNaN: true }),
        fc.double({ min: -2, max: 2, noNaN: true }),
        fc.double({ min: -2, max: 2, noNaN: true }),
      )
      .map((v): Quat => [v[0], v[1], v[2], v[3]]);
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            dt: fc.double({ min: -5, max: 800, noNaN: true }),
            rot: fc.array(finiteQuat, { minLength: JOINT_COUNT, maxLength: JOINT_COUNT }),
            x: fc.double({ min: -50, max: 50, noNaN: true }),
            sampleDt: fc.double({ min: 0, max: 300, noNaN: true }),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (steps) => {
          const p = new PosePredictor();
          let t = 0;
          for (const s of steps) {
            t += s.dt;
            p.push(
              {
                timestampMs: t,
                rootPosition: [s.x, 1, -2],
                rotations: s.rot,
                confidence: 1,
                jointConfidence: s.rot.map(() => 1),
              },
              t,
            );
            const out = p.sample(t + s.sampleDt);
            if (!out) continue;
            expect(out.rootPosition.every(Number.isFinite)).toBe(true);
            for (const r of out.rotations) {
              expect(r.every(Number.isFinite)).toBe(true);
              expect(Math.hypot(r[0], r[1], r[2], r[3])).toBeCloseTo(1, 6);
            }
          }
        },
      ),
      { numRuns: 200, seed: 1234 },
    );
  });

  it('bucle caliente: 20 000 muestras no hacen crecer el heap de forma apreciable', () => {
    const p = new PosePredictor();
    p.push(poseAt(0), 0);
    p.push(poseAt(0.05), 33);
    for (let i = 0; i < 2000; i++) p.sample(33 + i * 0.5); // calentar JIT
    const g = globalThis as { gc?: () => void };
    g.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 20000; i++) p.sample(33 + i * 0.5);
    const grown = process.memoryUsage().heapUsed - before;
    // sin asignaciones, el crecimiento es ruido del motor (muy por debajo de lo que costarían 20 000×21 quats)
    expect(grown).toBeLessThan(2_000_000);
  });

  it('angleBetweenAt coincide con q.angleBetween', () => {
    const a = q.fromAxisAngle([1, 0, 0], 0.3);
    const b = q.fromAxisAngle([0, 1, 0], 0.9);
    expect(angleBetweenAt(a, 0, b, 0)).toBeCloseTo(q.angleBetween(a, b), 9);
  });
});
