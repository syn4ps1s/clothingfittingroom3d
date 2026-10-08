import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { FABRIC_FAMILIES, type FabricDef, type FabricFamily, type SwatchVariant } from '@fitroom/shared';
import {
  generateFabricTextures,
  generateFabricTexturesAsync,
  FabricInputError,
} from './index.js';
import { planFabricTextures } from './textures.js';
import { fitPeriod, fitStripeLattice, roundToUnit } from './lattice.js';
import { hexToLinear, shiftHueLinear } from './color.js';
import {
  EXAMPLE_COLORS,
  EXAMPLE_FABRICS,
  EXAMPLE_PATTERNS,
  exampleVariant,
} from './fixtures.js';

const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

/** canal `c` (0..3) de un buffer RGBA como Float64 */
function channel(rgba: Uint8Array, size: number, c: number): Float64Array {
  const out = new Float64Array(size * size);
  for (let i = 0; i < size * size; i++) out[i] = rgba[i * 4 + c]!;
  return out;
}

/**
 * Detector de costura. Para cada par de columnas (filas) adyacentes se calcula la diferencia media a lo largo
 * de la otra dirección ("perfil de escalón"). En un tile periódico el escalón de la envoltura es una muestra
 * más de esa distribución: no puede superar el MÁXIMO de los escalones interiores (con holgura); una costura
 * real (textura no periódica) lo supera con creces. Devuelve la razón wrap / max(interior) por eje.
 */
function seamRatio(ch: Float64Array, S: number): { x: number; y: number } {
  const stepX = new Float64Array(S); // escalón entre columna k y k+1 (k = S-1 → envoltura)
  const stepY = new Float64Array(S);
  for (let k = 0; k < S; k++) {
    const k1 = (k + 1) % S;
    let sx = 0;
    let sy = 0;
    for (let t = 0; t < S; t++) {
      sx += Math.abs(ch[t * S + k1]! - ch[t * S + k]!);
      sy += Math.abs(ch[k1 * S + t]! - ch[k * S + t]!);
    }
    stepX[k] = sx / S;
    stepY[k] = sy / S;
  }
  let mx = 1e-9;
  let my = 1e-9;
  for (let k = 0; k < S - 1; k++) {
    mx = Math.max(mx, stepX[k]!);
    my = Math.max(my, stepY[k]!);
  }
  return { x: stepX[S - 1]! / mx, y: stepY[S - 1]! / my };
}

function stats(ch: Float64Array): { mean: number; std: number } {
  let m = 0;
  for (const v of ch) m += v;
  m /= ch.length;
  let s = 0;
  for (const v of ch) s += (v - m) * (v - m);
  return { mean: m, std: Math.sqrt(s / ch.length) };
}

const S = 128;

describe('generateFabricTextures: contrato básico', () => {
  for (const family of FABRIC_FAMILIES) {
    it(`${family}: tamaños, alfa, normales unitarias y rangos ORM`, () => {
      const tex = generateFabricTextures(
        EXAMPLE_FABRICS[family],
        exampleVariant(family),
        S as 512,
        11,
      );
      expect(tex.size).toBe(S);
      expect(tex.albedo.length).toBe(S * S * 4);
      expect(tex.normal.length).toBe(S * S * 4);
      expect(tex.orm.length).toBe(S * S * 4);
      expect(tex.tileMeters).toBeCloseTo(EXAMPLE_FABRICS[family].tileCm / 100, 12);
      expect(tex.info.family).toBe(family);
      let badNormal = 0;
      for (let i = 0; i < S * S; i++) {
        expect(tex.albedo[i * 4 + 3]).toBe(255);
        expect(tex.normal[i * 4 + 3]).toBe(255);
        expect(tex.orm[i * 4 + 3]).toBe(255);
        const nx = tex.normal[i * 4]! / 127.5 - 1;
        const ny = tex.normal[i * 4 + 1]! / 127.5 - 1;
        const nz = tex.normal[i * 4 + 2]! / 127.5 - 1;
        const l = Math.hypot(nx, ny, nz);
        if (Math.abs(l - 1) > 0.03 || nz <= 0) badNormal++;
        expect(tex.orm[i * 4 + 2]).toBe(0); // sin metal
        expect(tex.orm[i * 4 + 1]).toBeGreaterThanOrEqual(10);
      }
      expect(badNormal).toBe(0);
    });
  }

  it('el albedo no es un color plano (variación por hilo) y la normal tiene relieve', () => {
    for (const family of FABRIC_FAMILIES) {
      const tex = generateFabricTextures(EXAMPLE_FABRICS[family], exampleVariant(family), S as 512, 3);
      expect(stats(channel(tex.albedo, S, 1)).std).toBeGreaterThan(0.8);
      const nx = stats(channel(tex.normal, S, 0));
      const ny = stats(channel(tex.normal, S, 1));
      expect(Math.max(nx.std, ny.std)).toBeGreaterThan(1.0);
    }
  });

  it('respeta variant.color: el color medio (lineal) queda cerca del pedido en familias sin color secundario', () => {
    const fams: FabricFamily[] = ['cotton-jersey', 'cotton-poplin', 'twill', 'satin', 'silk-crepe', 'corduroy', 'merino'];
    for (const family of fams) {
      const tex = generateFabricTextures(EXAMPLE_FABRICS[family], exampleVariant(family), 256 as 512, 5);
      const want = hexToLinear(EXAMPLE_COLORS[family]);
      const got = [0, 0, 0];
      const lin = (c: number): number => {
        const x = c / 255;
        return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      };
      for (let i = 0; i < 256 * 256; i++) for (let c = 0; c < 3; c++) got[c] = got[c]! + lin(tex.albedo[i * 4 + c]!);
      for (let c = 0; c < 3; c++) {
        const mean = got[c]! / (256 * 256);
        expect(Math.abs(mean - want[c]!)).toBeLessThan(0.12 * Math.max(want[c]!, 0.05));
      }
    }
  });

  it('familias distintas producen texturas distintas con la misma semilla y color', () => {
    const base = EXAMPLE_FABRICS['cotton-poplin'];
    const a = generateFabricTextures(base, exampleVariant('cotton-poplin'), S as 512, 1);
    const b = generateFabricTextures(
      { ...base, family: 'twill' },
      exampleVariant('cotton-poplin'),
      S as 512,
      1,
    );
    expect(same(a.normal, b.normal)).toBe(false);
  });
});

describe('determinismo', () => {
  it('misma semilla → mismos bytes; otra semilla → distintos (todas las familias)', () => {
    for (const family of FABRIC_FAMILIES) {
      const f = EXAMPLE_FABRICS[family];
      const v = exampleVariant(family);
      const a = generateFabricTextures(f, v, S as 512, 42);
      const b = generateFabricTextures(f, v, S as 512, 42);
      const c = generateFabricTextures(f, v, S as 512, 43);
      expect(same(a.albedo, b.albedo)).toBe(true);
      expect(same(a.normal, b.normal)).toBe(true);
      expect(same(a.orm, b.orm)).toBe(true);
      expect(same(a.albedo, c.albedo) && same(a.normal, c.normal)).toBe(false);
    }
  });

  it('sin semilla se deriva de los ids (estable) y semillas raras no rompen nada', () => {
    const f = EXAMPLE_FABRICS.denim;
    const v = exampleVariant('denim');
    const a = generateFabricTextures(f, v, S as 512);
    const b = generateFabricTextures(f, v, S as 512);
    expect(same(a.albedo, b.albedo)).toBe(true);
    expect(a.info.seed).toBe(b.info.seed);
    for (const seed of [NaN, Infinity, -Infinity, -1, 2 ** 40, 0.5]) {
      const t = generateFabricTextures(f, v, 64 as 512, seed);
      expect(t.albedo.length).toBe(64 * 64 * 4);
    }
  });

  it('plan por pasos == generación directa', () => {
    const f = EXAMPLE_FABRICS.merino;
    const v = exampleVariant('merino', EXAMPLE_PATTERNS[2]);
    const direct = generateFabricTextures(f, v, S as 512, 9);
    const plan = planFabricTextures(f, v, S, 9);
    expect(plan.steps.length).toBeGreaterThan(8);
    for (const s of plan.steps) s();
    const r = plan.result();
    expect(same(r.albedo, direct.albedo)).toBe(true);
    expect(same(r.normal, direct.normal)).toBe(true);
    expect(same(r.orm, direct.orm)).toBe(true);
  });
});

describe('tileabilidad (sin costura al repetir)', () => {
  const size = 256 as 512;
  for (const family of FABRIC_FAMILIES) {
    it(`${family}: la costura de envoltura no se distingue de la diferencia interior (albedo y normal)`, () => {
      const tex = generateFabricTextures(EXAMPLE_FABRICS[family], exampleVariant(family), size, 21);
      for (const [buf, ch] of [
        [tex.albedo, 1],
        [tex.normal, 0],
        [tex.normal, 1],
        [tex.orm, 0],
      ] as const) {
        const r = seamRatio(channel(buf, size, ch), size);
        expect(r.x).toBeLessThan(1.15);
        expect(r.y).toBeLessThan(1.15);
      }
    });
  }

  for (const pi of [1, 2, 3, 4, 5]) {
    const pat = EXAMPLE_PATTERNS[pi]!;
    it(`patrón ${pat.type}: sin costura sobre popelín y denim`, () => {
      for (const family of ['cotton-poplin', 'denim', 'cotton-jersey'] as const) {
        const tex = generateFabricTextures(
          EXAMPLE_FABRICS[family],
          exampleVariant(family, pat),
          size,
          77,
        );
        for (const ch of [0, 1, 2]) {
          const r = seamRatio(channel(tex.albedo, size, ch), size);
          expect(r.x).toBeLessThan(1.15);
          expect(r.y).toBeLessThan(1.15);
        }
      }
    });
  }

  it('la costura SÍ se detectaría en una textura no periódica (el test no es vacuo)', () => {
    const ramp = new Float64Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) ramp[y * size + x] = x + y;
    expect(seamRatio(ramp, size).x).toBeGreaterThan(20);
  });
});

describe('escala física del tejido', () => {
  it('threadsPerCm × tileCm hilos por tile cuando caben (≥ 8 px por hilo)', () => {
    const f: FabricDef = { ...EXAMPLE_FABRICS['cotton-poplin'], threadsPerCm: 12, tileCm: 4 };
    const t = generateFabricTextures(f, exampleVariant('cotton-poplin'), 512, 1);
    expect(t.info.requestedThreadsAcrossTile).toBeCloseTo(48, 9);
    expect(t.info.threadsAcrossTile).toBe(48);
    expect(t.info.pxPerThread).toBeCloseTo(512 / 48, 9);
    expect(t.info.frequencyLowered).toBe(false);
    expect(t.info.effectiveThreadsPerCm).toBeCloseTo(12, 9);
  });

  it('si no cabe baja la frecuencia manteniendo ≥ 8 px/hilo y lo declara', () => {
    for (const family of ['cotton-poplin', 'denim', 'twill', 'linen', 'satin', 'tweed'] as const) {
      const f: FabricDef = { ...EXAMPLE_FABRICS[family], threadsPerCm: 80, tileCm: 10 };
      for (const size of [128, 256, 512] as const) {
        const t = generateFabricTextures(f, exampleVariant(family), size as 512, 1);
        expect(t.info.pxPerThread).toBeGreaterThanOrEqual(7.9);
        expect(t.info.frequencyLowered).toBe(true);
        expect(t.info.threadsAcrossTile).toBeLessThanOrEqual(size / 8);
      }
    }
  });

  it('el nº de hilos es múltiplo del repetido del ligamento (encaja en el tile)', () => {
    for (const family of FABRIC_FAMILIES) {
      const t = generateFabricTextures(EXAMPLE_FABRICS[family], exampleVariant(family), 256 as 512, 1);
      expect(t.info.threadsAcrossTile % t.info.weaveRepeat.u).toBe(0);
      expect(t.info.threadsAlongTile % t.info.weaveRepeat.v).toBe(0);
    }
  });

  it('los puntos usan ≥ 12 px por puntada', () => {
    for (const family of ['cotton-jersey', 'wool-knit', 'merino'] as const) {
      const f: FabricDef = { ...EXAMPLE_FABRICS[family], threadsPerCm: 40, tileCm: 10 };
      const t = generateFabricTextures(f, exampleVariant(family), 512, 1);
      expect(t.info.pxPerThread).toBeGreaterThanOrEqual(11.9);
    }
  });

  it('rangos extremos válidos del esquema no rompen (propiedad)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FABRIC_FAMILIES),
        fc.double({ min: 2, max: 80, noNaN: true }),
        fc.double({ min: 2, max: 60, noNaN: true }),
        fc.double({ min: 0.2, max: 8, noNaN: true }),
        fc.integer({ min: 0, max: 2 ** 31 }),
        (family, tpc, tile, thick, seed) => {
          const f: FabricDef = {
            ...EXAMPLE_FABRICS[family],
            threadsPerCm: tpc,
            tileCm: tile,
            thicknessMm: thick,
          };
          const t = generateFabricTextures(f, exampleVariant(family), 64 as 512, seed);
          expect(t.albedo.length).toBe(64 * 64 * 4);
          expect(t.info.pxPerThread).toBeGreaterThan(0);
        },
      ),
      { numRuns: 40, seed: 20260101 },
    );
  });
});

describe('patrones', () => {
  it('rayas: nº de franjas por tile = repeticiones enteras y escala efectiva documentada', () => {
    const f: FabricDef = { ...EXAMPLE_FABRICS['cotton-poplin'], tileCm: 6, threadsPerCm: 10 }; // tile 60 mm
    const variant: SwatchVariant = exampleVariant('cotton-poplin', {
      type: 'stripes',
      color2: '#ffffff',
      widthMm: 4,
      gapMm: 6,
      angleDeg: 90,
    }, '#101010');
    const size = 256 as 512;
    const t = generateFabricTextures(f, variant, size as 512, 3);
    const p = t.info.pattern!;
    expect(p.type).toBe('stripes');
    expect(p.repeats).toBe(6); // 60 mm / 10 mm
    expect(p.effectivePeriodMm).toBeCloseTo(10, 9);
    // cuenta de franjas claras a lo largo de una fila
    const row = 40;
    let rising = 0;
    let prev = t.albedo[(row * size) * 4]! > 128;
    for (let x = 1; x < size; x++) {
      const cur = t.albedo[(row * size + x) * 4]! > 128;
      if (cur && !prev) rising++;
      prev = cur;
    }
    // la que cruza el borde cuenta aparte
    const wrap = t.albedo[(row * size) * 4]! > 128 && t.albedo[(row * size + size - 1) * 4]! > 128;
    expect(rising + (wrap ? 0 : 0)).toBeGreaterThanOrEqual(5);
    expect(rising).toBeLessThanOrEqual(6);
  });

  it('el periodo se redondea al divisor entero más cercano y las proporciones se conservan', () => {
    const f = { ...EXAMPLE_FABRICS['cotton-poplin'], tileCm: 6 }; // 60 mm
    const mk = (pattern: SwatchVariant['pattern']) =>
      generateFabricTextures(f, exampleVariant('cotton-poplin', pattern), 128 as 512, 1).info.pattern!;
    const dots = mk({ type: 'dots', color2: '#ffffff', radiusMm: 2, spacingMm: 13 });
    expect(dots.repeats % 2).toBe(0); // half-drop exige nº par
    expect(dots.effectivePeriodMm * dots.repeats).toBeCloseTo(60, 9);
    const plaid = mk({ type: 'plaid', color2: '#ff0000', sizeMm: 25 });
    expect(plaid.repeats).toBe(2);
    expect(plaid.scale).toBeCloseTo(30 / 25, 9);
    const herr = mk({ type: 'herringbone', color2: '#ffffff', sizeMm: 7 });
    expect(herr.repeats).toBe(9);
    const flo = mk({ type: 'floral', color2: '#ff8080', scaleMm: 100 });
    expect(flo.repeats).toBe(1); // un periodo mayor que el tile → 1 repetición
  });

  it('rayas oblicuas usan una red entera: el ángulo efectivo se acerca al pedido', () => {
    for (const ang of [0, 20, 45, 60, 90, 135, 170]) {
      const fit = fitStripeLattice(100, 8, ang);
      expect(Number.isInteger(fit.a) && Number.isInteger(fit.b)).toBe(true);
      const diff = Math.min(
        Math.abs(fit.effectiveAngleDeg - ang),
        180 - Math.abs(fit.effectiveAngleDeg - ang),
      );
      expect(diff).toBeLessThan(8);
      expect(fit.effectivePeriodMm).toBeGreaterThan(5);
      expect(fit.effectivePeriodMm).toBeLessThan(12);
    }
  });

  it('cada patrón modifica el albedo respecto al sólido (misma semilla)', () => {
    const f = EXAMPLE_FABRICS['cotton-poplin'];
    const base = generateFabricTextures(f, exampleVariant('cotton-poplin'), 128 as 512, 5);
    for (let i = 1; i < EXAMPLE_PATTERNS.length; i++) {
      const t = generateFabricTextures(f, exampleVariant('cotton-poplin', EXAMPLE_PATTERNS[i]), 128 as 512, 5);
      expect(same(base.albedo, t.albedo)).toBe(false);
      expect(t.info.pattern).toBeDefined();
    }
    expect(base.info.pattern).toBeUndefined();
  });

  it('un patrón de color2 claro sobre base oscura sube la luminancia máxima', () => {
    const f = EXAMPLE_FABRICS['cotton-poplin'];
    const v = exampleVariant(
      'cotton-poplin',
      { type: 'dots', color2: '#ffffff', radiusMm: 3, spacingMm: 10 },
      '#202020',
    );
    const t = generateFabricTextures(f, v, 128 as 512, 1);
    let mx = 0;
    for (let i = 0; i < 128 * 128; i++) mx = Math.max(mx, t.albedo[i * 4]!);
    expect(mx).toBeGreaterThan(200);
  });
});

describe('validación de entradas', () => {
  it('tamaños no válidos y telas/muestras fuera de contrato → FabricInputError tipado', () => {
    const f = EXAMPLE_FABRICS.denim;
    const v = exampleVariant('denim');
    for (const bad of [0, 15, 100, 513, 8192, NaN, 1.5]) {
      expect(() => generateFabricTextures(f, v, bad as 512)).toThrow(FabricInputError);
    }
    expect(() => generateFabricTextures({ ...f, threadsPerCm: 1 }, v, 64 as 512)).toThrow(FabricInputError);
    expect(() => generateFabricTextures(f, { ...v, color: 'rojo' }, 64 as 512)).toThrow(FabricInputError);
    try {
      generateFabricTextures({ ...f, tileCm: 999 }, v, 64 as 512);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FabricInputError);
      expect((e as FabricInputError).issues.join(' ')).toContain('tileCm');
    }
  });
});

describe('generateFabricTexturesAsync', () => {
  it('produce exactamente los mismos bytes que la versión síncrona', async () => {
    for (const family of ['denim', 'wool-knit', 'leather'] as const) {
      const f = EXAMPLE_FABRICS[family];
      const v = exampleVariant(family, EXAMPLE_PATTERNS[2]);
      const a = generateFabricTextures(f, v, 128 as 512, 8);
      const b = await generateFabricTexturesAsync(f, v, 128 as 512, 8, { sliceMs: 0 });
      expect(same(a.albedo, b.albedo)).toBe(true);
      expect(same(a.normal, b.normal)).toBe(true);
      expect(same(a.orm, b.orm)).toBe(true);
    }
  });

  it('cede al event loop: otros temporizadores se ejecutan durante la generación y no hay bloqueos largos', async () => {
    const f = EXAMPLE_FABRICS['cotton-jersey'];
    const v = exampleVariant('cotton-jersey');
    let ticks = 0;
    let last = performance.now();
    let maxGap = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      ticks++;
    }, 1);
    last = performance.now();
    const t = await generateFabricTexturesAsync(f, v, 512, 3, { sliceMs: 4 });
    clearInterval(timer);
    expect(t.size).toBe(512);
    expect(ticks).toBeGreaterThan(5);
    expect(maxGap).toBeLessThan(250); // holgado: un paso entero dura pocos ms
  });

  it('respeta AbortSignal', async () => {
    const ctrl = new AbortController();
    const p = generateFabricTexturesAsync(
      EXAMPLE_FABRICS.linen,
      exampleVariant('linen'),
      256 as 512,
      1,
      { signal: ctrl.signal, sliceMs: 0 },
    );
    ctrl.abort();
    await expect(p).rejects.toThrow();
  });
});

describe('utilidades de ajuste de periodos', () => {
  it('fitPeriod: divisor entero ≥ 1, periodo efectivo × repeticiones = tile', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 10, max: 600, noNaN: true }),
        fc.double({ min: 0.5, max: 200, noNaN: true }),
        fc.constantFrom(1, 2),
        (tile, period, mult) => {
          const r = fitPeriod(tile, period, mult);
          expect(Number.isInteger(r.repeats)).toBe(true);
          expect(r.repeats % mult).toBe(0);
          expect(r.repeats).toBeGreaterThanOrEqual(mult);
          expect(r.effectiveMm * r.repeats).toBeCloseTo(tile, 6);
        },
      ),
      { numRuns: 100, seed: 5 },
    );
    expect(fitPeriod(60, NaN).repeats).toBe(1);
    expect(fitPeriod(60, -5).repeats).toBe(1);
  });

  it('roundToUnit respeta el rango y la unidad', () => {
    expect(roundToUnit(50, 4, 128)).toBe(52);
    expect(roundToUnit(500, 4, 128)).toBe(128);
    expect(roundToUnit(1, 12, 128)).toBe(12);
    expect(roundToUnit(1, 12, 5)).toBe(12);
  });

  it('shiftHueLinear devuelve colores finitos', () => {
    for (const hex of ['#000000', '#ffffff', '#808080', '#ff0000']) {
      const c = shiftHueLinear(hexToLinear(hex), 90);
      for (const v of c) expect(Number.isFinite(v)).toBe(true);
    }
    expect(hexToLinear('nope')).toEqual([0.2, 0.2, 0.2]);
  });
});
