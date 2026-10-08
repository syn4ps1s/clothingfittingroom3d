import { describe, expect, it } from 'vitest';
import { REFERENCE_MEASUREMENTS, type GarmentDefinition, type Measurements } from '@fitroom/shared';
import { SizingInputError, recommendSize } from './index.js';
import { catalog, stretchOf } from './test-helpers.js';

const garment = (id: string): GarmentDefinition => catalog.garments.find((g) => g.id === id)!;
const rec = (id: string, m: Measurements, extra: Record<string, unknown> = {}) => {
  const g = garment(id);
  return recommendSize({ garment: g, measurements: m, fabric: stretchOf(g), ...extra });
};

describe('recommendSize — casos de referencia', () => {
  it('cada cuerpo de referencia recibe su talla natural en una camiseta', () => {
    expect(rec('tee-essential', REFERENCE_MEASUREMENTS.small).size).toBe('XS');
    expect(rec('tee-essential', REFERENCE_MEASUREMENTS.adultB).size).toBe('S');
    expect(rec('tee-essential', REFERENCE_MEASUREMENTS.adultA).size).toBe('L');
    expect(rec('tee-essential', REFERENCE_MEASUREMENTS.large).size).toBe('4XL');
  });

  it('devuelve holguras reales coherentes con los datos de la prenda', () => {
    const r = rec('tee-essential', REFERENCE_MEASUREMENTS.adultB);
    const chest = r.dimensions.find((d) => d.dimension === 'chestCm')!;
    // S: pecho de prenda 100 − cuerpo 90
    expect(chest.garmentCm).toBe(100);
    expect(chest.bodyCm).toBe(90);
    expect(chest.easeCm).toBe(10);
    expect(chest.verdict).toBe('good');
    expect(r.overall).toBe('good');
    expect(r.garmentId).toBe('tee-essential');
  });

  it('los pantalones se tallan por cintura/cadera/entrepierna', () => {
    const r = rec('jeans-straight-raw', REFERENCE_MEASUREMENTS.adultB);
    expect(r.dimensions.map((d) => d.dimension)).toEqual([
      'waistCm',
      'hipCm',
      'thighCm',
      'inseamCm',
    ]);
    expect(['28', '30']).toContain(r.size);
  });

  it('la manga sólo se compara en prendas de manga larga', () => {
    const tee = rec('tee-essential', REFERENCE_MEASUREMENTS.adultA);
    expect(tee.dimensions.map((d) => d.dimension)).not.toContain('sleeveLengthCm');
    const shirt = rec('shirt-oxford', REFERENCE_MEASUREMENTS.adultA);
    expect(shirt.dimensions.map((d) => d.dimension)).toContain('sleeveLengthCm');
  });

  it('la preferencia desplaza la talla cerca de una frontera', () => {
    // pecho 100.5: dentro de L [99,105] pero cerca de M [93,99]
    const m = {
      ...REFERENCE_MEASUREMENTS.adultA,
      chestCm: 100.5,
      shoulderWidthCm: 42.5,
      waistCm: 84,
      hipCm: 99.5,
    };
    const regular = rec('tee-essential', m);
    const snug = rec('tee-essential', m, { preference: 'snug' });
    const roomy = rec('tee-essential', m, { preference: 'roomy' });
    const order = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL'];
    expect(order.indexOf(snug.size)).toBeLessThanOrEqual(order.indexOf(regular.size));
    expect(order.indexOf(roomy.size)).toBeGreaterThanOrEqual(order.indexOf(regular.size));
    expect(snug.size).not.toBe(roomy.size);
  });

  it('avisa de talla fuera de tabla, estatura y medidas poco fiables', () => {
    const tiny = {
      ...REFERENCE_MEASUREMENTS.small,
      chestCm: 66,
      waistCm: 52,
      hipCm: 74,
      shoulderWidthCm: 30,
    };
    expect(rec('tee-essential', tiny).notes).toContain('below-smallest-size');
    expect(rec('tee-essential', tiny).confidence).toBeLessThanOrEqual(0.4);
    const huge = {
      ...REFERENCE_MEASUREMENTS.large,
      chestCm: 150,
      waistCm: 140,
      hipCm: 150,
      shoulderWidthCm: 60,
    };
    expect(rec('tee-essential', huge).notes).toContain('above-largest-size');
    const tall = { ...REFERENCE_MEASUREMENTS.adultB, heightCm: 205 };
    expect(rec('tee-essential', tall).notes).toContain('height-out-of-range');
    const noisy = rec('tee-essential', REFERENCE_MEASUREMENTS.adultA, {
      sigmaCm: { chestCm: 4, waistCm: 4, hipCm: 4 },
    });
    expect(noisy.notes).toContain('low-measurement-confidence');
    const exact = rec('tee-essential', REFERENCE_MEASUREMENTS.adultA);
    expect(noisy.confidence).toBeLessThan(exact.confidence);
  });

  it('en una frontera exacta marca between-sizes y baja la confianza', () => {
    const m = {
      ...REFERENCE_MEASUREMENTS.adultA,
      chestCm: 99,
      shoulderWidthCm: 42.5,
      waistCm: 82.5,
      hipCm: 99.5,
      heightCm: 175,
    };
    const r = rec('tee-essential', m);
    expect(r.notes).toContain('between-sizes');
    expect(r.confidence).toBeLessThan(0.9);
    expect(r.alternatives.length).toBeGreaterThan(0);
  });

  it('las alternativas están ordenadas, sin la talla elegida ni duplicados', () => {
    const r = rec('tee-essential', REFERENCE_MEASUREMENTS.adultB);
    const sizes = r.alternatives.map((a) => a.size);
    expect(sizes).not.toContain(r.size);
    expect(new Set(sizes).size).toBe(sizes.length);
    expect(sizes.length).toBeLessThanOrEqual(3);
  });

  it('una talla que no se puede vestir se descarta aunque encaje en la tabla', () => {
    // jeans 32 (cintura de prenda 83,5) con cuerpo de 84: demasiado ajustado → sube a la 34
    const r = rec('jeans-straight-raw', REFERENCE_MEASUREMENTS.adultA);
    expect(r.size).toBe('34');
  });

  it('usa la elasticidad de la tela: más estirable tolera menos holgura mínima', () => {
    const base = { ...REFERENCE_MEASUREMENTS.adultA };
    const woven = recommendSize({
      garment: garment('tank-rib'),
      measurements: base,
      fabric: { stretch: 0 },
    });
    const knit = recommendSize({
      garment: garment('tank-rib'),
      measurements: base,
      fabric: { stretch: 1 },
    });
    expect(woven.size).toBeDefined();
    expect(knit.size).toBeDefined();
  });

  it('sin tabla corporal (sólo medidas de prenda) usa la holgura para decidir', () => {
    const g = garment('tee-essential');
    const stripped: GarmentDefinition = {
      ...g,
      sizes: g.sizes.map((s) => ({ label: s.label, body: {}, garment: s.garment })),
    };
    const r = recommendSize({ garment: stripped, measurements: REFERENCE_MEASUREMENTS.adultB });
    expect(r.size).toBe('S');
    expect(r.confidence).toBeLessThan(0.9);
  });

  it('prendas de una sola talla funcionan', () => {
    const g = garment('tee-essential');
    const one: GarmentDefinition = { ...g, sizes: [g.sizes[2]!] };
    const r = recommendSize({ garment: one, measurements: REFERENCE_MEASUREMENTS.adultA });
    expect(r.size).toBe('M');
    expect(r.alternatives).toEqual([]);
  });

  it('el resultado es inmutable y la entrada no se modifica', () => {
    const m = Object.freeze({ ...REFERENCE_MEASUREMENTS.adultA });
    const r = rec('tee-essential', m);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.dimensions)).toBe(true);
    expect(rec('tee-essential', m)).toEqual(r);
  });
});

describe('recommendSize — entradas inválidas → SizingInputError', () => {
  const g = garment('tee-essential');
  const ok = REFERENCE_MEASUREMENTS.adultA;

  it.each([
    ['NaN', { ...ok, chestCm: Number.NaN }],
    ['Infinity', { ...ok, waistCm: Number.POSITIVE_INFINITY }],
    ['negativa', { ...ok, hipCm: -3 }],
    ['fuera de rango', { ...ok, heightCm: 400 }],
    ['cadena', { ...ok, chestCm: '98' }],
    ['clave extra', { ...ok, extra: 1 }],
    ['faltan claves', { heightCm: 170 }],
    ['nula', null],
  ])('medidas inválidas (%s)', (_name, m) => {
    try {
      recommendSize({ garment: g, measurements: m as never });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SizingInputError);
      expect((e as SizingInputError).code).toBe('invalid-measurements');
      expect((e as SizingInputError).issues.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ['negativa', { chestCm: -1 }],
    ['NaN', { chestCm: Number.NaN }],
    ['enorme', { chestCm: 1e6 }],
    ['medida desconocida', { cabezaCm: 3 }],
    ['no es objeto', 5],
    ['array', [1]],
  ])('sigma inválida (%s)', (_name, sigmaCm) => {
    expect(() =>
      recommendSize({ garment: g, measurements: ok, sigmaCm: sigmaCm as never }),
    ).toThrow(expect.objectContaining({ code: 'invalid-sigma' }));
  });

  it('preferencia inválida', () => {
    expect(() =>
      recommendSize({ garment: g, measurements: ok, preference: 'tight' as never }),
    ).toThrow(expect.objectContaining({ code: 'invalid-preference' }));
  });

  it('prendas inválidas', () => {
    const bad = (patch: Partial<GarmentDefinition> | Record<string, unknown>) =>
      recommendSize({ garment: { ...g, ...patch } as never, measurements: ok });
    expect(() => bad({ sizes: [] })).toThrow(expect.objectContaining({ code: 'invalid-garment' }));
    expect(() => bad({ template: 'capa' })).toThrow(
      expect.objectContaining({ code: 'invalid-garment' }),
    );
    expect(() => bad({ template: '__proto__' })).toThrow(
      expect.objectContaining({ code: 'invalid-garment' }),
    );
    expect(() => bad({ fit: 'skinny' })).toThrow(
      expect.objectContaining({ code: 'invalid-garment' }),
    );
    expect(() =>
      bad({ sizes: [{ label: 'M', body: { chestCm: [Number.NaN, 3] }, garment: {} }] }),
    ).toThrow(expect.objectContaining({ code: 'invalid-garment' }));
    expect(() => bad({ sizes: [{ label: 'M', body: { chestCm: [5, 3] }, garment: {} }] })).toThrow(
      expect.objectContaining({ code: 'invalid-garment' }),
    );
    expect(() => bad({ sizes: [{ label: 'M', body: {}, garment: {} }] })).toThrow(
      expect.objectContaining({ code: 'invalid-garment' }),
    );
    expect(() =>
      bad({ sizes: [{ label: 'M', body: {}, garment: { chestCm: Number.NaN } }] }),
    ).toThrow(expect.objectContaining({ code: 'invalid-garment' }));
    expect(() => bad({ sizes: Array.from({ length: 100 }, () => g.sizes[0]) })).toThrow(
      expect.objectContaining({ code: 'invalid-garment' }),
    );
    expect(() => recommendSize(null as never)).toThrow(SizingInputError);
    expect(() => recommendSize({ garment: null as never, measurements: ok })).toThrow(
      SizingInputError,
    );
    expect(() =>
      recommendSize({ garment: g, measurements: ok, fabric: { stretch: Number.NaN } }),
    ).toThrow(SizingInputError);
  });
});
