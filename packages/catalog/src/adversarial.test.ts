/**
 * JSON externo malicioso o corrupto: el catálogo debe RECHAZARLO con un error legible y acotado
 * (nunca aceptarlo a medias, nunca colgarse, nunca contaminar prototipos).
 */
import { describe, expect, it } from 'vitest';
import {
  CATALOG_LIMITS,
  CatalogDataError,
  createStaticCatalog,
  hasUnsafeText,
  loadCatalogData,
  parseCatalogData,
  scanRawCatalog,
} from './index.js';
import { catalog } from './test-helpers.js';

type Json = Record<string, unknown>;
/** Copia profunda MUTABLE del catálogo válido (los datos reales están congelados). */
const fresh = (): { version: number; fabrics: Json[]; garments: Json[] } =>
  structuredClone(catalog) as never;
const garmentOf = (d: ReturnType<typeof fresh>, i = 0) =>
  d.garments[i] as Json & {
    name: { es: string; en: string };
    variants: Json[];
    sizes: { label: string; body: Record<string, number[]>; garment: Record<string, number> }[];
    tags: string[];
    params: Record<string, number>;
  };

function expectRejected(raw: unknown, fragment?: string): CatalogDataError {
  let error: unknown;
  try {
    parseCatalogData(raw);
  } catch (e) {
    error = e;
  }
  expect(error, 'debía rechazarse').toBeInstanceOf(CatalogDataError);
  const err = error as CatalogDataError;
  expect(err.issues.length).toBeGreaterThan(0);
  // mensajes acotados y sin saltos de línea de datos hostiles
  expect(err.message.length).toBeLessThan(2500);
  expect(err.message).not.toMatch(/[\n\r]/);
  if (fragment) expect(err.message).toContain(fragment);
  return err;
}

describe('estructura y tipos', () => {
  it('rechaza raíces que no son objetos', () => {
    for (const bad of [null, undefined, 42, 'x', [], true, () => 1, Symbol('s')])
      expectRejected(bad);
  });

  it('rechaza campos extra en cualquier nivel (strict)', () => {
    const top = { ...fresh(), extra: 1 };
    expectRejected(top, 'extra');
    const d = fresh();
    garmentOf(d).evil = 'x';
    expectRejected(d, 'garments[0]');
    const d2 = fresh();
    garmentOf(d2).sizes[0]!.body.cabezaCm = [1, 2];
    expectRejected(d2);
    const d3 = fresh();
    (garmentOf(d3).variants[0] as Json).onclick = 'alert(1)';
    expectRejected(d3, 'variants[0]');
  });

  it('rechaza tipos erróneos', () => {
    expectRejected({ ...fresh(), version: '1' }, 'version');
    expectRejected({ ...fresh(), fabrics: {} }, 'fabrics');
    expectRejected({ ...fresh(), garments: null }, 'garments');
    expectRejected({ ...fresh(), garments: [] }, 'garments');
    const d = fresh();
    d.fabrics[0]!.weightGsm = '160';
    expectRejected(d, 'weightGsm');
    const d2 = fresh();
    garmentOf(d2).sizes[0]!.garment.chestCm = 'NaN' as never;
    expectRejected(d2, 'chestCm');
    const d3 = fresh();
    d3.fabrics[0]!.stretch = true;
    expectRejected(d3, 'stretch');
  });

  it('rechaza NaN, ±Infinity y números fuera de rango', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -5, 1e9]) {
      const d = fresh();
      garmentOf(d).sizes[1]!.garment.chestCm = bad;
      expectRejected(d, 'chestCm');
    }
    const d = fresh();
    garmentOf(d).params.neckWidthRatio = Number.NaN;
    expectRejected(d, 'params');
    const d2 = fresh();
    garmentOf(d2).sizes[0]!.body.chestCm = [Number.NaN, 90];
    expectRejected(d2);
  });

  it('rechaza strings enormes con un error acotado', () => {
    const d = fresh();
    garmentOf(d).name.es = 'A'.repeat(1_000_000);
    const err = expectRejected(d, 'name.es');
    expect(err.message.length).toBeLessThan(1500);
    const d2 = fresh();
    d2.garments[0]!.id = 'x'.repeat(100_000);
    expectRejected(d2, 'id');
    const d3 = fresh();
    garmentOf(d3).tags = Array.from({ length: 5_000 }, (_, i) => `t${i}`);
    expectRejected(d3, 'tags');
    const d4 = fresh();
    garmentOf(d4).variants = Array.from({ length: 5_000 }, () =>
      structuredClone(garmentOf(d4).variants[0]!),
    );
    expectRejected(d4, 'variants');
  });

  it('acota el trabajo: demasiadas prendas o telas', () => {
    const d = fresh();
    d.garments = Array.from({ length: CATALOG_LIMITS.maxGarments + 1 }, () => ({}));
    expectRejected(d, 'demasiadas prendas');
    const d2 = fresh();
    d2.fabrics = Array.from({ length: CATALOG_LIMITS.maxFabrics + 1 }, () => ({}));
    expectRejected(d2, 'demasiadas telas');
  });
});

describe('prototipos y estructuras peligrosas', () => {
  it('rechaza __proto__, constructor y prototype (JSON.parse crea claves propias)', () => {
    const text = JSON.stringify(fresh());
    const injected = [
      text.replace('{"version"', '{"__proto__":{"polluted":true},"version"'),
      text.replace('"name":{', '"name":{"__proto__":{"polluted":true},'),
      text.replace('"params":{', '"params":{"__proto__":1,'),
      text.replace('"params":{', '"params":{"constructor":1,'),
      text.replace('"pattern":{', '"pattern":{"prototype":1,'),
    ];
    for (const json of injected) {
      const raw = JSON.parse(json) as unknown;
      expectRejected(raw, 'clave prohibida');
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
  });

  it('rechaza anidación excesiva y estructuras cíclicas sin desbordar la pila', () => {
    let deep: Json = {};
    const root = deep;
    for (let i = 0; i < 100_000; i++) {
      const next: Json = {};
      deep.a = next;
      deep = next;
    }
    expectRejected(root, 'anidación');
    const cyc: Json = { version: 1, fabrics: [], garments: [] };
    cyc.self = cyc;
    expectRejected(cyc);
    const d = fresh();
    d.fabrics[0]!.self = d;
    expectRejected(d);
  });

  it('rechaza getters/setters, funciones, símbolos y bigint', () => {
    let calls = 0;
    const d = fresh();
    Object.defineProperty(d.fabrics[0], 'trap', {
      enumerable: true,
      get() {
        calls++;
        return 1;
      },
    });
    expectRejected(d, 'getter');
    expect(calls).toBe(0);
    const d2 = fresh();
    d2.fabrics[0]!.fn = () => 1;
    expectRejected(d2, 'tipo no permitido');
    const d3 = fresh();
    d3.fabrics[0]!.big = 10n;
    expectRejected(d3, 'tipo no permitido');
    const d4 = fresh();
    d4.fabrics[0]!.sym = Symbol('x');
    expectRejected(d4, 'tipo no permitido');
  });

  it('rechaza objetos no planos (Map, Date…) y arrays donde va un objeto', () => {
    expectRejected({ ...fresh(), fabrics: new Map() });
    const d = fresh();
    d.garments[0] = [] as never;
    expectRejected(d);
    expectRejected(new Map());
  });

  it('scanRawCatalog es utilizable por separado y no lanza', () => {
    expect(scanRawCatalog(fresh())).toEqual([]);
    expect(scanRawCatalog(null).length).toBe(1);
  });
});

describe('ids y referencias', () => {
  it.each([
    '../etc/passwd',
    '..\\windows',
    'a/b',
    'UPPER',
    'con espacios',
    'ñandú',
    '',
    '-lead',
    'x',
    'id;drop table',
    'id\u0000',
    '%2e%2e%2f',
    'https://evil.example/x',
  ])('rechaza ids hostiles: %j', (id) => {
    const d = fresh();
    d.garments[0]!.id = id;
    expectRejected(d, 'garments[0].id');
    const d2 = fresh();
    d2.fabrics[0]!.id = id;
    expectRejected(d2, 'fabrics[0].id');
    const d3 = fresh();
    (garmentOf(d3).variants[0] as Json).id = id;
    expectRejected(d3, 'variants[0].id');
  });

  it('rechaza ids duplicados y referencias colgantes', () => {
    const d = fresh();
    d.garments[1]!.id = d.garments[0]!.id;
    expectRejected(d, 'duplicado');
    const d2 = fresh();
    d2.fabrics[1]!.id = d2.fabrics[0]!.id;
    expectRejected(d2, 'duplicado');
    const d3 = fresh();
    d3.garments[0]!.fabricId = 'no-existe';
    expectRejected(d3, 'no existe');
    const d4 = fresh();
    d4.garments[0]!.trimFabricId = '../../x';
    expectRejected(d4);
    const d5 = fresh();
    garmentOf(d5).variants[1]!.id = garmentOf(d5).variants[0]!.id;
    expectRejected(d5, 'muestra duplicado');
  });

  it('rechaza etiquetas y claves de parámetros con formato inválido', () => {
    const d = fresh();
    garmentOf(d).tags = ['<b>negrita</b>'];
    expectRejected(d, 'tags');
    const d2 = fresh();
    garmentOf(d2).tags = ['Casual'];
    expectRejected(d2, 'kebab-case');
    const d3 = fresh();
    garmentOf(d3).tags = ['casual', 'casual'];
    expectRejected(d3, 'duplicadas');
    const d4 = fresh();
    garmentOf(d4).params['bad key!'] = 1;
    expectRejected(d4, 'clave de parámetro');
  });
});

describe('HTML y texto peligroso en nombres', () => {
  const payloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    'Camisa <b>roja</b>',
    '"><svg/onload=alert(1)>',
    'a > b',
    'línea\nnueva',
    'tab\taqui',
    'nul\u0000byte',
    'rlo‮exe.txt',
    'isolate⁦x⁩',
    'zero​width',
    'bom﻿x',
    'separator x',
  ];

  it.each(payloads)('rechaza %j en nombre, descripción, marca y muestras', (payload) => {
    const d = fresh();
    garmentOf(d).name.en = payload;
    expectRejected(d, 'name.en');
    const d2 = fresh();
    (garmentOf(d2).description as { es: string }).es = `Texto ${payload} fin.`;
    expectRejected(d2, 'description.es');
    const d3 = fresh();
    d3.garments[0]!.brand = payload;
    expectRejected(d3, 'brand');
    const d4 = fresh();
    ((garmentOf(d4).variants[0] as Json).name as { es: string }).es = payload;
    expectRejected(d4, 'variants[0].name.es');
    const d5 = fresh();
    (d5.fabrics[0]!.name as { es: string }).es = payload;
    expectRejected(d5, 'fabrics[0].name.es');
  });

  it('los textos legítimos con comillas, ampersand y acentos se aceptan', () => {
    const d = fresh();
    garmentOf(d).name.en = `Men's "Essential" Tee & Co.`;
    garmentOf(d).name.es = 'Camiseta «Esencial» — ñ, ü, ç';
    expect(() => parseCatalogData(d)).not.toThrow();
    expect(hasUnsafeText('hola mundo')).toBe(false);
    expect(hasUnsafeText('a<b')).toBe(true);
  });

  it('un texto como "javascript:alert(1)" se acepta como texto plano pero nunca contiene HTML', () => {
    // La defensa es doble: sin < > en datos, y la UI renderiza TODO como texto (nunca innerHTML).
    const d = fresh();
    garmentOf(d).name.en = 'javascript:alert(1)';
    const parsed = parseCatalogData(d);
    expect(parsed.garments[0]!.name.en).toBe('javascript:alert(1)');
    expect(parsed.garments[0]!.name.en).not.toMatch(/[<>]/);
  });
});

describe('tablas de tallas corruptas', () => {
  it('rechaza rangos invertidos, tallas desordenadas, duplicadas y dimensiones a medias', () => {
    const inverted = fresh();
    garmentOf(inverted).sizes[2]!.body.chestCm = [100, 90];
    expectRejected(inverted, 'invertido');

    const shuffled = fresh();
    const sizes = garmentOf(shuffled).sizes;
    [sizes[1], sizes[2]] = [sizes[2]!, sizes[1]!];
    expectRejected(shuffled, 'deben crecer');

    const dup = fresh();
    garmentOf(dup).sizes[1]!.label = garmentOf(dup).sizes[0]!.label;
    expectRejected(dup, 'duplicada');

    const partial = fresh();
    delete garmentOf(partial).sizes[3]!.garment.chestCm;
    expectRejected(partial, 'todas las tallas o en ninguna');

    const partialBody = fresh();
    delete garmentOf(partialBody).sizes[3]!.body.chestCm;
    expectRejected(partialBody, 'todas las tallas o en ninguna');

    const badLabel = fresh();
    garmentOf(badLabel).sizes[0]!.label = '<b>';
    expectRejected(badLabel);

    const decreasing = fresh();
    garmentOf(decreasing).sizes[4]!.garment.chestCm = 80;
    expectRejected(decreasing, 'crecer');
  });

  it('rechaza plantilla/categoría/ranura incoherentes', () => {
    const d = fresh();
    d.garments[0]!.category = 'bottoms';
    expectRejected(d, 'pertenece a');
    const d2 = fresh();
    d2.garments[0]!.slot = 'lower';
    expectRejected(d2, 'ranura');
    const d3 = fresh();
    d3.garments[0]!.template = 'capa';
    expectRejected(d3);
  });
});

describe('efectos en el repositorio', () => {
  it('createStaticCatalog rechaza datos corruptos y el catálogo empaquetado sigue intacto', () => {
    const d = fresh();
    d.garments[0]!.fabricId = '../etc';
    expect(() => createStaticCatalog(d as never)).toThrow(CatalogDataError);
    expect(() => loadCatalogData()).not.toThrow();
    expect(loadCatalogData().garments[0]!.fabricId).not.toBe('../etc');
  });

  it('los errores incluyen ruta legible y mensajes sin eco ilimitado de claves hostiles', () => {
    const d = fresh();
    d.fabrics[0]![`${'k'.repeat(100_000)}`] = 1;
    const err = expectRejected(d);
    expect(err.message.length).toBeLessThan(1500);
    const rejected = fresh();
    rejected.garments[0]!.template = 'x'.repeat(5000);
    expect(expectRejected(rejected).message.length).toBeLessThan(2500);
  });
});
