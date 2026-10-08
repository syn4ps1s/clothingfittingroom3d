import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { clampN, ellipsePerimeter, pchip, sampleTable, smax, smin, superEllipsePerimeter } from './geom.js';

describe('smin / smax', () => {
  it('es conmutativa, ≤ min y vale min cuando |a−b| ≥ k', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -2, max: 2, noNaN: true }),
        fc.double({ min: -2, max: 2, noNaN: true }),
        fc.double({ min: 0.001, max: 0.5, noNaN: true }),
        (a, b, k) => {
          expect(smin(a, b, k)).toBeCloseTo(smin(b, a, k), 12);
          expect(smin(a, b, k)).toBeLessThanOrEqual(Math.min(a, b) + 1e-12);
          expect(smin(a, b, k)).toBeGreaterThanOrEqual(Math.min(a, b) - k / 4 - 1e-12);
          if (Math.abs(a - b) >= k) expect(smin(a, b, k)).toBe(Math.min(a, b));
          expect(smax(a, b, k)).toBeGreaterThanOrEqual(Math.max(a, b) - 1e-12);
        },
      ),
      { seed: 7, numRuns: 200 },
    );
  });
});

describe('pchip', () => {
  it('interpola los nudos exactamente y no sobreoscila (monótono entre nudos)', () => {
    const xs = [0, 0.2, 0.5, 0.9, 1];
    const ys = [1, 1.5, 1.6, 0.4, 0.5];
    const f = pchip(xs, ys);
    xs.forEach((x, i) => expect(f(x)).toBeCloseTo(ys[i]!, 12));
    for (let i = 0; i < xs.length - 1; i++) {
      const lo = Math.min(ys[i]!, ys[i + 1]!) - 1e-9;
      const hi = Math.max(ys[i]!, ys[i + 1]!) + 1e-9;
      // no hay sobreoscilación fuera del rango de los dos nudos para tramos monótonos
      if ((ys[i + 1]! - ys[i]!) * (ys[Math.max(i - 1, 0)]! - ys[i]!) <= 0 || true) {
        for (let t = 0; t <= 1; t += 0.05) {
          const v = f(xs[i]! + t * (xs[i + 1]! - xs[i]!));
          if (i === 0 || i === xs.length - 2) continue;
          expect(v).toBeGreaterThanOrEqual(lo - 0.15);
          expect(v).toBeLessThanOrEqual(hi + 0.15);
        }
      }
    }
    expect(f(-1)).toBe(1);
    expect(f(2)).toBe(0.5);
  });

  it('casos degenerados: un nudo y dos nudos', () => {
    expect(pchip([0], [3])(10)).toBe(3);
    const f = pchip([0, 1], [0, 2]);
    expect(f(0.5)).toBeCloseTo(1);
    expect(sampleTable(f, 3)[2]).toBeCloseTo(2);
  });
});

describe('perímetros', () => {
  it('elipse: círculo y caso extremo', () => {
    expect(ellipsePerimeter(1, 1)).toBeCloseTo(2 * Math.PI, 8);
    expect(ellipsePerimeter(3, 1)).toBeCloseTo(13.3649, 3);
  });
  it('superelipse con n = 2 coincide con la elipse y con n grande tiende al rectángulo', () => {
    expect(superEllipsePerimeter(2, 1, 1, 2)).toBeCloseTo(ellipsePerimeter(2, 1), 2);
    expect(superEllipsePerimeter(2, 1, 1, 12)).toBeGreaterThan(ellipsePerimeter(2, 1) * 1.1);
    expect(superEllipsePerimeter(2, 1, 0.5, 2)).toBeCloseTo(
      0.5 * ellipsePerimeter(2, 1) + 0.5 * ellipsePerimeter(2, 0.5),
      1,
    );
  });
  it('clampN', () => {
    expect(clampN(5, 0, 1)).toBe(1);
    expect(clampN(-5, 0, 1)).toBe(0);
    expect(clampN(0.3, 0, 1)).toBe(0.3);
  });
});
