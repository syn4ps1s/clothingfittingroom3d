import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MEASUREMENT_KEYS,
  MEASUREMENT_LIMITS,
  MeasurementsSchema,
  REFERENCE_MEASUREMENTS,
  type MeasurementKey,
  type PartialMeasurements,
} from '@fitroom/shared';
import { completeMeasurements, parsePartial, validateMeasurementCoherence } from './complete.js';
import { BodyInputError } from './errors.js';
import { partialMeasurements } from './test-helpers.js';
import {
  correlation,
  girthSlopeBmi,
  predictArmLength,
  predictGirth,
  predictInseam,
  solveLinear,
} from './anthropometry.js';

const FC = { seed: 20260101, numRuns: 300 } as const;

describe('completeMeasurements: contrato', () => {
  it('con sólo la estatura devuelve unas medidas completas, válidas y plausibles', () => {
    for (const h of [120, 150, 170, 190, 230]) {
      const m = completeMeasurements({ heightCm: h });
      expect(MeasurementsSchema.safeParse(m).success).toBe(true);
      expect(m.bodyBase).toBe('neutral');
      const bmi = m.weightKg / ((h / 100) * (h / 100));
      expect(bmi).toBeGreaterThan(18);
      expect(bmi).toBeLessThan(27);
      expect(m.inseamCm / h).toBeGreaterThan(0.43);
      expect(m.inseamCm / h).toBeLessThan(0.48);
      expect(m.armLengthCm / h).toBeGreaterThan(0.3);
      expect(m.armLengthCm / h).toBeLessThan(0.375);
      expect(m.waistCm).toBeLessThan(m.hipCm + 5);
    }
  });

  it('respeta SIEMPRE lo que da la persona y siempre cumple el esquema (propiedad)', () => {
    fc.assert(
      fc.property(partialMeasurements(), (p) => {
        const before = JSON.stringify(p);
        const m = completeMeasurements(p);
        expect(JSON.stringify(p)).toBe(before); // no muta la entrada
        expect(MeasurementsSchema.safeParse(m).success).toBe(true);
        for (const k of MEASUREMENT_KEYS) {
          const given = p[k];
          if (given !== undefined) expect(m[k]).toBe(given);
        }
        if (p.bodyBase) expect(m.bodyBase).toBe(p.bodyBase);
      }),
      FC,
    );
  });

  it('es determinista (misma entrada → mismas medidas)', () => {
    fc.assert(
      fc.property(partialMeasurements(), (p) => {
        expect(completeMeasurements(p)).toEqual(completeMeasurements({ ...p }));
      }),
      { ...FC, numRuns: 80 },
    );
  });

  it('reproduce los perfiles de referencia a partir de estatura, peso y constitución', () => {
    const tol: Record<string, number> = {
      chestCm: 3,
      waistCm: 3,
      hipCm: 3,
      shoulderWidthCm: 1.5,
      armLengthCm: 1.5,
      inseamCm: 1.5,
      neckCm: 1.5,
      thighCm: 2,
    };
    for (const ref of Object.values(REFERENCE_MEASUREMENTS)) {
      const m = completeMeasurements({
        heightCm: ref.heightCm,
        weightKg: ref.weightKg,
        bodyBase: ref.bodyBase,
      });
      for (const [k, t] of Object.entries(tol)) {
        expect(Math.abs(m[k as MeasurementKey] - ref[k as MeasurementKey])).toBeLessThanOrEqual(t);
      }
    }
  });

  it('es monótona: más peso → circunferencias derivadas mayores', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 140, max: 210 }),
        fc.integer({ min: 17, max: 33 }),
        fc.constantFrom('neutral', 'feminine', 'masculine' as const),
        (h, bmi, base) => {
          const w1 = bmi * (h / 100) ** 2;
          const w2 = (bmi + 4) * (h / 100) ** 2;
          const a = completeMeasurements({ heightCm: h, weightKg: w1, bodyBase: base });
          const b = completeMeasurements({ heightCm: h, weightKg: w2, bodyBase: base });
          for (const k of ['chestCm', 'waistCm', 'hipCm', 'thighCm', 'neckCm'] as const) {
            expect(b[k]).toBeGreaterThanOrEqual(a[k]);
          }
        },
      ),
      { ...FC, numRuns: 120 },
    );
  });

  it('la estatura escala las dimensiones lineales', () => {
    const a = completeMeasurements({ heightCm: 160 });
    const b = completeMeasurements({ heightCm: 190 });
    expect(b.inseamCm).toBeGreaterThan(a.inseamCm);
    expect(b.armLengthCm).toBeGreaterThan(a.armLengthCm);
    expect(b.shoulderWidthCm).toBeGreaterThan(a.shoulderWidthCm);
  });

  it('la constitución modula las proporciones (femenino: más cadera relativa; masculino: más hombros)', () => {
    const f = completeMeasurements({ heightCm: 172, weightKg: 68, bodyBase: 'feminine' });
    const mm = completeMeasurements({ heightCm: 172, weightKg: 68, bodyBase: 'masculine' });
    expect(f.hipCm / f.waistCm).toBeGreaterThan(mm.hipCm / mm.waistCm);
    expect(mm.shoulderWidthCm).toBeGreaterThan(f.shoulderWidthCm);
    expect(mm.neckCm).toBeGreaterThan(f.neckCm);
  });

  it('infiere el IMC de las circunferencias cuando no hay peso, y el peso de las medidas', () => {
    const slim = completeMeasurements({ heightCm: 170, waistCm: 66, hipCm: 90 });
    const wide = completeMeasurements({ heightCm: 170, waistCm: 110, hipCm: 125 });
    expect(wide.weightKg).toBeGreaterThan(slim.weightKg + 20);
    // y las medidas no dadas siguen a las dadas
    expect(wide.chestCm).toBeGreaterThan(slim.chestCm + 10);
    expect(wide.thighCm).toBeGreaterThan(slim.thighCm + 6);
  });

  it('las medidas derivadas son coherentes entre sí', () => {
    fc.assert(
      fc.property(partialMeasurements(), (p) => {
        const m = completeMeasurements({ heightCm: p.heightCm, bodyBase: p.bodyBase });
        const bad = validateMeasurementCoherence(m).filter((w) => w.severity !== 'info');
        expect(bad).toEqual([]);
      }),
      { ...FC, numRuns: 100 },
    );
  });
});

describe('completeMeasurements: entradas inválidas (adversarial)', () => {
  const expectInvalid = (v: unknown): void => {
    try {
      completeMeasurements(v as PartialMeasurements);
      throw new Error('debía lanzar');
    } catch (e) {
      expect(e).toBeInstanceOf(BodyInputError);
      expect((e as BodyInputError).code).toBe('invalid-measurements');
      expect((e as BodyInputError).issues.length).toBeGreaterThan(0);
    }
  };

  it('rechaza NaN, ±Infinity, fuera de rango, claves desconocidas y tipos incorrectos', () => {
    expectInvalid({});
    expectInvalid({ heightCm: Number.NaN });
    expectInvalid({ heightCm: Infinity });
    expectInvalid({ heightCm: -Infinity });
    expectInvalid({ heightCm: 119.99 });
    expectInvalid({ heightCm: 230.01 });
    expectInvalid({ heightCm: '170' });
    expectInvalid({ heightCm: 170, weightKg: Number.NaN });
    expectInvalid({ heightCm: 170, chestCm: 59 });
    expectInvalid({ heightCm: 170, waistCm: 181 });
    expectInvalid({ heightCm: 170, bodyBase: 'robot' });
    expectInvalid({ heightCm: 170, shoeSize: 42 });
    expectInvalid({ heightCm: undefined });
    expectInvalid(null);
    expectInvalid(undefined);
    expectInvalid(42);
    expectInvalid('170');
    expectInvalid([170]);
  });

  it('un valor undefined explícito en una opcional equivale a «no dado» o se rechaza, nunca produce NaN', () => {
    let m;
    try {
      m = completeMeasurements({ heightCm: 170, weightKg: undefined });
    } catch (e) {
      expect(e).toBeInstanceOf(BodyInputError);
      return;
    }
    for (const k of MEASUREMENT_KEYS) expect(Number.isFinite(m[k])).toBe(true);
  });

  it('acepta exactamente los límites de plausibilidad', () => {
    for (const k of MEASUREMENT_KEYS) {
      for (const edge of ['min', 'max'] as const) {
        const p: Record<string, number> = { heightCm: 175 };
        p[k] = MEASUREMENT_LIMITS[k][edge];
        const m = completeMeasurements(p as unknown as PartialMeasurements);
        expect(MeasurementsSchema.safeParse(m).success).toBe(true);
        expect(m[k]).toBe(MEASUREMENT_LIMITS[k][edge]);
      }
    }
  });

  it('con entradas incoherentes pero válidas conserva lo dado y NO falla', () => {
    const p: PartialMeasurements = { heightCm: 170, waistCm: 150, hipCm: 90, chestCm: 70 };
    const m = completeMeasurements(p);
    expect(m.waistCm).toBe(150);
    expect(m.hipCm).toBe(90);
    expect(m.chestCm).toBe(70);
    expect(MeasurementsSchema.safeParse(m).success).toBe(true);
  });

  it('parsePartial devuelve los datos validados', () => {
    expect(parsePartial({ heightCm: 170 })).toEqual({ heightCm: 170 });
  });
});

describe('validateMeasurementCoherence', () => {
  it('los perfiles de referencia no tienen avisos graves', () => {
    for (const ref of Object.values(REFERENCE_MEASUREMENTS)) {
      expect(validateMeasurementCoherence(ref).filter((w) => w.severity === 'error')).toEqual([]);
    }
  });

  it('avisa de cintura > cadera por 40 cm', () => {
    const w = validateMeasurementCoherence({ heightCm: 170, waistCm: 130, hipCm: 90 });
    const hit = w.find((x) => x.code === 'waist-exceeds-hip');
    expect(hit?.severity).toBe('error');
    expect(hit?.keys).toContain('waistCm');
    expect(hit?.value).toBe(40);
  });

  it('cubre todos los avisos (cada código se puede provocar)', () => {
    const codes = new Set<string>();
    const cases: PartialMeasurements[] = [
      { heightCm: 170, waistCm: 120, hipCm: 90 },
      { heightCm: 170, waistCm: 120, chestCm: 90 },
      { heightCm: 170, chestCm: 70, hipCm: 130 },
      { heightCm: 170, thighCm: 80, hipCm: 90 },
      { heightCm: 170, thighCm: 35, hipCm: 120 },
      { heightCm: 170, neckCm: 50, chestCm: 80 },
      { heightCm: 170, neckCm: 27, chestCm: 120 },
      { heightCm: 170, shoulderWidthCm: 30, chestCm: 120 },
      { heightCm: 170, shoulderWidthCm: 69 },
      { heightCm: 120, inseamCm: 100 },
      { heightCm: 200, inseamCm: 60 },
      { heightCm: 130, armLengthCm: 90 },
      { heightCm: 200, armLengthCm: 45 },
      { heightCm: 170, weightKg: 30 },
      { heightCm: 170, weightKg: 240 },
      { heightCm: 170, weightKg: 120, waistCm: 60, hipCm: 85, chestCm: 85 },
    ];
    for (const c of cases) for (const w of validateMeasurementCoherence(c)) codes.add(w.code);
    for (const code of [
      'waist-exceeds-hip',
      'waist-exceeds-chest',
      'chest-hip-mismatch',
      'thigh-too-large-for-hip',
      'thigh-too-small-for-hip',
      'neck-too-large-for-chest',
      'neck-too-small-for-chest',
      'shoulder-narrow-for-chest',
      'shoulder-ratio-implausible',
      'inseam-ratio-implausible',
      'arm-length-ratio-implausible',
      'bmi-extreme',
      'bmi-girth-mismatch',
    ])
      expect(codes.has(code)).toBe(true);
  });

  it('nunca lanza y devuelve avisos bien formados (propiedad)', () => {
    fc.assert(
      fc.property(partialMeasurements(), (p) => {
        for (const w of validateMeasurementCoherence(p)) {
          expect(w.message.length).toBeGreaterThan(5);
          expect(w.keys.length).toBeGreaterThan(0);
          expect(Number.isFinite(w.value)).toBe(true);
          expect(['info', 'warning', 'error']).toContain(w.severity);
        }
      }),
      FC,
    );
  });
});

describe('anthropometry (modelo)', () => {
  it('las predicciones son monótonas en el IMC y la correlación es simétrica', () => {
    for (const k of ['chestCm', 'waistCm', 'hipCm', 'neckCm', 'thighCm'] as const) {
      expect(predictGirth(k, 170, 28, 0)).toBeGreaterThan(predictGirth(k, 170, 20, 0));
      expect(girthSlopeBmi(k, 0)).toBeGreaterThan(0);
    }
    expect(predictInseam(180)).toBeGreaterThan(predictInseam(160));
    expect(predictArmLength(180, 1)).toBeGreaterThan(predictArmLength(180, -1));
    expect(correlation('chestCm', 'waistCm')).toBe(correlation('waistCm', 'chestCm'));
    expect(correlation('chestCm', 'chestCm')).toBe(1);
    expect(correlation('inseamCm', 'neckCm')).toBeCloseTo(0.05);
  });

  it('solveLinear resuelve sistemas pequeños', () => {
    const x = solveLinear(
      [
        [2, 1],
        [1, 3],
      ],
      [3, 5],
    );
    expect(x[0]).toBeCloseTo(0.8);
    expect(x[1]).toBeCloseTo(1.4);
    // matriz singular → solución finita (ceros) sin NaN
    const s = solveLinear(
      [
        [1, 1],
        [1, 1],
      ],
      [2, 2],
    );
    expect(s.every(Number.isFinite)).toBe(true);
  });
});
