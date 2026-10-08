import { describe, expect, it } from 'vitest';
import {
  MeasurementsSchema,
  PartialMeasurementsSchema,
  MEASUREMENT_LIMITS,
} from './measurements.js';
import { REFERENCE_MEASUREMENTS } from './fixtures.js';

describe('measurements', () => {
  it.each(Object.entries(REFERENCE_MEASUREMENTS))(
    'las medidas de referencia %s son válidas',
    (_n, m) => {
      expect(MeasurementsSchema.safeParse(m).success).toBe(true);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1e9, '180', null, undefined])(
    'rechaza estatura inválida: %s',
    (bad) => {
      expect(PartialMeasurementsSchema.safeParse({ heightCm: bad }).success).toBe(false);
    },
  );

  it('rechaza claves desconocidas (anti prototype-pollution / typos)', () => {
    expect(
      PartialMeasurementsSchema.safeParse({ heightCm: 170, __proto__: { x: 1 }, foo: 1 }).success,
    ).toBe(false);
  });

  it('los límites son coherentes (min < max)', () => {
    for (const l of Object.values(MEASUREMENT_LIMITS)) expect(l.min).toBeLessThan(l.max);
  });

  it('la entrada parcial exige sólo estatura', () => {
    expect(PartialMeasurementsSchema.safeParse({ heightCm: 170 }).success).toBe(true);
    expect(PartialMeasurementsSchema.safeParse({ chestCm: 90 }).success).toBe(false);
  });
});
