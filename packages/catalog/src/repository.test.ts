import { describe, expect, it } from 'vitest';
import { GARMENT_CATEGORIES, GARMENT_SLOTS, type CatalogData } from '@fitroom/shared';
import { CatalogDataError, createStaticCatalog, loadCatalogData, normalizeText } from './index.js';

const repo = createStaticCatalog();
const data = loadCatalogData();

describe('normalizeText', () => {
  it('ignora mayúsculas, acentos, diéresis y espacios repetidos', () => {
    expect(normalizeText('  CAMÍSA   de  Lino ')).toBe('camisa de lino');
    expect(normalizeText('Ünïcödé Ñandú Ça')).toBe('unicode nandu ca');
    expect(normalizeText('Straße Øl Æ')).toBe('strasse ol ae');
  });
  it('es idempotente', () => {
    const once = normalizeText('Pantalón Vaquero ÁÉÍÓÚ');
    expect(normalizeText(once)).toBe(once);
  });
});

describe('createStaticCatalog', () => {
  it('lista todo en el orden estable del catálogo', async () => {
    const all = await repo.listGarments();
    expect(all.map((g) => g.id)).toEqual(data.garments.map((g) => g.id));
    const again = await repo.listGarments({});
    expect(again.map((g) => g.id)).toEqual(all.map((g) => g.id));
  });

  it('filtra por categoría y por ranura', async () => {
    for (const category of GARMENT_CATEGORIES) {
      const list = await repo.listGarments({ category });
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((g) => g.category === category)).toBe(true);
    }
    for (const slot of GARMENT_SLOTS) {
      const list = await repo.listGarments({ slot });
      expect(list.every((g) => g.slot === slot)).toBe(true);
    }
    const both = await repo.listGarments({ category: 'tops', slot: 'lower' });
    expect(both).toEqual([]);
  });

  it('busca sin distinguir mayúsculas ni acentos, en español e inglés', async () => {
    const es = await repo.listGarments({ text: 'CAMISA' });
    const en = await repo.listGarments({ text: 'shirt' });
    expect(es.map((g) => g.id)).toContain('shirt-oxford');
    expect(en.map((g) => g.id)).toContain('shirt-oxford');
    const accent = await repo.listGarments({ text: 'crepé de seda' });
    const noAccent = await repo.listGarments({ text: 'CREPE DE SEDA' });
    expect(accent.map((g) => g.id)).toEqual(noAccent.map((g) => g.id));
    expect(accent.map((g) => g.id)).toContain('skirt-midi-pleated');
    // también por color de muestra, tela, marca y etiqueta
    expect((await repo.listGarments({ text: 'burdeos' })).length).toBeGreaterThan(1);
    expect((await repo.listGarments({ text: 'cashmere-que-no-existe' })).length).toBe(0);
    expect((await repo.listGarments({ text: 'atelier norte' })).length).toBeGreaterThan(1);
    expect((await repo.listGarments({ text: 'winter' })).length).toBeGreaterThan(1);
  });

  it('todos los términos deben coincidir (AND) y se combina con los filtros', async () => {
    const r = await repo.listGarments({ text: 'lino camisa' });
    expect(r.map((g) => g.id)).toContain('shirt-linen-costa');
    const narrowed = await repo.listGarments({ text: 'lino', category: 'bottoms' });
    expect(narrowed.every((g) => g.category === 'bottoms')).toBe(true);
    expect(narrowed.map((g) => g.id)).toContain('shorts-linen');
  });

  it('ordena por relevancia con desempate estable', async () => {
    const r = await repo.listGarments({ text: 'jeans' });
    const again = await repo.listGarments({ text: 'jeans' });
    expect(r.map((g) => g.id)).toEqual(again.map((g) => g.id));
    expect(r.map((g) => g.id)).toEqual(expect.arrayContaining(['jeans-straight-raw', 'jeans-slim-stretch']));
  });

  it('ignora texto vacío o sólo espacios y acota consultas enormes', async () => {
    const all = await repo.listGarments();
    expect(await repo.listGarments({ text: '   ' })).toEqual(all);
    const huge = await repo.listGarments({ text: 'a '.repeat(500_000) });
    expect(Array.isArray(huge)).toBe(true);
  });

  it('un filtro con valores desconocidos devuelve vacío, no excepciones', async () => {
    expect(await repo.listGarments({ category: 'nope' as never })).toEqual([]);
    expect(await repo.listGarments(null as never)).toEqual(all(await repo.listGarments()));
  });

  it('getGarment/getFabric: encuentran, no encuentran y resisten ids hostiles', async () => {
    expect((await repo.getGarment('tee-essential'))?.template).toBe('tee');
    expect(await repo.getGarment('no-existe')).toBeUndefined();
    expect(await repo.getGarment('__proto__')).toBeUndefined();
    expect(await repo.getGarment('constructor')).toBeUndefined();
    expect(await repo.getGarment(42 as never)).toBeUndefined();
    expect((await repo.getFabric('denim-12oz'))?.family).toBe('denim');
    expect(await repo.getFabric('toString')).toBeUndefined();
    expect((await repo.listFabrics()).length).toBe(data.fabrics.length);
  });

  it('devuelve estructuras inmutables', async () => {
    const list = await repo.listGarments();
    expect(Object.isFrozen(list)).toBe(true);
    expect(() => (list as unknown[]).reverse()).toThrow(TypeError);
    expect(() => {
      (list[0] as { brand: string }).brand = 'X';
    }).toThrow(TypeError);
    const fabrics = await repo.listFabrics();
    expect(Object.isFrozen(fabrics)).toBe(true);
    // Las listas devueltas son independientes: reordenar una copia no afecta a las siguientes consultas.
    const copy = [...list].reverse();
    expect(copy[0]!.id).not.toBe(list[0]!.id);
    expect((await repo.listGarments())[0]!.id).toBe(list[0]!.id);
  });

  it('acepta datos propios válidos y rechaza los inválidos', async () => {
    const mini: CatalogData = {
      version: 1,
      fabrics: data.fabrics.filter((f) => f.id === 'cotton-jersey-160'),
      garments: data.garments.filter((g) => g.id === 'tee-essential'),
    };
    const small = createStaticCatalog(mini);
    expect((await small.listGarments()).length).toBe(1);
    expect(small.data.garments).toHaveLength(1);
    const bad = { ...mini, garments: [{ ...mini.garments[0]!, fabricId: 'no-existe' }] };
    expect(() => createStaticCatalog(bad)).toThrow(CatalogDataError);
  });
});

function all<T>(x: readonly T[]): readonly T[] {
  return x;
}
