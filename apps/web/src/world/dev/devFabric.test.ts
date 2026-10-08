import { describe, expect, it } from 'vitest';
import { DEV_CATALOG } from './fixtures';
import { generateDevFabricTextures, hexToRgb } from './devFabric';

describe('texturas de tela de desarrollo', () => {
  const fabric = DEV_CATALOG.fabrics[0]!;
  const variants = DEV_CATALOG.garments.flatMap((g) => g.variants);

  it('son deterministas y del tamaño pedido', () => {
    const v = variants[0]!;
    const a = generateDevFabricTextures(fabric, v, 64, 3);
    const b = generateDevFabricTextures(fabric, v, 64, 3);
    expect(a.albedo).toEqual(b.albedo);
    expect(a.albedo.length).toBe(64 * 64 * 4);
    expect(a.normal.length).toBe(64 * 64 * 4);
    expect(a.orm.length).toBe(64 * 64 * 4);
    expect(a.tileMeters).toBeCloseTo(fabric.tileCm / 100);
  });

  it('el albedo respeta el color de la muestra (±sombreado del tejido)', () => {
    const v = variants.find((x) => x.pattern.type === 'solid')!;
    const t = generateDevFabricTextures(fabric, v, 32);
    const [r, g, b] = hexToRgb(v.color);
    let sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < t.albedo.length; i += 4) {
      sr += t.albedo[i]!;
      sg += t.albedo[i + 1]!;
      sb += t.albedo[i + 2]!;
    }
    const n = t.albedo.length / 4;
    expect(Math.abs(sr / n - r * 0.9)).toBeLessThan(r * 0.2 + 5);
    expect(Math.abs(sg / n - g * 0.9)).toBeLessThan(g * 0.2 + 5);
    expect(Math.abs(sb / n - b * 0.9)).toBeLessThan(b * 0.2 + 5);
  });

  it('la normal es unitaria y apunta hacia fuera; no hay NaN para ningún patrón', () => {
    for (const v of variants) {
      const t = generateDevFabricTextures(fabric, v, 32);
      for (let i = 0; i < t.normal.length; i += 4) {
        const nx = (t.normal[i]! / 255) * 2 - 1;
        const ny = (t.normal[i + 1]! / 255) * 2 - 1;
        const nz = (t.normal[i + 2]! / 255) * 2 - 1;
        expect(nz).toBeGreaterThan(0);
        expect(Math.hypot(nx, ny, nz)).toBeGreaterThan(0.9);
        expect(Math.hypot(nx, ny, nz)).toBeLessThan(1.1);
      }
    }
  });

  it('los patrones se distinguen del liso', () => {
    const striped = variants.find((v) => v.pattern.type === 'stripes')!;
    const t = generateDevFabricTextures(fabric, striped, 64);
    const values = new Set<number>();
    for (let i = 0; i < t.albedo.length; i += 4) values.add(Math.round(t.albedo[i]! / 32));
    expect(values.size).toBeGreaterThan(2);
  });
});
