import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  REFERENCE_MEASUREMENTS,
  type CatalogData,
  type GarmentDefinition,
  type SwatchVariant,
} from '@fitroom/shared';
import { SizingInputError, recommendSize, suggestOutfits, suggestOutfitsSync } from './index.js';
import { FC, arbBody, catalog, garmentOf, stretchOf } from './test-helpers.js';

const bodies = Object.entries(REFERENCE_MEASUREMENTS);

const solid = (id: string, color: string): SwatchVariant => ({
  id,
  name: { es: id, en: id },
  color,
  pattern: { type: 'solid' },
});

/** Catálogo mínimo: una camiseta, un vaquero y una cazadora con muestras elegidas a propósito. */
function miniCatalog(variants: { tee: SwatchVariant[]; jeans: SwatchVariant[]; jacket?: SwatchVariant[] }): CatalogData {
  const tee = { ...garmentOf('tee-essential'), variants: variants.tee };
  const jeans = { ...garmentOf('jeans-straight-raw'), variants: variants.jeans };
  const garments: GarmentDefinition[] = [tee, jeans];
  const ids = new Set([tee.fabricId, jeans.fabricId]);
  if (variants.jacket) {
    const jacket = { ...garmentOf('jacket-corduroy-overshirt'), variants: variants.jacket };
    garments.push(jacket);
    ids.add(jacket.fabricId);
  }
  return { version: 1, fabrics: catalog.fabrics.filter((f) => ids.has(f.id)), garments };
}

describe('suggestOutfits — estructura', () => {
  it.each(bodies)('propone conjuntos completos y válidos para %s', (_n, m) => {
    const outfits = suggestOutfitsSync(catalog, m);
    expect(outfits.length).toBeGreaterThan(0);
    expect(outfits.length).toBeLessThanOrEqual(6);
    const ids = new Set<string>();
    for (const o of outfits) {
      expect(ids.has(o.id)).toBe(false);
      ids.add(o.id);
      const roles = o.items.map((i) => i.role);
      // superior+inferior o vestido, y como mucho una prenda exterior al final
      const core = roles.filter((r) => r !== 'outer');
      expect(core.length === 2 ? core.join() === 'top,bottom' : core.join() === 'full').toBe(true);
      expect(roles.filter((r) => r === 'outer').length).toBeLessThanOrEqual(1);
      if (roles.includes('outer')) expect(roles.at(-1)).toBe('outer');
      for (const item of o.items) {
        const expectedSlot = { top: 'upper', bottom: 'lower', full: 'full', outer: 'outer' }[item.role];
        expect(item.garment.slot).toBe(expectedSlot);
        expect(item.garment.variants.map((v) => v.id)).toContain(item.variant.id);
        expect(item.garment.sizes.map((s) => s.label)).toContain(item.recommendation.size);
        expect(['too-tight', 'too-loose']).not.toContain(item.recommendation.overall);
        // la talla coincide con la recomendación individual
        const direct = recommendSize({ garment: item.garment, measurements: m, fabric: item.fabric });
        expect(item.recommendation.size).toBe(direct.size);
      }
      for (const x of [o.score, o.breakdown.fit, o.breakdown.color, o.breakdown.occasion, o.harmony.score]) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(1);
      }
      expect(o.id).toBe(o.items.map((i) => `${i.garment.id}:${i.variant.id}`).join('+'));
      expect(Object.isFrozen(o)).toBe(true);
    }
  });

  it('es determinista', () => {
    const a = suggestOutfitsSync(catalog, REFERENCE_MEASUREMENTS.adultB);
    const b = suggestOutfitsSync(catalog, REFERENCE_MEASUREMENTS.adultB);
    expect(b).toEqual(a);
  });

  it('el primero es el de mayor puntuación y se respeta el límite y la diversidad', () => {
    const outfits = suggestOutfitsSync(catalog, REFERENCE_MEASUREMENTS.adultA, { limit: 8, maxPerGarment: 2 });
    expect(outfits.length).toBeLessThanOrEqual(8);
    expect(Math.max(...outfits.map((o) => o.score))).toBe(outfits[0]!.score);
    const uses = new Map<string, number>();
    for (const o of outfits) for (const i of o.items) uses.set(i.garment.id, (uses.get(i.garment.id) ?? 0) + 1);
    for (const n of uses.values()) expect(n).toBeLessThanOrEqual(2);
    expect(suggestOutfitsSync(catalog, REFERENCE_MEASUREMENTS.adultA, { limit: 0 })).toEqual([]);
  });

  it('outer: never excluye abrigos, always los exige', () => {
    const m = REFERENCE_MEASUREMENTS.adultA;
    const never = suggestOutfitsSync(catalog, m, { outer: 'never', limit: 10 });
    expect(never.length).toBeGreaterThan(0);
    expect(never.every((o) => o.items.every((i) => i.role !== 'outer'))).toBe(true);
    const always = suggestOutfitsSync(catalog, m, { outer: 'always', limit: 10 });
    expect(always.length).toBeGreaterThan(0);
    expect(always.every((o) => o.items.some((i) => i.role === 'outer'))).toBe(true);
    const auto = suggestOutfitsSync(catalog, m, { limit: 10 });
    expect(auto.some((o) => o.reasons.includes('layered'))).toBe(true);
  });

  it('el filtro de ocasión sólo usa prendas con esa etiqueta', () => {
    const beach = suggestOutfitsSync(catalog, REFERENCE_MEASUREMENTS.adultA, { occasion: 'beach', outer: 'never' });
    expect(beach.length).toBeGreaterThan(0);
    for (const o of beach) for (const i of o.items) expect(i.garment.tags).toContain('beach');
  });

  it('sin prendas aptas devuelve lista vacía; sin parte inferior sólo propone vestidos', () => {
    const onlyTops: CatalogData = {
      version: 1,
      fabrics: catalog.fabrics.filter((f) => f.id === 'cotton-jersey-160'),
      garments: catalog.garments.filter((g) => g.id === 'tee-essential'),
    };
    expect(suggestOutfitsSync(onlyTops, REFERENCE_MEASUREMENTS.adultA)).toEqual([]);
    const withDress = suggestOutfitsSync(
      { ...catalog, garments: catalog.garments.filter((g) => g.category === 'tops' || g.category === 'dresses') },
      REFERENCE_MEASUREMENTS.adultB,
      { outer: 'never' },
    );
    expect(withDress.length).toBeGreaterThan(0);
    expect(withDress.every((o) => o.items.length === 1 && o.items[0]!.role === 'full')).toBe(true);
  });

  it('versión asíncrona equivalente y medidas inválidas → error tipado', async () => {
    const m = REFERENCE_MEASUREMENTS.small;
    const a = await suggestOutfits(catalog, m, { limit: 3 });
    expect(a).toEqual(suggestOutfitsSync(catalog, m, { limit: 3 }));
    await expect(suggestOutfits(catalog, { ...m, heightCm: -4 })).rejects.toBeInstanceOf(SizingInputError);
  });

  it('propiedad: nunca NaN, ids únicos y puntuaciones válidas para cualquier cuerpo', () => {
    fc.assert(
      fc.property(arbBody, fc.constantFrom('snug' as const, 'regular' as const, 'roomy' as const), (m, preference) => {
        const outfits = suggestOutfitsSync(catalog, m, { preference, limit: 4 });
        expect(new Set(outfits.map((o) => o.id)).size).toBe(outfits.length);
        for (const o of outfits) {
          expect(Number.isFinite(o.score)).toBe(true);
          expect(o.score).toBeGreaterThanOrEqual(0);
          expect(o.score).toBeLessThanOrEqual(1);
        }
      }),
      { ...FC, numRuns: 25 },
    );
  });

  it('los mejores conjuntos no mezclan verano con invierno ni ocasiones incompatibles', () => {
    for (const [, m] of bodies) {
      const top = suggestOutfitsSync(catalog, m, { limit: 3 });
      for (const o of top) {
        expect(o.reasons).not.toContain('season-clash');
        expect(o.reasons).not.toContain('occasion-conflict');
      }
    }
  });
});

describe('suggestOutfits — armonía de color', () => {
  it('elige muestras que armonizan y evita el choque naranja + rosa', () => {
    const data = miniCatalog({
      tee: [solid('orange', '#ff6a00'), solid('ink', '#1c1d21')],
      jeans: [solid('pink', '#e91e8c'), solid('ecru', '#ede6d6')],
    });
    const [best] = suggestOutfitsSync(data, REFERENCE_MEASUREMENTS.adultB, { outer: 'never' });
    const colors = best!.items.map((i) => i.variant.id);
    expect(colors).not.toEqual(['orange', 'pink']);
    expect(colors[1]).toBe('ecru');
    expect(['neutral', 'accent']).toContain(best!.harmony.kind);
    expect(best!.harmony.score).toBeGreaterThan(0.8);
  });

  it('con sólo muestras chocantes baja la puntuación de color y lo señala', () => {
    const clash = miniCatalog({ tee: [solid('orange', '#ff6a00')], jeans: [solid('pink', '#e91e8c')] });
    const fine = miniCatalog({ tee: [solid('ink', '#1c1d21')], jeans: [solid('ecru', '#ede6d6')] });
    const [a] = suggestOutfitsSync(clash, REFERENCE_MEASUREMENTS.adultB, { outer: 'never' });
    const [b] = suggestOutfitsSync(fine, REFERENCE_MEASUREMENTS.adultB, { outer: 'never' });
    expect(a!.harmony.kind).toBe('clash');
    expect(a!.reasons).toContain('colors-clash');
    expect(a!.breakdown.color).toBeLessThan(b!.breakdown.color - 0.3);
    expect(a!.score).toBeLessThan(b!.score);
  });

  it('penaliza enfrentar dos estampados', () => {
    const stripes = (id: string): SwatchVariant => ({
      id,
      name: { es: id, en: id },
      color: '#f4f1ea',
      pattern: { type: 'stripes', color2: '#22304a', widthMm: 10, gapMm: 10, angleDeg: 0 },
    });
    const both = miniCatalog({ tee: [stripes('s1')], jeans: [stripes('s2')] });
    const one = miniCatalog({ tee: [stripes('s1')], jeans: [solid('navy', '#22304a')] });
    const [a] = suggestOutfitsSync(both, REFERENCE_MEASUREMENTS.adultB, { outer: 'never' });
    const [b] = suggestOutfitsSync(one, REFERENCE_MEASUREMENTS.adultB, { outer: 'never' });
    expect(a!.reasons).toContain('pattern-clash');
    expect(b!.reasons).not.toContain('pattern-clash');
    expect(a!.breakdown.color).toBeLessThan(b!.breakdown.color);
  });

  it('añade la prenda exterior cuando armoniza y la omite en modo never', () => {
    const data = miniCatalog({
      tee: [solid('ink', '#1c1d21')],
      jeans: [solid('indigo', '#2b3a55')],
      jacket: [solid('camel', '#b38a5b'), solid('hot', '#ff2d95')],
    });
    const [layered] = suggestOutfitsSync(data, REFERENCE_MEASUREMENTS.adultB);
    expect(layered!.items.map((i) => i.role)).toEqual(['top', 'bottom', 'outer']);
    expect(layered!.items[2]!.variant.id).toBe('camel');
    const [plain] = suggestOutfitsSync(data, REFERENCE_MEASUREMENTS.adultB, { outer: 'never' });
    expect(plain!.items).toHaveLength(2);
  });
});

describe('suggestOutfits — coherencia de ocasión', () => {
  it('prefiere conjuntos de formalidad homogénea', () => {
    const [best] = suggestOutfitsSync(catalog, REFERENCE_MEASUREMENTS.adultA, { outer: 'never', limit: 1 });
    expect(best!.breakdown.occasion).toBeGreaterThan(0.85);
    // blazer de tweed + bermudas es un mal conjunto: puntuación de ocasión baja
    const mixed: CatalogData = {
      version: 1,
      fabrics: catalog.fabrics,
      garments: ['tee-essential', 'shorts-linen', 'coat-wool-long'].map(garmentOf),
    };
    const [withCoat] = suggestOutfitsSync(mixed, REFERENCE_MEASUREMENTS.adultA, { outer: 'always' });
    expect(withCoat!.breakdown.occasion).toBeLessThan(0.5);
    expect(withCoat!.reasons).toContain('season-clash');
    const [without] = suggestOutfitsSync(mixed, REFERENCE_MEASUREMENTS.adultA, { outer: 'never' });
    expect(without!.score).toBeGreaterThan(withCoat!.score);
  });

  it('la talla de cada prenda sigue la preferencia', () => {
    const m = REFERENCE_MEASUREMENTS.adultA;
    const snug = suggestOutfitsSync(catalog, m, { preference: 'snug', outer: 'never', limit: 1 })[0]!;
    const roomy = suggestOutfitsSync(catalog, m, { preference: 'roomy', outer: 'never', limit: 1 })[0]!;
    expect(snug.items.length).toBeGreaterThan(0);
    expect(roomy.items.length).toBeGreaterThan(0);
    for (const item of snug.items) {
      const direct = recommendSize({ garment: item.garment, measurements: m, preference: 'snug', fabric: stretchOf(item.garment) });
      expect(item.recommendation.size).toBe(direct.size);
    }
  });
});
