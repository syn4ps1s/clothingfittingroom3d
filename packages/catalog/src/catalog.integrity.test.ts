/**
 * Pruebas de integridad del catálogo EMPAQUETADO (datos reales): son la red de seguridad del contenido que
 * alimenta al generador de geometría, a la UI y al tallaje.
 */
import { describe, expect, it } from 'vitest';
import {
  FABRIC_FAMILIES,
  GARMENT_CATEGORIES,
  GARMENT_SLOTS,
  GARMENT_TEMPLATES,
  REFERENCE_MEASUREMENTS,
  type GarmentDefinition,
  type SizeBodyRange,
} from '@fitroom/shared';
import {
  CATALOG_TAGS,
  CATEGORY_SLOT,
  FORMALITY_TAGS,
  SEASON_TAGS,
  TEMPLATE_CATEGORY,
  TEMPLATE_PARAM_SPECS,
  TEMPLATE_PROFILES,
  hexToOklch,
  nominalEase,
  recommendSize,
} from './index.js';
import { catalog, stretchOf } from './test-helpers.js';

const { garments, fabrics } = catalog;
const PLACEHOLDER =
  /lorem|ipsum|todo|tbd|fixme|xxx|placeholder|asdf|\bfoo\b|\bbar\b|sample text|texto de prueba/i;

const localized = (g: GarmentDefinition) => [
  g.name.es,
  g.name.en,
  g.description.es,
  g.description.en,
  ...g.variants.flatMap((v) => [v.name.es, v.name.en]),
];

describe('ids y referencias', () => {
  it('los ids de prendas, telas y muestras son únicos', () => {
    expect(new Set(garments.map((g) => g.id)).size).toBe(garments.length);
    expect(new Set(fabrics.map((f) => f.id)).size).toBe(fabrics.length);
    for (const g of garments) {
      expect(new Set(g.variants.map((v) => v.id)).size, g.id).toBe(g.variants.length);
      expect(new Set(g.sizes.map((s) => s.label)).size, g.id).toBe(g.sizes.length);
    }
  });

  it('todos los fabricId / trimFabricId existen y no hay telas huérfanas', () => {
    const ids = new Set(fabrics.map((f) => f.id));
    const used = new Set<string>();
    for (const g of garments) {
      expect(ids.has(g.fabricId), `${g.id}.fabricId`).toBe(true);
      used.add(g.fabricId);
      if (g.trimFabricId) {
        expect(ids.has(g.trimFabricId), `${g.id}.trimFabricId`).toBe(true);
        used.add(g.trimFabricId);
      }
    }
    for (const f of fabrics) expect(used.has(f.id), `tela sin usar: ${f.id}`).toBe(true);
  });

  it('categoría, ranura y plantilla son coherentes entre sí', () => {
    for (const g of garments) {
      expect(TEMPLATE_CATEGORY[g.template], g.id).toBe(g.category);
      expect(CATEGORY_SLOT[g.category], g.id).toBe(g.slot);
    }
  });
});

describe('cobertura del catálogo', () => {
  it('cada plantilla aparece al menos una vez', () => {
    for (const t of GARMENT_TEMPLATES) {
      expect(
        garments.some((g) => g.template === t),
        `plantilla ${t}`,
      ).toBe(true);
    }
  });

  it('cada categoría y ranura tiene al menos 3 prendas', () => {
    for (const c of GARMENT_CATEGORIES) {
      expect(
        garments.filter((g) => g.category === c).length,
        `categoría ${c}`,
      ).toBeGreaterThanOrEqual(3);
    }
    for (const s of GARMENT_SLOTS) {
      expect(garments.filter((g) => g.slot === s).length, `ranura ${s}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('cubre todas las familias de tela y los 6 tipos de estampado', () => {
    expect(new Set(fabrics.map((f) => f.family))).toEqual(new Set(FABRIC_FAMILIES));
    const patterns = new Set(garments.flatMap((g) => g.variants.map((v) => v.pattern.type)));
    expect(patterns).toEqual(
      new Set(['solid', 'stripes', 'plaid', 'dots', 'herringbone', 'floral']),
    );
    const fits = new Set(garments.map((g) => g.fit));
    expect(fits).toEqual(new Set(['slim', 'regular', 'relaxed', 'oversized']));
  });

  it('hay al menos 14 telas y 16 prendas, cada una con 4–6 muestras', () => {
    expect(fabrics.length).toBeGreaterThanOrEqual(14);
    expect(garments.length).toBeGreaterThanOrEqual(16);
    for (const g of garments) {
      expect(g.variants.length, g.id).toBeGreaterThanOrEqual(4);
      expect(g.variants.length, g.id).toBeLessThanOrEqual(6);
    }
  });
});

describe('textos', () => {
  it('es/en presentes, distintos, sin marcadores de posición y bien formados', () => {
    for (const g of garments) {
      for (const text of localized(g)) {
        expect(text.trim().length, g.id).toBeGreaterThan(0);
        expect(PLACEHOLDER.test(text), `${g.id}: «${text}»`).toBe(false);
        expect(text, g.id).toBe(text.trim());
      }
      expect(g.name.es, g.id).not.toBe(g.name.en);
      expect(g.description.es, g.id).not.toBe(g.description.en);
      for (const lang of ['es', 'en'] as const) {
        expect(g.name[lang].length, g.id).toBeGreaterThanOrEqual(8);
        expect(g.description[lang].length, g.id).toBeGreaterThanOrEqual(80);
        expect(g.description[lang].endsWith('.'), `${g.id} ${lang}`).toBe(true);
      }
      // nombres de muestra únicos dentro de la prenda
      for (const lang of ['es', 'en'] as const) {
        expect(new Set(g.variants.map((v) => v.name[lang])).size, `${g.id} ${lang}`).toBe(
          g.variants.length,
        );
      }
    }
    for (const f of fabrics) {
      expect(PLACEHOLDER.test(f.name.es + f.name.en)).toBe(false);
      expect(f.name.es).not.toBe(f.name.en);
    }
  });

  it('las marcas son ficticias (ninguna marca real conocida)', () => {
    const real = [
      'zara',
      'h&m',
      'nike',
      'adidas',
      'levi',
      'uniqlo',
      'mango',
      'gucci',
      'prada',
      'burberry',
      'ralph lauren',
      'tommy',
      'lacoste',
      'carhartt',
      'patagonia',
      'north face',
      'diesel',
      'gap',
      'primark',
      'decathlon',
      'wrangler',
      'lee',
      'dockers',
    ];
    const brands = new Set(garments.map((g) => g.brand));
    expect(brands.size).toBeGreaterThanOrEqual(4);
    for (const b of brands) {
      const lower = b.toLowerCase();
      for (const r of real)
        expect(lower.includes(r) && lower.split(/\W+/).includes(r), `${b} ~ ${r}`).toBe(false);
    }
    expect(brands.has('Atelier Norte')).toBe(true);
    expect(brands.has('Costa Lino')).toBe(true);
  });

  it('los precios son positivos y razonables', () => {
    for (const g of garments) {
      expect(g.price, g.id).toBeDefined();
      expect(g.price!.amount).toBeGreaterThan(5);
      expect(g.price!.amount).toBeLessThan(1000);
    }
  });
});

describe('color', () => {
  const colorsOf = (g: GarmentDefinition) =>
    g.variants.flatMap((v) => {
      const p = v.pattern;
      return [
        v.color,
        ...(p.type === 'solid' ? [] : [p.color2]),
        ...(p.type === 'plaid' || p.type === 'floral' ? [p.color3 ?? p.color2] : []),
      ];
    });

  it('todos los colores son #rrggbb válidos', () => {
    for (const g of garments)
      for (const c of colorsOf(g)) expect(c, g.id).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('paletas apagadas y armónicas: nada estridente ni deslavado', () => {
    for (const g of garments) {
      for (const c of colorsOf(g)) {
        const o = hexToOklch(c);
        expect(o.c, `${g.id} ${c} croma`).toBeLessThanOrEqual(0.16);
        expect(o.l, `${g.id} ${c} luminosidad`).toBeGreaterThan(0.18);
        expect(o.l, `${g.id} ${c} luminosidad`).toBeLessThan(0.98);
      }
    }
  });

  it('las muestras de una prenda son visualmente distintas y hay al menos una lisa', () => {
    for (const g of garments) {
      expect(
        g.variants.some((v) => v.pattern.type === 'solid'),
        g.id,
      ).toBe(true);
      const keys = g.variants.map((v) => `${v.color}|${JSON.stringify(v.pattern)}`);
      expect(new Set(keys).size, g.id).toBe(keys.length);
    }
  });
});

describe('telas', () => {
  const RANGE: Record<string, [number, number]> = {
    'cotton-jersey': [100, 300],
    'cotton-poplin': [80, 200],
    denim: [250, 500],
    linen: [100, 300],
    'wool-knit': [200, 700],
    merino: [120, 300],
    satin: [80, 200],
    'silk-crepe': [50, 140],
    leather: [400, 900],
    corduroy: [200, 400],
    fleece: [200, 450],
    twill: [150, 350],
    tweed: [250, 600],
  };

  it('el gramaje es creíble para cada familia', () => {
    for (const f of fabrics) {
      const [min, max] = RANGE[f.family]!;
      expect(f.weightGsm, f.id).toBeGreaterThanOrEqual(min);
      expect(f.weightGsm, f.id).toBeLessThanOrEqual(max);
    }
  });

  it('los tejidos de punto son más elásticos que los tejidos planos', () => {
    const knit = new Set(['cotton-jersey', 'wool-knit', 'merino', 'fleece']);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const knitStretch = avg(fabrics.filter((f) => knit.has(f.family)).map((f) => f.stretch));
    const wovenStretch = avg(
      fabrics.filter((f) => !knit.has(f.family) && f.family !== 'denim').map((f) => f.stretch),
    );
    expect(knitStretch).toBeGreaterThan(wovenStretch + 0.2);
  });

  it('el satén brilla más y es más liso que el lino; el cuero y el denim son rígidos', () => {
    const by = (id: string) => fabrics.find((f) => f.id === id)!;
    expect(by('satin-crepe-back-130').sheen).toBeGreaterThan(by('linen-washed-170').sheen + 0.5);
    expect(by('satin-crepe-back-130').roughness).toBeLessThan(by('linen-washed-170').roughness);
    expect(by('leather-lamb-09').stiffness).toBeGreaterThan(0.5);
    expect(by('denim-12oz').stiffness).toBeGreaterThan(by('silk-crepe-90').stiffness);
  });

  it('las telas de tejido compacto tienen más hilos por cm que los puntos gruesos', () => {
    const by = (id: string) => fabrics.find((f) => f.id === id)!;
    expect(by('poplin-cotton-110').threadsPerCm).toBeGreaterThan(
      by('wool-knit-chunky').threadsPerCm * 4,
    );
  });
});

describe('estampados y tela', () => {
  it('el periodo físico de cada estampado cabe en el tile de su tela (la textura no lo encoge)', () => {
    const byId = new Map(fabrics.map((f) => [f.id, f]));
    for (const g of garments) {
      const tileMm = byId.get(g.fabricId)!.tileCm * 10;
      for (const v of g.variants) {
        const p = v.pattern;
        const period =
          p.type === 'stripes'
            ? p.widthMm + p.gapMm
            : p.type === 'dots'
              ? p.spacingMm
              : p.type === 'plaid' || p.type === 'herringbone'
                ? p.sizeMm
                : p.type === 'floral'
                  ? p.scaleMm
                  : 0;
        expect(period, `${g.id}/${v.id}`).toBeLessThanOrEqual(tileMm + 1e-9);
      }
    }
  });
});

describe('tablas de tallas', () => {
  /** dimensión principal que define la talla (contigua sin huecos) */
  const primary = (g: GarmentDefinition): keyof SizeBodyRange =>
    g.category === 'bottoms' ? 'waistCm' : 'chestCm';

  it('los rangos corporales crecen con la talla, sin huecos ni solapes grotescos', () => {
    for (const g of garments) {
      const keys = Object.keys(g.sizes[0]!.body) as (keyof SizeBodyRange)[];
      expect(keys.length, g.id).toBeGreaterThanOrEqual(3);
      for (const key of keys) {
        for (let i = 0; i < g.sizes.length; i++) {
          const [lo, hi] = g.sizes[i]!.body[key]!;
          expect(lo, `${g.id}.${key}[${i}]`).toBeLessThan(hi);
          if (i === 0) continue;
          const [plo, phi] = g.sizes[i - 1]!.body[key]!;
          expect(lo, `${g.id}.${key}[${i}] lo`).toBeGreaterThanOrEqual(plo);
          expect(hi, `${g.id}.${key}[${i}] hi`).toBeGreaterThanOrEqual(phi);
          const gap = lo - phi;
          const overlap = phi - lo;
          if (key === 'heightCm') {
            // la estatura es secundaria: se admite solape de hasta el 75 % del rango
            expect(gap, `${g.id} altura hueco`).toBeLessThanOrEqual(0);
            expect(overlap, `${g.id} altura solape`).toBeLessThanOrEqual(0.75 * (phi - plo));
          } else if (key === primary(g)) {
            expect(gap, `${g.id}.${key} hueco`).toBeLessThanOrEqual(1);
            expect(overlap, `${g.id}.${key} solape`).toBeLessThanOrEqual(1);
          } else {
            expect(gap, `${g.id}.${key} hueco`).toBeLessThanOrEqual(2);
            expect(overlap, `${g.id}.${key} solape`).toBeLessThanOrEqual(2);
          }
        }
      }
    }
  });

  it('las medidas de la prenda crecen (o se mantienen) con la talla', () => {
    for (const g of garments) {
      const dims = Object.keys(
        g.sizes[0]!.garment,
      ) as (keyof (typeof g.sizes)[number]['garment'])[];
      for (const dim of dims) {
        for (let i = 1; i < g.sizes.length; i++) {
          expect(g.sizes[i]!.garment[dim], `${g.id}.${dim}[${i}]`).toBeGreaterThanOrEqual(
            g.sizes[i - 1]!.garment[dim]!,
          );
        }
      }
    }
  });

  it('gradación coherente: contorno principal +3,5…7 cm por talla (pecho en superiores, cintura en pantalones)', () => {
    for (const g of garments) {
      const dim = g.category === 'bottoms' ? 'waistCm' : 'chestCm';
      for (let i = 1; i < g.sizes.length; i++) {
        const step = g.sizes[i]!.garment[dim]! - g.sizes[i - 1]!.garment[dim]!;
        expect(step, `${g.id}.${dim}[${i}]`).toBeGreaterThanOrEqual(3.5);
        expect(step, `${g.id}.${dim}[${i}]`).toBeLessThanOrEqual(7);
      }
    }
  });

  it('largos y mangas crecen con la talla de forma moderada', () => {
    for (const g of garments) {
      for (const dim of ['lengthCm', 'sleeveLengthCm'] as const) {
        const first = g.sizes[0]!.garment[dim];
        if (first === undefined || first === 0) continue;
        for (let i = 1; i < g.sizes.length; i++) {
          const step = g.sizes[i]!.garment[dim]! - g.sizes[i - 1]!.garment[dim]!;
          expect(step, `${g.id}.${dim}[${i}]`).toBeGreaterThanOrEqual(0);
          expect(step, `${g.id}.${dim}[${i}]`).toBeLessThanOrEqual(4);
        }
      }
    }
  });

  it('la holgura nominal por ajuste es 4 / 10 / 16 / 24 cm de pecho en prendas superiores (y 8 / 14 / 20 / 28 en exteriores)', () => {
    const chestRule = (g: GarmentDefinition) =>
      TEMPLATE_PROFILES[g.template].ease.find((r) => r.dimension === 'chestCm')!;
    expect(chestRule(garments.find((g) => g.template === 'tee')!).nominal).toEqual([4, 10, 16, 24]);
    expect(chestRule(garments.find((g) => g.template === 'blazer')!).nominal).toEqual([
      8, 14, 20, 28,
    ]);
    const fitsSeen = new Set<string>();
    for (const g of garments.filter((x) => x.category === 'tops' || x.category === 'outerwear')) {
      const rule = chestRule(g);
      const inner = g.sizes.slice(1, -1);
      const eases = inner
        .map((s) => s.garment.chestCm! - (s.body.chestCm![0] + s.body.chestCm![1]) / 2)
        .sort((a, b) => a - b);
      const median = eases[eases.length >> 1]!;
      expect(median, g.id).toBeGreaterThan(nominalEase(rule, g.fit) - 1.5);
      expect(median, g.id).toBeLessThan(nominalEase(rule, g.fit) + 1.5);
      fitsSeen.add(`${g.category}:${g.fit}`);
    }
    expect(fitsSeen.size).toBeGreaterThanOrEqual(6);
  });

  it('la holgura de cada dimensión comparable coincide con la nominal del perfil de la plantilla', () => {
    const bodyKey = {
      chestCm: 'chestCm',
      waistCm: 'waistCm',
      hipCm: 'hipCm',
      shoulderWidthCm: 'shoulderWidthCm',
      inseamCm: 'inseamCm',
    } as const;
    for (const g of garments) {
      for (const rule of TEMPLATE_PROFILES[g.template].ease) {
        const key = bodyKey[rule.dimension as keyof typeof bodyKey];
        if (
          !key ||
          g.sizes[0]!.garment[rule.dimension] === undefined ||
          g.sizes[0]!.body[key] === undefined
        )
          continue;
        if (rule.requiresFull === 'inseam' && g.sizes[0]!.garment[rule.dimension]! < 55) continue;
        const inner = g.sizes.slice(1, -1);
        const eases = inner
          .map((s) => s.garment[rule.dimension]! - (s.body[key]![0] + s.body[key]![1]) / 2)
          .sort((a, b) => a - b);
        const median = eases[eases.length >> 1]!;
        expect(
          Math.abs(median - nominalEase(rule, g.fit)),
          `${g.id}.${rule.dimension}`,
        ).toBeLessThanOrEqual(1.5);
      }
    }
  });

  it('las medidas son físicamente plausibles', () => {
    for (const g of garments) {
      for (const s of g.sizes) {
        const m = s.garment;
        const id = `${g.id}/${s.label}`;
        if (g.category !== 'bottoms') expect(m.chestCm ?? m.hipCm, id).toBeDefined();
        if (g.category === 'tops' || g.category === 'outerwear') {
          expect(m.chestCm!, id).toBeGreaterThan(m.shoulderWidthCm! * 1.8);
          expect(m.waistCm!, id).toBeLessThanOrEqual(m.chestCm!);
          expect(m.lengthCm!, id).toBeGreaterThan(50);
          if (g.template === 'tee' || g.template === 'polo')
            expect(m.sleeveLengthCm!, id).toBeLessThan(32);
          if (g.template === 'tank') expect(m.sleeveLengthCm, id).toBe(0);
          if (
            ['long_sleeve', 'shirt', 'sweater', 'hoodie', 'blazer', 'jacket', 'coat'].includes(
              g.template,
            )
          ) {
            expect(m.sleeveLengthCm!, id).toBeGreaterThan(50);
            expect(m.sleeveLengthCm!, id).toBeLessThan(80);
          }
        }
        if (g.category === 'bottoms' && g.template !== 'skirt') {
          expect(m.hipCm!, id).toBeGreaterThan(m.waistCm!);
          expect(m.thighCm!, id).toBeGreaterThan(m.legOpeningCm! * 0.9);
          expect(m.riseCm!, id).toBeGreaterThanOrEqual(20);
          expect(m.riseCm!, id).toBeLessThanOrEqual(34);
          if (g.template === 'shorts') expect(m.inseamCm!, id).toBeLessThan(40);
          else expect(m.inseamCm!, id).toBeGreaterThan(65);
        }
        if (g.template === 'skirt') {
          expect(m.hemCm!, id).toBeGreaterThan(m.hipCm!);
          expect(m.lengthCm!, id).toBeGreaterThan(55);
        }
        if (g.category === 'dresses') {
          expect(m.hemCm!, id).toBeGreaterThanOrEqual(m.hipCm!);
          expect(m.lengthCm!, id).toBeGreaterThan(85);
        }
      }
    }
  });
});

describe('cobertura corporal (los 4 cuerpos de referencia)', () => {
  const reasonable = (
    g: GarmentDefinition,
    m: (typeof REFERENCE_MEASUREMENTS)[keyof typeof REFERENCE_MEASUREMENTS],
  ) => {
    const r = recommendSize({ garment: g, measurements: m, fabric: stretchOf(g) });
    return (
      (r.overall === 'snug' || r.overall === 'good' || r.overall === 'roomy') &&
      !r.notes.includes('below-smallest-size') &&
      !r.notes.includes('above-largest-size')
    );
  };

  for (const [name, m] of Object.entries(REFERENCE_MEASUREMENTS)) {
    for (const category of GARMENT_CATEGORIES) {
      it(`${name} tiene talla razonable en ≥ 90 % de «${category}»`, () => {
        const list = garments.filter((g) => g.category === category);
        const ok = list.filter((g) => reasonable(g, m));
        expect(
          ok.length / list.length,
          `fallan: ${list
            .filter((g) => !ok.includes(g))
            .map((g) => g.id)
            .join(', ')}`,
        ).toBeGreaterThanOrEqual(0.9);
      });
    }
  }

  it('la recomendación tiene confianza razonable en las prendas superiores y exteriores', () => {
    for (const m of Object.values(REFERENCE_MEASUREMENTS)) {
      for (const g of garments.filter((x) => x.category === 'tops' || x.category === 'outerwear')) {
        expect(
          recommendSize({ garment: g, measurements: m, fabric: stretchOf(g) }).confidence,
          g.id,
        ).toBeGreaterThan(0.6);
      }
    }
  });
});

describe('etiquetas y parámetros de plantilla', () => {
  it('las etiquetas pertenecen al vocabulario cerrado y cada prenda declara formalidad y estación', () => {
    for (const g of garments) {
      expect(g.tags.length, g.id).toBeGreaterThanOrEqual(3);
      for (const tag of g.tags) expect(CATALOG_TAGS, `${g.id}:${tag}`).toContain(tag);
      expect(
        g.tags.some((t) => t in FORMALITY_TAGS),
        g.id,
      ).toBe(true);
      expect(
        g.tags.some((t) => (SEASON_TAGS as readonly string[]).includes(t)),
        g.id,
      ).toBe(true);
    }
    // la mezcla verano/invierno existe en el catálogo (necesaria para probar la coherencia de estación)
    expect(garments.some((g) => g.tags.includes('summer'))).toBe(true);
    expect(garments.some((g) => g.tags.includes('winter'))).toBe(true);
  });

  it('params: cada prenda define las claves obligatorias de su plantilla, dentro de rango, y ninguna desconocida', () => {
    for (const g of garments) {
      const spec = TEMPLATE_PARAM_SPECS[g.template];
      const allowed = { ...spec.required, ...spec.optional };
      for (const [key, rule] of Object.entries(spec.required)) {
        const v = g.params?.[key];
        expect(v, `${g.id}.${key} obligatorio`).toBeDefined();
        expect(v!, `${g.id}.${key}`).toBeGreaterThanOrEqual(rule.min);
        expect(v!, `${g.id}.${key}`).toBeLessThanOrEqual(rule.max);
      }
      for (const [key, v] of Object.entries(g.params ?? {})) {
        expect(allowed[key], `${g.id}: clave desconocida «${key}»`).toBeDefined();
        expect(v).toBeGreaterThanOrEqual(allowed[key]!.min);
        expect(v).toBeLessThanOrEqual(allowed[key]!.max);
      }
    }
  });

  it('los valores por defecto de los parámetros están dentro de su rango', () => {
    for (const spec of Object.values(TEMPLATE_PARAM_SPECS)) {
      for (const rule of [...Object.values(spec.required), ...Object.values(spec.optional)]) {
        expect(rule.default).toBeGreaterThanOrEqual(rule.min);
        expect(rule.default).toBeLessThanOrEqual(rule.max);
      }
    }
  });
});
