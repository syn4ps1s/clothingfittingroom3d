import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CatalogDataSchema, FABRIC_FAMILIES } from '@fitroom/shared';
import { CatalogDataError, loadCatalogData, parseCatalogData } from './index.js';

describe('loadCatalogData', () => {
  const data = loadCatalogData();

  it('devuelve datos que cumplen CatalogDataSchema', () => {
    expect(CatalogDataSchema.safeParse(data).success).toBe(true);
  });

  it('tiene el volumen de contenido exigido (≥ 14 telas, ≥ 16 prendas, 4–6 muestras)', () => {
    expect(data.fabrics.length).toBeGreaterThanOrEqual(14);
    expect(data.garments.length).toBeGreaterThanOrEqual(16);
    for (const g of data.garments) {
      expect(g.variants.length, g.id).toBeGreaterThanOrEqual(4);
      expect(g.variants.length, g.id).toBeLessThanOrEqual(6);
    }
    expect(new Set(data.fabrics.map((f) => f.family))).toEqual(new Set(FABRIC_FAMILIES));
  });

  it('es profundamente inmutable y se memoiza', () => {
    expect(loadCatalogData()).toBe(data);
    expect(Object.isFrozen(data)).toBe(true);
    expect(Object.isFrozen(data.garments)).toBe(true);
    expect(Object.isFrozen(data.garments[0]!.sizes[0]!.body)).toBe(true);
    expect(() => {
      (data.garments[0] as { id: string }).id = 'hack';
    }).toThrow(TypeError);
    expect(() => {
      (data.fabrics as unknown[]).push({});
    }).toThrow(TypeError);
  });

  it('el JSON completo ocupa menos de 250 KB', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'data');
    const bytes = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .reduce((sum, f) => sum + readFileSync(join(dir, f)).byteLength, 0);
    expect(bytes).toBeLessThan(250 * 1024);
  });

  it('falla de forma explícita y legible con datos corruptos', () => {
    const corrupt = structuredClone(data) as { garments: { variants: { color: string }[] }[] };
    corrupt.garments[2]!.variants[0]!.color = 'rojo';
    let error: unknown;
    try {
      parseCatalogData(corrupt);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CatalogDataError);
    const err = error as CatalogDataError;
    expect(err.code).toBe('CATALOG_INVALID');
    expect(err.message).toContain('garments[2].variants[0].color');
    expect(err.issues.length).toBeGreaterThan(0);
  });
});
