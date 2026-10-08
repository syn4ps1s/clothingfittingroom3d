import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { q, v3, type Quat, type Vec3 } from './math.js';

const finite = fc.double({ min: -1e3, max: 1e3, noNaN: true, noDefaultInfinity: true });
const vec3 = fc.tuple(finite, finite, finite) as fc.Arbitrary<Vec3>;
const unitQuat = fc
  .tuple(finite, finite, finite, finite)
  .filter((t) => Math.hypot(...t) > 1e-3)
  .map((t) => q.normalize(t as Quat));

describe('math', () => {
  it('normalize nunca devuelve NaN, ni con vector cero', () => {
    expect(v3.normalize([0, 0, 0], [0, 1, 0])).toEqual([0, 1, 0]);
    expect(v3.isFinite(v3.normalize([Number.NaN, 1, 2]))).toBe(true);
  });

  it('la rotación por cuaternión conserva la longitud', () => {
    fc.assert(
      fc.property(unitQuat, vec3, (r, v) => {
        const out = q.rotate(r, v);
        expect(v3.length(out)).toBeCloseTo(v3.length(v), 6);
      }),
    );
  });

  it('fromUnitVectors lleva `from` sobre `to`', () => {
    fc.assert(
      fc.property(vec3, vec3, (a, b) => {
        const from = v3.normalize(a);
        const to = v3.normalize(b);
        const out = q.rotate(q.fromUnitVectors(from, to), from);
        expect(v3.distance(out, to)).toBeLessThan(1e-6);
      }),
    );
  });

  it('fromUnitVectors maneja vectores opuestos', () => {
    const out = q.rotate(q.fromUnitVectors([0, 1, 0], [0, -1, 0]), [0, 1, 0]);
    expect(v3.distance(out, [0, -1, 0])).toBeLessThan(1e-9);
  });

  it('slerp respeta extremos', () => {
    fc.assert(
      fc.property(unitQuat, unitQuat, (a, b) => {
        expect(q.angleBetween(q.slerp(a, b, 0), a)).toBeLessThan(1e-5);
        expect(q.angleBetween(q.slerp(a, b, 1), b)).toBeLessThan(1e-5);
      }),
    );
  });
});
