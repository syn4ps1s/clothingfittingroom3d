import { describe, expect, it } from 'vitest';
import { LightEstimator, computeLightStats, NEUTRAL_LIGHT } from './lightEstimator';

function fill(
  w: number,
  h: number,
  fn: (x: number, y: number) => [number, number, number],
): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * w + x) * 4;
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
    }
  }
  return d;
}

describe('computeLightStats', () => {
  it('imagen negra → luma 0, finita', () => {
    const s = computeLightStats(fill(32, 18, () => [0, 0, 0]), 32, 18);
    expect(s.luma).toBe(0);
    expect(s.luma255).toBe(0);
    expect(s.tint.every(Number.isFinite)).toBe(true);
  });

  it('gris uniforme → tinte neutro y luma255 coherente', () => {
    const s = computeLightStats(fill(32, 18, () => [128, 128, 128]), 32, 18);
    expect(s.luma255).toBeCloseTo(128, 0);
    for (const c of s.tint) expect(c).toBeCloseTo(1, 2);
    expect(s.contrast).toBeCloseTo(0, 5);
  });

  it('dominante cálida → tinte con más rojo que azul', () => {
    const s = computeLightStats(fill(32, 18, () => [220, 170, 110]), 32, 18);
    expect(s.tint[0]).toBeGreaterThan(s.tint[2]);
  });

  it('más luz a la derecha / arriba produce dirX / dirY con signo correcto', () => {
    const right = computeLightStats(fill(32, 18, (x) => (x > 20 ? [240, 240, 240] : [30, 30, 30])), 32, 18);
    expect(right.dirX).toBeGreaterThan(0.5);
    const left = computeLightStats(fill(32, 18, (x) => (x < 11 ? [240, 240, 240] : [30, 30, 30])), 32, 18);
    expect(left.dirX).toBeLessThan(-0.5);
    const top = computeLightStats(fill(32, 18, (_x, y) => (y < 9 ? [240, 240, 240] : [30, 30, 30])), 32, 18);
    expect(top.dirY).toBeGreaterThan(0.5);
  });

  it('entradas degeneradas devuelven la estimación neutra', () => {
    expect(computeLightStats(new Uint8ClampedArray(0), 32, 18)).toEqual(NEUTRAL_LIGHT);
    expect(computeLightStats(new Uint8ClampedArray(4), 0, 0)).toEqual(NEUTRAL_LIGHT);
  });
});

describe('LightEstimator', () => {
  it('la primera muestra se adopta tal cual y las siguientes se suavizan', () => {
    const e = new LightEstimator({ smoothingMs: 500 });
    const dark = fill(32, 18, () => [20, 20, 20]);
    const bright = fill(32, 18, () => [235, 235, 235]);
    const a = e.updateFromPixels(dark, 32, 18, 0);
    expect(a.luma255).toBeCloseTo(20, 0);
    const b = e.updateFromPixels(bright, 32, 18, 100);
    // tras 100 ms con τ=500 ms ≈ 18 % del camino
    expect(b.luma255).toBeGreaterThan(20);
    expect(b.luma255).toBeLessThan(100);
    let last = b;
    for (let t = 200; t < 5000; t += 100) last = e.updateFromPixels(bright, 32, 18, t);
    expect(last.luma255).toBeGreaterThan(225);
  });

  it('reset() vuelve a neutral', () => {
    const e = new LightEstimator();
    e.updateFromPixels(fill(32, 18, () => [0, 0, 0]), 32, 18, 0);
    e.reset();
    expect(e.estimate).toEqual(NEUTRAL_LIGHT);
    expect(e.hasEstimate).toBe(false);
  });
});
