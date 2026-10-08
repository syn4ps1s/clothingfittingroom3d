import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MEASUREMENT_KEYS, MEASUREMENT_LIMITS } from '@fitroom/shared';
import {
  cmToIn,
  displayLimits,
  fromDisplay,
  inToCm,
  kgToLb,
  lbToKg,
  parseDecimalInput,
  roundForDisplay,
  toDisplay,
  unitFor,
} from './units';

describe('conversión de unidades', () => {
  it('cm ↔ in y kg ↔ lb son inversas (sin pérdida en el canónico)', () => {
    fc.assert(
      fc.property(fc.double({ min: 1, max: 300, noNaN: true }), (cm) => {
        expect(inToCm(cmToIn(cm))).toBeCloseTo(cm, 9);
        expect(lbToKg(kgToLb(cm))).toBeCloseTo(cm, 9);
      }),
    );
  });

  it('toDisplay/fromDisplay son inversas para todas las medidas y sistemas', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MEASUREMENT_KEYS),
        fc.constantFrom('metric' as const, 'imperial' as const),
        fc.double({ min: 20, max: 250, noNaN: true }),
        (key, system, value) => {
          expect(fromDisplay(key, toDisplay(key, value, system), system)).toBeCloseTo(value, 9);
        },
      ),
    );
  });

  it('unidades por sistema', () => {
    expect(unitFor('heightCm', 'metric')).toBe('cm');
    expect(unitFor('heightCm', 'imperial')).toBe('in');
    expect(unitFor('weightKg', 'imperial')).toBe('lb');
  });

  it('los límites mostrados nunca son más permisivos que los reales', () => {
    for (const key of MEASUREMENT_KEYS) {
      for (const system of ['metric', 'imperial'] as const) {
        const d = displayLimits(key, system);
        const { min, max } = MEASUREMENT_LIMITS[key];
        expect(fromDisplay(key, d.min, system)).toBeGreaterThanOrEqual(min - 1e-9);
        expect(fromDisplay(key, d.max, system)).toBeLessThanOrEqual(max + 1e-9);
      }
    }
  });
});

describe('parseDecimalInput', () => {
  it.each([
    ['178', 178],
    ['178,5', 178.5],
    ['178.5', 178.5],
    ['  62 ', 62],
    [',5', 0.5],
    ['5.', 5],
    ['178 cm', 178],
    ['70 in', 70],
  ])('acepta %j', (text, expected) => {
    const unit = text.includes('in') ? 'in' : 'cm';
    expect(parseDecimalInput(text, unit)).toEqual({ kind: 'ok', value: expected });
  });

  it.each(['abc', '1,2,3', '1.2.3', '-5', '+5', '1e3', 'Infinity', 'NaN', '0x10', '12 34', 'cm', '--', '١٢٣'])(
    'rechaza %j',
    (text) => {
      const r = parseDecimalInput(text, 'cm');
      expect(r.kind === 'ok' ? r.value : null).toBeNull();
    },
  );

  it('distingue vacío de inválido', () => {
    expect(parseDecimalInput('', 'cm')).toEqual({ kind: 'empty' });
    expect(parseDecimalInput('   ', 'cm')).toEqual({ kind: 'empty' });
    expect(parseDecimalInput('x', 'cm')).toEqual({ kind: 'invalid' });
  });

  it('nunca devuelve NaN ni infinito, sea cual sea la entrada', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const r = parseDecimalInput(text, 'cm');
        if (r.kind === 'ok') expect(Number.isFinite(r.value)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('redondeo de visualización a 1 decimal', () => {
    expect(roundForDisplay(70.04)).toBe(70);
    expect(roundForDisplay(70.06)).toBe(70.1);
  });
});
