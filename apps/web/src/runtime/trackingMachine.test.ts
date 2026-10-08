import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { TrackingState } from '../contracts';
import { TrackingMachine } from './trackingMachine';

const good: { present: boolean; confidence: number } = { present: true, confidence: 0.9 };
const none: { present: boolean; confidence: number } = { present: false, confidence: 0 };

/** Simula detecciones a 30 Hz durante `ms` con la observación dada; devuelve el último instante. */
function run(
  m: TrackingMachine,
  from: number,
  ms: number,
  obs: { present: boolean; confidence: number },
): number {
  let t = from;
  const end = from + ms;
  while (t < end) {
    t += 1000 / 30;
    m.observe(t, obs);
    m.tick(t);
  }
  return t;
}

describe('TrackingMachine', () => {
  it('arranca en initializing y pasa a searching al estar listo el proveedor', () => {
    const m = new TrackingMachine();
    expect(m.state).toBe('initializing');
    expect(m.visibility).toBe(0);
    m.observe(0, good); // ignorado: aún no listo
    expect(m.state).toBe('initializing');
    m.markReady(10);
    expect(m.state).toBe('searching');
  });

  it('histéresis de entrada: hacen falta N detecciones consecutivas', () => {
    const m = new TrackingMachine({ enterFrames: 3 });
    m.markReady(0);
    m.observe(33, good);
    m.observe(66, good);
    expect(m.state).toBe('searching');
    m.observe(99, none); // se rompe la racha
    m.observe(132, good);
    m.observe(165, good);
    expect(m.state).toBe('searching');
    m.observe(198, good);
    expect(m.state).toBe('tracking');
  });

  it('fallos aislados (< 500 ms) no hacen perder el seguimiento ni parpadear las prendas', () => {
    const m = new TrackingMachine();
    m.markReady(0);
    let t = run(m, 0, 600, good);
    expect(m.state).toBe('tracking');
    expect(m.visibility).toBe(1);
    t = run(m, t, 400, none);
    expect(m.state).toBe('tracking');
    expect(m.visibility).toBe(1);
    t = run(m, t, 200, good);
    expect(m.state).toBe('tracking');
    expect(m.visibility).toBe(1);
  });

  it('tras ~500 ms sin detección → lost, y las prendas se desvanecen de forma continua', () => {
    const m = new TrackingMachine();
    m.markReady(0);
    let t = run(m, 0, 600, good);
    const states: TrackingState[] = [];
    m.onChange((s) => states.push(s));
    const vis: number[] = [];
    const end = t + 1500;
    while (t < end) {
      t += 1000 / 60;
      m.tick(t);
      vis.push(m.visibility);
    }
    expect(states).toEqual(['lost']);
    expect(m.state).toBe('lost');
    expect(vis[0]).toBe(1);
    expect(vis[vis.length - 1]).toBe(0);
    // monótona decreciente y sin saltos grandes entre fotogramas (suave)
    for (let i = 1; i < vis.length; i++) {
      expect(vis[i]!).toBeLessThanOrEqual(vis[i - 1]! + 1e-12);
      expect(vis[i - 1]! - vis[i]!).toBeLessThan(0.2);
    }
  });

  it('recuperación sin parpadeo: si reaparece a medio desvanecimiento, la visibilidad sube desde donde estaba', () => {
    const m = new TrackingMachine();
    m.markReady(0);
    let t = run(m, 0, 600, good);
    // pérdida hasta mitad del fundido
    const lostStart = t;
    while (t - lostStart < 500 + 150) {
      t += 1000 / 60;
      m.tick(t);
    }
    expect(m.state).toBe('lost');
    const mid = m.visibility;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    // reaparece: 2 detecciones bastan
    t += 33;
    m.observe(t, good);
    t += 33;
    m.observe(t, good);
    expect(m.state).toBe('tracking');
    const after = m.visibility;
    expect(after).toBeGreaterThanOrEqual(mid - 0.01); // no sigue cayendo ni salta a 1
    expect(after).toBeLessThan(1);
    const prev = after;
    t += 16;
    m.tick(t);
    expect(m.visibility).toBeGreaterThanOrEqual(prev);
  });

  it('lost → searching tras el tiempo de gracia', () => {
    const m = new TrackingMachine({ giveUpAfterMs: 2000 });
    m.markReady(0);
    let t = run(m, 0, 600, good);
    t = run(m, t, 1000, none);
    expect(m.state).toBe('lost');
    t = run(m, t, 2500, none);
    expect(m.state).toBe('searching');
  });

  it('detecciones de baja confianza no cuentan', () => {
    const m = new TrackingMachine({ minConfidence: 0.3 });
    m.markReady(0);
    run(m, 0, 600, { present: true, confidence: 0.1 });
    expect(m.state).toBe('searching');
  });

  it('notifica varias personas sin cambiar de estado', () => {
    const m = new TrackingMachine();
    m.markReady(0);
    run(m, 0, 300, { present: true, confidence: 0.9 });
    m.observe(400, { present: true, confidence: 0.9, personCount: 2 });
    expect(m.multiplePeople).toBe(true);
    expect(m.state).toBe('tracking');
  });

  it('propiedad: la visibilidad siempre está en [0,1] y es finita, con cualquier secuencia', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            dt: fc.double({ min: 0, max: 2000, noNaN: true }),
            present: fc.boolean(),
            conf: fc.double({ min: -1, max: 2, noNaN: false }),
            tickOnly: fc.boolean(),
          }),
          { maxLength: 80 },
        ),
        (steps) => {
          const m = new TrackingMachine();
          m.markReady(0);
          let t = 0;
          for (const s of steps) {
            t += s.dt;
            if (s.tickOnly) m.tick(t);
            else m.observe(t, { present: s.present, confidence: s.conf });
            expect(m.visibility).toBeGreaterThanOrEqual(0);
            expect(m.visibility).toBeLessThanOrEqual(1);
            expect(Number.isFinite(m.visibility)).toBe(true);
          }
        },
      ),
      { numRuns: 150, seed: 42 },
    );
  });
});
