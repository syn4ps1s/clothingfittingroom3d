import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REFERENCE_MEASUREMENTS, type CatalogData, type FitVerdict } from '@fitroom/shared';
import {
  SizingInputError,
  createStaticCatalog,
  fitQuality,
  garmentScore,
  rankGarments,
  rankGarmentsSync,
  recommendSize,
} from './index.js';
import { FC, arbBody, catalog, stretchOf } from './test-helpers.js';

const bodies = Object.entries(REFERENCE_MEASUREMENTS);

describe('fitQuality / garmentScore', () => {
  it('lo ideal es «good»; lo ceñido/holgado se premia según la preferencia', () => {
    expect(fitQuality('good')).toBe(1);
    expect(fitQuality('snug', 'snug')).toBeGreaterThan(fitQuality('snug', 'regular'));
    expect(fitQuality('roomy', 'roomy')).toBeGreaterThan(fitQuality('roomy', 'regular'));
    expect(fitQuality('too-tight')).toBeLessThan(0.25);
    expect(fitQuality('too-loose')).toBeLessThan(0.25);
    const order: FitVerdict[] = ['too-tight', 'snug', 'good', 'roomy', 'too-loose'];
    for (const v of order) {
      expect(fitQuality(v)).toBeGreaterThan(0);
      expect(fitQuality(v)).toBeLessThanOrEqual(1);
    }
  });

  it('garmentScore penaliza estar fuera de tabla y la estatura incompatible', () => {
    const g = catalog.garments.find((x) => x.id === 'tee-essential')!;
    const ok = recommendSize({
      garment: g,
      measurements: REFERENCE_MEASUREMENTS.adultA,
      fabric: stretchOf(g),
    });
    const out = recommendSize({
      garment: g,
      measurements: {
        ...REFERENCE_MEASUREMENTS.large,
        chestCm: 150,
        waistCm: 140,
        hipCm: 150,
        shoulderWidthCm: 60,
      },
      fabric: stretchOf(g),
    });
    expect(garmentScore(ok)).toBeGreaterThan(garmentScore(out));
  });
});

describe('rankGarments', () => {
  it.each(bodies)('ordena por puntuación descendente para %s, con ranking 1..n', (_n, m) => {
    const ranked = rankGarmentsSync(catalog, m);
    expect(ranked).toHaveLength(catalog.garments.length);
    ranked.forEach((r, i) => {
      expect(r.rank).toBe(i + 1);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
      expect(r.recommendation.garmentId).toBe(r.garment.id);
      expect(r.fabric.id).toBe(r.garment.fabricId);
      expect(r.reasons.length).toBeGreaterThan(0);
      if (i > 0) expect(r.score).toBeLessThanOrEqual(ranked[i - 1]!.score);
    });
  });

  it('es determinista y devuelve estructuras inmutables', () => {
    const a = rankGarmentsSync(catalog, REFERENCE_MEASUREMENTS.adultB);
    const b = rankGarmentsSync(catalog, REFERENCE_MEASUREMENTS.adultB);
    expect(b).toEqual(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a[0])).toBe(true);
    expect(Object.isFrozen(a[0]!.reasons)).toBe(true);
  });

  it('filtra por categoría, ranura, ocasión, puntuación mínima y límite', () => {
    const m = REFERENCE_MEASUREMENTS.adultA;
    expect(
      rankGarmentsSync(catalog, m, { category: 'bottoms' }).every(
        (r) => r.garment.category === 'bottoms',
      ),
    ).toBe(true);
    expect(
      rankGarmentsSync(catalog, m, { slot: 'outer' }).every((r) => r.garment.slot === 'outer'),
    ).toBe(true);
    const beach = rankGarmentsSync(catalog, m, { occasion: 'beach' });
    expect(beach.length).toBeGreaterThan(0);
    expect(beach.every((r) => r.garment.tags.includes('beach'))).toBe(true);
    expect(rankGarmentsSync(catalog, m, { limit: 3 })).toHaveLength(3);
    expect(rankGarmentsSync(catalog, m, { limit: 0 })).toHaveLength(0);
    expect(rankGarmentsSync(catalog, m, { minScore: 0.99 }).every((r) => r.score >= 0.99)).toBe(
      true,
    );
  });

  it('la preferencia y la incertidumbre se propagan a cada recomendación', () => {
    const m = REFERENCE_MEASUREMENTS.adultA;
    const snug = rankGarmentsSync(catalog, m, { preference: 'snug', category: 'tops' });
    const roomy = rankGarmentsSync(catalog, m, { preference: 'roomy', category: 'tops' });
    const idx = (r: (typeof snug)[number]) =>
      r.garment.sizes.findIndex((s) => s.label === r.recommendation.size);
    const byId = new Map(roomy.map((r) => [r.garment.id, idx(r)]));
    for (const r of snug) expect(idx(r)).toBeLessThanOrEqual(byId.get(r.garment.id)!);
    const noisy = rankGarmentsSync(catalog, m, {
      sigmaCm: { chestCm: 4, waistCm: 4, hipCm: 4 },
      category: 'tops',
    });
    expect(noisy.some((r) => r.reasons.includes('uncertain-measurements'))).toBe(true);
  });

  it('señala motivos: entre tallas, fuera de tabla y estatura', () => {
    const tiny = {
      ...REFERENCE_MEASUREMENTS.small,
      chestCm: 66,
      waistCm: 52,
      hipCm: 74,
      shoulderWidthCm: 30,
    };
    const r = rankGarmentsSync(catalog, tiny, { category: 'tops' });
    expect(r.every((x) => x.reasons.includes('out-of-size-range'))).toBe(true);
    const tall = rankGarmentsSync(
      catalog,
      { ...REFERENCE_MEASUREMENTS.adultB, heightCm: 205 },
      { category: 'tops' },
    );
    expect(tall.some((x) => x.reasons.includes('height-mismatch'))).toBe(true);
  });

  it('propiedad: nunca NaN y puntuaciones en [0,1] para cualquier cuerpo', () => {
    fc.assert(
      fc.property(arbBody, (m) => {
        for (const r of rankGarmentsSync(catalog, m)) {
          expect(Number.isFinite(r.score)).toBe(true);
          expect(r.score).toBeGreaterThanOrEqual(0);
          expect(r.score).toBeLessThanOrEqual(1);
        }
      }),
      { ...FC, numRuns: 40 },
    );
  });

  it('medidas inválidas → SizingInputError (no resultados parciales)', () => {
    expect(() =>
      rankGarmentsSync(catalog, { ...REFERENCE_MEASUREMENTS.adultA, chestCm: Number.NaN }),
    ).toThrow(SizingInputError);
  });

  it('acepta datos, repositorio estático y repositorios ajenos (asíncronos)', async () => {
    const m = REFERENCE_MEASUREMENTS.adultA;
    const sync = rankGarmentsSync(catalog, m);
    const fromData = await rankGarments(catalog, m);
    const fromRepo = await rankGarments(createStaticCatalog(), m);
    expect(fromData.map((r) => r.garment.id)).toEqual(sync.map((r) => r.garment.id));
    expect(fromRepo.map((r) => r.garment.id)).toEqual(sync.map((r) => r.garment.id));
    // un repositorio externo (sin `.data`) se lista y se REVALIDA
    const external = {
      listGarments: () => Promise.resolve(catalog.garments),
      listFabrics: () => Promise.resolve(catalog.fabrics),
      getGarment: () => Promise.resolve(undefined),
      getFabric: () => Promise.resolve(undefined),
    };
    const fromExternal = await rankGarments(external, m);
    expect(fromExternal.length).toBe(catalog.garments.length);
    const evil = {
      ...external,
      listGarments: () => Promise.resolve([{ ...catalog.garments[0]!, fabricId: '../x' }]),
    };
    await expect(rankGarments(evil as never, m)).rejects.toThrow();
  });

  it('un catálogo reducido funciona', () => {
    const mini: CatalogData = {
      version: 1,
      fabrics: catalog.fabrics.filter((f) => f.id === 'cotton-jersey-160'),
      garments: catalog.garments.filter((g) => g.id === 'tee-essential'),
    };
    expect(rankGarmentsSync(mini, REFERENCE_MEASUREMENTS.adultA)).toHaveLength(1);
  });
});
