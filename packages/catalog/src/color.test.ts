import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { SwatchVariant } from '@fitroom/shared';
import {
  classifyHarmony,
  colorfulness,
  hexToOklch,
  hueDistance,
  hueHarmony,
  pairHarmony,
  paletteOf,
  variantHarmony,
} from './index.js';
import { FC } from './test-helpers.js';

const hex = fc
  .tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }))
  .map(([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`);

const H = (h: string) => hexToOklch(h);

describe('hexToOklch', () => {
  it('reproduce valores conocidos de OKLCH', () => {
    const white = H('#ffffff');
    expect(white.l).toBeCloseTo(1, 3);
    expect(white.c).toBeLessThan(0.002);
    expect(H('#000000').l).toBeCloseTo(0, 3);
    const red = H('#ff0000');
    expect(red.l).toBeCloseTo(0.628, 2);
    expect(red.c).toBeCloseTo(0.2577, 2);
    expect(red.h).toBeCloseTo(29.2, 0);
    expect(H('#0000ff').h).toBeCloseTo(264.05, 0);
    expect(H('#00ff00').h).toBeCloseTo(142.5, 0);
  });

  it('rechaza formatos inválidos', () => {
    for (const bad of ['red', '#fff', '#12345g', '', '#1234567', 'rgb(0,0,0)']) {
      expect(() => hexToOklch(bad)).toThrow(RangeError);
    }
  });

  it('propiedad: L en [0,1], C ≥ 0, h en [0,360) y todo finito', () => {
    fc.assert(
      fc.property(hex, (c) => {
        const o = hexToOklch(c);
        expect(Number.isFinite(o.l + o.c + o.h)).toBe(true);
        expect(o.l).toBeGreaterThanOrEqual(-1e-6);
        expect(o.l).toBeLessThanOrEqual(1 + 1e-6);
        expect(o.c).toBeGreaterThanOrEqual(0);
        expect(o.h).toBeGreaterThanOrEqual(0);
        expect(o.h).toBeLessThan(360);
      }),
      FC,
    );
  });
});

describe('hueDistance', () => {
  it('es simétrica, acotada a 0..180 y circular', () => {
    expect(hueDistance(350, 10)).toBe(20);
    expect(hueDistance(0, 180)).toBe(180);
    expect(hueDistance(90, 90)).toBe(0);
    fc.assert(
      fc.property(fc.double({ min: 0, max: 360, noNaN: true }), fc.double({ min: 0, max: 360, noNaN: true }), (a, b) => {
        const d = hueDistance(a, b);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(180);
        expect(d).toBeCloseTo(hueDistance(b, a), 9);
      }),
      FC,
    );
  });
});

describe('armonía de color', () => {
  it('hueHarmony: análogos y complementarios puntúan alto; los intermedios chocan', () => {
    expect(hueHarmony(0)).toBeGreaterThan(0.9);
    expect(hueHarmony(180)).toBeGreaterThan(0.8);
    expect(hueHarmony(120)).toBeGreaterThan(0.55);
    expect(hueHarmony(75)).toBeLessThan(0.4);
    expect(hueHarmony(60)).toBeLessThan(0.5);
    expect(hueHarmony(0)).toBeGreaterThan(hueHarmony(180));
    expect(hueHarmony(180)).toBeGreaterThan(hueHarmony(120));
  });

  it('pairHarmony: neutros combinan con todo; naranja con rosa choca', () => {
    const navy = H('#22304a');
    const ecru = H('#ede6d6');
    const camel = H('#b38a5b');
    const ink = H('#1c1d21');
    const orange = H('#ff6a00');
    const pink = H('#e91e8c');
    expect(pairHarmony(navy, ecru)).toBeGreaterThan(0.85);
    expect(pairHarmony(navy, camel)).toBeGreaterThan(0.8);
    expect(pairHarmony(ink, orange)).toBeGreaterThan(0.8);
    expect(pairHarmony(orange, pink)).toBeLessThan(0.45);
    // análogo > choque
    expect(pairHarmony(H('#9c4a2b'), H('#6b2737'))).toBeGreaterThan(pairHarmony(orange, pink));
  });

  it('pairHarmony: simétrica, acotada en [0,1] y sin NaN', () => {
    fc.assert(
      fc.property(hex, hex, (a, b) => {
        const x = pairHarmony(H(a), H(b));
        expect(Number.isFinite(x)).toBe(true);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(1);
        expect(x).toBeCloseTo(pairHarmony(H(b), H(a)), 9);
      }),
      FC,
    );
  });

  it('colorfulness separa neutros de cromáticos', () => {
    expect(colorfulness(H('#ffffff'))).toBe(0);
    expect(colorfulness(H('#1c1d21'))).toBe(0);
    expect(colorfulness(H('#b4624a'))).toBeGreaterThan(0.9);
  });

  it('paletteOf pondera el color base y los del estampado; variantHarmony es simétrica', () => {
    const solid: SwatchVariant = { id: 'a', name: { es: 'a', en: 'a' }, color: '#22304a', pattern: { type: 'solid' } };
    const floral: SwatchVariant = {
      id: 'b',
      name: { es: 'b', en: 'b' },
      color: '#ede6d6',
      pattern: { type: 'floral', color2: '#b4624a', color3: '#6a7f5a', scaleMm: 50 },
    };
    expect(paletteOf(solid)).toHaveLength(1);
    const pf = paletteOf(floral);
    expect(pf.map((p) => p.weight)).toEqual([1, 0.4, 0.2]);
    expect(variantHarmony(paletteOf(solid), pf)).toBeCloseTo(variantHarmony(pf, paletteOf(solid)), 9);
    expect(variantHarmony([], pf)).toBe(0);
  });

  it('classifyHarmony distingue neutro, acento, monocromo, análogo, complementario, triádico y choque', () => {
    const c = (h: string) => H(h);
    expect(classifyHarmony([c('#1c1d21'), c('#f4f1ea')])).toBe('neutral');
    expect(classifyHarmony([c('#f4f1ea'), c('#b4624a'), c('#22304a')])).toBe('accent');
    expect(classifyHarmony([c('#9c4a2b'), c('#b4624a')])).toBe('monochrome');
    expect(classifyHarmony([c('#b4624a'), c('#b38a5b')])).toBe('analogous');
    expect(classifyHarmony([c('#e0603a'), c('#1fa9a0')])).toBe('complementary');
    expect(classifyHarmony([c('#e0603a'), c('#3aa14a'), c('#4a5be0')])).toBe('triadic');
    expect(classifyHarmony([c('#ff6a00'), c('#e91e8c')])).toBe('clash');
  });
});
