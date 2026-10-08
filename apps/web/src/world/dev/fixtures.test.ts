import { describe, expect, it } from 'vitest';
import { CatalogDataSchema, REFERENCE_MEASUREMENTS } from '@fitroom/shared';
import { DEV_CATALOG } from './fixtures';
import { evaluateSizeFallback, recommendSizeFallback, verdictFor } from './recommend';

describe('catálogo de desarrollo', () => {
  it('cumple el esquema compartido', () => {
    const r = CatalogDataSchema.safeParse(DEV_CATALOG);
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3))).toBe(true);
  });

  it('toda prenda referencia telas existentes y cubre las cuatro categorías', () => {
    const ids = new Set(DEV_CATALOG.fabrics.map((f) => f.id));
    for (const g of DEV_CATALOG.garments) {
      expect(ids.has(g.fabricId), g.id).toBe(true);
      if (g.trimFabricId) expect(ids.has(g.trimFabricId)).toBe(true);
    }
    expect(new Set(DEV_CATALOG.garments.map((g) => g.category))).toEqual(
      new Set(['tops', 'bottoms', 'dresses', 'outerwear']),
    );
  });

  it('ids únicos', () => {
    const ids = DEV_CATALOG.garments.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('tallaje de desarrollo', () => {
  it('veredicto: ajustado bajo holgura esperada, ideal en banda, holgado por encima', () => {
    expect(verdictFor(-3, 10, 5, true)).toBe('too-tight');
    expect(verdictFor(2, 10, 5, true)).toBe('snug');
    expect(verdictFor(10, 10, 5, true)).toBe('good');
    expect(verdictFor(20, 10, 5, true)).toBe('roomy');
    expect(verdictFor(40, 10, 5, true)).toBe('too-loose');
  });

  it('recomienda una talla coherente con el pecho y devuelve veredicto por zona', () => {
    const tee = DEV_CATALOG.garments.find((g) => g.id === 'camiseta-algodon')!;
    const a = recommendSizeFallback({ garment: tee, measurements: REFERENCE_MEASUREMENTS.adultA });
    expect(a.size).toBe('M'); // pecho 98 → M (96–104)
    expect(a.dimensions.some((d) => d.dimension === 'chestCm')).toBe(true);
    expect(a.confidence).toBeGreaterThan(0.5);
    const small = recommendSizeFallback({ garment: tee, measurements: REFERENCE_MEASUREMENTS.small });
    expect(['XS', 'S']).toContain(small.size);
  });

  it('la confianza baja con la incertidumbre y fuera de tabla', () => {
    const tee = DEV_CATALOG.garments.find((g) => g.id === 'camiseta-algodon')!;
    const exact = recommendSizeFallback({ garment: tee, measurements: REFERENCE_MEASUREMENTS.adultA });
    const noisy = recommendSizeFallback({
      garment: tee,
      measurements: REFERENCE_MEASUREMENTS.adultA,
      sigmaCm: { chestCm: 5, waistCm: 5 },
    });
    expect(noisy.confidence).toBeLessThan(exact.confidence);
    expect(noisy.notes).toContain('low-measurement-confidence');
    const huge = recommendSizeFallback({ garment: tee, measurements: { ...REFERENCE_MEASUREMENTS.large, chestCm: 160 } });
    expect(huge.notes).toContain('above-largest-size');
  });

  it('evaluar una talla concreta es determinista y no depende de las demás', () => {
    const jeans = DEV_CATALOG.garments.find((g) => g.id === 'vaquero-recto')!;
    const s = jeans.sizes[2]!;
    expect(evaluateSizeFallback(jeans, s, REFERENCE_MEASUREMENTS.adultA)).toEqual(
      evaluateSizeFallback({ ...jeans, sizes: [s] }, s, REFERENCE_MEASUREMENTS.adultA),
    );
  });

  it('nunca produce NaN con medidas de referencia extremas', () => {
    for (const m of Object.values(REFERENCE_MEASUREMENTS)) {
      for (const g of DEV_CATALOG.garments) {
        const r = recommendSizeFallback({ garment: g, measurements: m });
        expect(Number.isFinite(r.confidence)).toBe(true);
        for (const d of r.dimensions) expect(Number.isFinite(d.easeCm)).toBe(true);
      }
    }
  });
});
