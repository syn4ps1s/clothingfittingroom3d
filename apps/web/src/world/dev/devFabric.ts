import type { FabricDef, FabricTextureSet, PatternSpec, SwatchVariant } from '@fitroom/shared';

/**
 * Texturas PBR procedurales de DESARROLLO (sustituidas por `generateFabricTextures` de @fitroom/garments
 * cuando FABRIC esté READY). Puras y deterministas: RGBA8 tileable con tejido, patrón de la muestra,
 * normal map derivado del relieve y ORM.
 */
export function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Color del patrón (0 = base, 1 = color2, 2 = color3) en coordenadas físicas (mm) dentro de la repetición. */
function patternIndex(p: PatternSpec, xMm: number, yMm: number): number {
  switch (p.type) {
    case 'solid':
      return 0;
    case 'stripes': {
      const a = (p.angleDeg * Math.PI) / 180;
      const u = xMm * Math.cos(a) + yMm * Math.sin(a);
      const period = p.widthMm + p.gapMm;
      return ((u % period) + period) % period < p.widthMm ? 1 : 0;
    }
    case 'plaid': {
      const s = p.sizeMm;
      const bx = ((xMm % s) + s) % s < s * 0.22;
      const by = ((yMm % s) + s) % s < s * 0.22;
      if (bx && by) return p.color3 ? 2 : 1;
      return bx || by ? 1 : 0;
    }
    case 'dots': {
      const s = p.spacingMm;
      const cx = (Math.floor(xMm / s) + 0.5) * s;
      const cy = (Math.floor(yMm / s) + 0.5) * s;
      return Math.hypot(xMm - cx, yMm - cy) < p.radiusMm ? 1 : 0;
    }
    case 'herringbone': {
      const s = p.sizeMm;
      const col = Math.floor(xMm / s);
      const v = (((yMm + (col % 2 === 0 ? xMm : -xMm)) % (s * 2)) + s * 2) % (s * 2);
      return v < s ? 1 : 0;
    }
    case 'floral': {
      const s = p.scaleMm;
      const cx = (Math.floor(xMm / s) + 0.5) * s;
      const cy = (Math.floor(yMm / s) + 0.5) * s;
      const dx = xMm - cx;
      const dy = yMm - cy;
      const r = Math.hypot(dx, dy);
      const petals = 0.22 * s * (0.65 + 0.35 * Math.cos(5 * Math.atan2(dy, dx)));
      if (r < 0.06 * s && p.color3) return 2;
      return r < petals ? 1 : 0;
    }
  }
}

export function generateDevFabricTextures(
  fabric: FabricDef,
  variant: SwatchVariant,
  size: number,
  seed = 7,
): FabricTextureSet {
  const albedo = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const orm = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  const base = hexToRgb(variant.color);
  const p = variant.pattern;
  const c2 = p.type === 'solid' ? base : hexToRgb(p.color2);
  const c3 = 'color3' in p && p.color3 ? hexToRgb(p.color3) : c2;
  const palette = [base, c2, c3];
  // Hilos por repetición: limitado para que el tejido se vea con esta resolución.
  const threads = Math.max(8, Math.min(size / 3, Math.round(fabric.threadsPerCm * fabric.tileCm * 0.25)));
  const tileMm = fabric.tileCm * 10;
  const twill = fabric.family === 'denim' || fabric.family === 'twill';

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const fx = (x / size) * threads;
      const fy = (y / size) * threads;
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const wx = Math.sin(Math.PI * (fx - ix));
      const wy = Math.sin(Math.PI * (fy - iy));
      const over = twill ? (ix + iy) % 3 !== 0 : (ix + iy) % 2 === 0;
      const h = over ? 0.55 + 0.45 * wx : 0.55 + 0.45 * wy;
      const n = hash(x, y, seed) - 0.5;
      height[i] = h + n * 0.08;

      const col = palette[patternIndex(p, (x / size) * tileMm, (y / size) * tileMm)]!;
      const shade = 0.8 + 0.2 * h + n * 0.05;
      albedo[i * 4] = Math.min(255, col[0] * shade);
      albedo[i * 4 + 1] = Math.min(255, col[1] * shade);
      albedo[i * 4 + 2] = Math.min(255, col[2] * shade);
      albedo[i * 4 + 3] = 255;

      orm[i * 4] = 255 * (0.55 + 0.45 * h);
      orm[i * 4 + 1] = Math.min(255, 255 * fabric.roughness * (0.95 + n * 0.1));
      orm[i * 4 + 2] = 0;
      orm[i * 4 + 3] = 255;
    }
  }

  const strength = 2.2 + fabric.thicknessMm * 0.3;
  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)]!;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      normal[i] = 127.5 + (-dx / len) * 127.5;
      normal[i + 1] = 127.5 + (dy / len) * 127.5; // convención OpenGL (+Y arriba, V invertida)
      normal[i + 2] = 127.5 + (1 / len) * 127.5;
      normal[i + 3] = 255;
    }
  }

  return { size, albedo, normal, orm, tileMeters: fabric.tileCm / 100 };
}
