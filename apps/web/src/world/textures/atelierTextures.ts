import {
  CanvasTexture,
  ClampToEdgeWrapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
  NoColorSpace,
} from 'three';
import { fbm, makeValueNoise, mulberry32 } from './rng';
import { herringbonePlanks } from './herringbone';

/**
 * Materiales PBR PROCEDURALES del atelier (sin descargas): roble en espiga, yeso, madera lisa, alfombra, cielo.
 * Se generan con semilla fija (deterministas) y en el tamaño que pida la calidad gráfica.
 */
export interface PbrTextures {
  readonly map: CanvasTexture;
  readonly normalMap: CanvasTexture;
  readonly roughnessMap: CanvasTexture;
}

function canvasOf(size: number, h = size): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D no disponible');
  return { c, ctx };
}

function toTexture(c: HTMLCanvasElement, srgb: boolean, repeat = true): CanvasTexture {
  const t = new CanvasTexture(c);
  t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  t.wrapS = t.wrapT = repeat ? RepeatWrapping : ClampToEdgeWrapping;
  t.anisotropy = 8;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.generateMipmaps = true;
  return t;
}

function imageToCanvas(data: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const { c, ctx } = canvasOf(w, h);
  const img = ctx.createImageData(w, h);
  img.data.set(data);
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Mapa de normales (convención OpenGL, +Y arriba) desde un mapa de alturas periódico. */
function heightToNormal(height: Float32Array, size: number, strength: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)]!;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      out[i] = 127.5 - (dx / len) * 127.5;
      out[i + 1] = 127.5 + (dy / len) * 127.5;
      out[i + 2] = 127.5 + (1 / len) * 127.5;
      out[i + 3] = 255;
    }
  }
  return out;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export interface OakOptions {
  readonly size: number;
  /** Largo de tablilla en anchos (espiga clásica: 5–7). */
  readonly L?: number;
  readonly seed?: number;
}

/** Parquet de roble en espiga. La baldosa mide 2L celdas de lado y es tileable. */
export function makeHerringboneOak({ size, L = 7, seed = 11 }: OakOptions): PbrTextures {
  const n = 2 * L;
  const cell = size / n;
  const rand = mulberry32(seed);
  const planks = herringbonePlanks(L);
  // celda → índice de tablilla (con envolvente)
  const owner = new Int16Array(n * n).fill(-1);
  const wrap = (v: number) => ((v % n) + n) % n;
  planks.forEach((p, i) => {
    for (let dx = 0; dx < p.w; dx++) for (let dy = 0; dy < p.h; dy++) owner[wrap(p.y + dy) * n + wrap(p.x + dx)] = i;
  });
  const tone = planks.map(() => ({
    l: 0.9 + rand() * 0.26,
    h: (rand() - 0.5) * 0.05,
    seed: rand() * 100,
    flip: rand() > 0.5,
  }));
  const noise = makeValueNoise(32, seed + 5);
  const grainNoise = makeValueNoise(64, seed + 9);

  const albedo = new Uint8ClampedArray(size * size * 4);
  const rough = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const cx = px / cell;
      const cy = py / cell;
      const idx = owner[Math.min(n - 1, Math.floor(cy)) * n + Math.min(n - 1, Math.floor(cx))]!;
      const p = planks[idx]!;
      const t = tone[idx]!;
      const lx = wrap(cx - p.x);
      const ly = wrap(cy - p.y);
      const along = p.horizontal ? lx : ly; // 0..L
      const across = p.horizontal ? ly : lx; // 0..1
      const eU = Math.min(along, p.horizontal ? p.w - along : p.h - along);
      const eV = Math.min(across, 1 - across);
      const d = Math.min(eU, eV);

      // veta: bandas finas a lo largo, distorsionadas por ruido de baja frecuencia
      const warp = fbm(grainNoise, along / L + t.seed, across * 0.3 + t.seed, 3, 3) * 2.6;
      const grain = 0.5 + 0.5 * Math.sin((across * 34 + warp * 6) * Math.PI);
      const fine = fbm(noise, along * 0.6 + t.seed, across * 6, 2, 3);
      const lum = t.l * (0.82 + 0.1 * grain + 0.1 * fine);
      // oro-miel del roble: tono cálido
      let r = 0.62 * lum + 0.04;
      let g = 0.43 * lum + 0.02;
      let b = 0.25 * lum + 0.01;
      r *= 1 + t.h;
      b *= 1 - t.h;

      let hgt = 0.72 + 0.03 * grain + (t.flip ? 0.01 : 0);
      let rg = 0.5 + 0.12 * (1 - grain) + 0.05 * fine;
      if (d < 0.014) {
        r *= 0.22; g *= 0.22; b *= 0.22; hgt = 0; rg = 1;
      } else if (d < 0.05) {
        const k = (d - 0.014) / 0.036;
        hgt *= 0.5 + 0.5 * k;
        const shade = 0.62 + 0.38 * k;
        r *= shade; g *= shade; b *= shade;
      }
      const i = py * size + px;
      albedo[i * 4] = 255 * clamp01(r);
      albedo[i * 4 + 1] = 255 * clamp01(g);
      albedo[i * 4 + 2] = 255 * clamp01(b);
      albedo[i * 4 + 3] = 255;
      const rv = 255 * clamp01(rg);
      rough[i * 4] = rv;
      rough[i * 4 + 1] = rv;
      rough[i * 4 + 2] = rv;
      rough[i * 4 + 3] = 255;
      height[i] = hgt;
    }
  }
  return {
    map: toTexture(imageToCanvas(albedo, size, size), true),
    normalMap: toTexture(imageToCanvas(heightToNormal(height, size, 5), size, size), false),
    roughnessMap: toTexture(imageToCanvas(rough, size, size), false),
  };
}

/** Yeso cálido a la cal: moteado suave de baja frecuencia y micro-relieve. */
export function makePlaster(size = 512, seed = 3): PbrTextures {
  const noiseA = makeValueNoise(8, seed);
  const noiseB = makeValueNoise(32, seed + 1);
  const albedo = new Uint8ClampedArray(size * size * 4);
  const rough = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const low = fbm(noiseA, u, v, 2, 4);
      const hi = fbm(noiseB, u, v, 4, 4);
      const k = 0.9 + 0.2 * low + 0.05 * (hi - 0.5);
      const i = y * size + x;
      albedo[i * 4] = 255 * clamp01(0.86 * k);
      albedo[i * 4 + 1] = 255 * clamp01(0.77 * k);
      albedo[i * 4 + 2] = 255 * clamp01(0.62 * k);
      albedo[i * 4 + 3] = 255;
      const rv = 255 * clamp01(0.85 + 0.1 * hi);
      rough[i * 4] = rough[i * 4 + 1] = rough[i * 4 + 2] = rv;
      rough[i * 4 + 3] = 255;
      height[i] = low * 0.6 + hi * 0.4;
    }
  }
  return {
    map: toTexture(imageToCanvas(albedo, size, size), true),
    normalMap: toTexture(imageToCanvas(heightToNormal(height, size, 1.6), size, size), false),
    roughnessMap: toTexture(imageToCanvas(rough, size, size), false),
  };
}

/** Tablones lisos de roble oscuro con la veta a lo largo del eje U (mesa, postes, marcos). */
export function makeOakBoards(size = 512, seed = 21, boards = 4): PbrTextures {
  const rand = mulberry32(seed);
  const grainNoise = makeValueNoise(64, seed);
  const fineNoise = makeValueNoise(16, seed + 2);
  const albedo = new Uint8ClampedArray(size * size * 4);
  const rough = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);
  const tones = Array.from({ length: boards }, () => ({ l: 0.82 + rand() * 0.28, s: rand() * 50 }));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const b = Math.min(boards - 1, Math.floor((y / size) * boards));
      const t = tones[b]!;
      const lv = (y / size) * boards - b;
      const warp = fbm(grainNoise, x / size + t.s, lv * 0.4 + t.s, 2, 3) * 2.2;
      const grain = 0.5 + 0.5 * Math.sin((lv * 28 + warp * 7) * Math.PI);
      const fine = fbm(fineNoise, x / size * 3 + t.s, lv * 8, 3, 3);
      const lum = t.l * (0.8 + 0.12 * grain + 0.12 * fine);
      const edge = Math.min(lv, 1 - lv);
      const gap = edge < 0.012 ? 0.3 : 1;
      const i = y * size + x;
      albedo[i * 4] = 255 * clamp01(0.5 * lum * gap);
      albedo[i * 4 + 1] = 255 * clamp01(0.34 * lum * gap);
      albedo[i * 4 + 2] = 255 * clamp01(0.2 * lum * gap);
      albedo[i * 4 + 3] = 255;
      const rv = 255 * clamp01(edge < 0.012 ? 1 : 0.46 + 0.14 * (1 - grain));
      rough[i * 4] = rough[i * 4 + 1] = rough[i * 4 + 2] = rv;
      rough[i * 4 + 3] = 255;
      height[i] = edge < 0.012 ? 0 : 0.7 + 0.04 * grain;
    }
  }
  return {
    map: toTexture(imageToCanvas(albedo, size, size), true),
    normalMap: toTexture(imageToCanvas(heightToNormal(height, size, 3), size, size), false),
    roughnessMap: toTexture(imageToCanvas(rough, size, size), false),
  };
}

/** Alfombra de taller: borde, cenefa y rombos en tonos burdeos, índigo y crema. */
export function makeRug(size = 512): CanvasTexture {
  const w = size;
  const h = Math.round(size * 0.68);
  const { c, ctx } = canvasOf(w, h);
  ctx.fillStyle = '#6b2a2a';
  ctx.fillRect(0, 0, w, h);
  const rand = mulberry32(5);
  // grano del tejido
  for (let i = 0; i < w * h * 0.02; i++) {
    ctx.fillStyle = `rgba(${rand() > 0.5 ? '255,235,200' : '30,10,10'},${0.04 + rand() * 0.06})`;
    ctx.fillRect(rand() * w, rand() * h, 2, 1);
  }
  const frame = (inset: number, color: string, line: number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = line;
    ctx.strokeRect(inset, inset, w - inset * 2, h - inset * 2);
  };
  frame(w * 0.03, '#e8d9b3', w * 0.012);
  frame(w * 0.06, '#24325a', w * 0.05);
  frame(w * 0.105, '#e8d9b3', w * 0.008);
  // cenefa de rombos en el borde azul
  ctx.fillStyle = '#c9a85c';
  const step = w * 0.052;
  for (let x = w * 0.075; x < w - w * 0.06; x += step) {
    for (const y of [w * 0.061, h - w * 0.061]) {
      ctx.beginPath();
      ctx.moveTo(x, y - w * 0.014);
      ctx.lineTo(x + w * 0.014, y);
      ctx.lineTo(x, y + w * 0.014);
      ctx.lineTo(x - w * 0.014, y);
      ctx.fill();
    }
  }
  // medallón central
  const cx = w / 2;
  const cy = h / 2;
  for (const [rw, rh, col] of [
    [0.3, 0.3, '#24325a'],
    [0.255, 0.255, '#e8d9b3'],
    [0.22, 0.22, '#7e2f33'],
  ] as const) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(cx - w * rw, cy);
    ctx.lineTo(cx, cy - h * rh * 1.35);
    ctx.lineTo(cx + w * rw, cy);
    ctx.lineTo(cx, cy + h * rh * 1.35);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = '#c9a85c';
  ctx.beginPath();
  ctx.arc(cx, cy, h * 0.07, 0, Math.PI * 2);
  ctx.fill();
  const t = toTexture(c, true, false);
  return t;
}

/** Cielo de atardecer visto por el ventanal: del índigo al oro, con el sol bajo y nubes alargadas. */
export function makeSunsetSky(): CanvasTexture {
  const w = 512;
  const h = 512;
  const { c, ctx } = canvasOf(w, h);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#2d2a55');
  g.addColorStop(0.35, '#7a4a6e');
  g.addColorStop(0.62, '#e0824a');
  g.addColorStop(0.82, '#ffc275');
  g.addColorStop(1, '#ffe2a8');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const sun = ctx.createRadialGradient(w * 0.45, h * 0.84, 0, w * 0.45, h * 0.84, h * 0.45);
  sun.addColorStop(0, 'rgba(255,250,225,1)');
  sun.addColorStop(0.12, 'rgba(255,236,170,0.9)');
  sun.addColorStop(1, 'rgba(255,190,110,0)');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, w, h);
  const rand = mulberry32(8);
  for (let i = 0; i < 14; i++) {
    const y = h * (0.35 + rand() * 0.45);
    const x = rand() * w;
    const cw = w * (0.25 + rand() * 0.4);
    const grad = ctx.createLinearGradient(x, 0, x + cw, 0);
    grad.addColorStop(0, 'rgba(255,170,120,0)');
    grad.addColorStop(0.5, `rgba(${200 + rand() * 50},${110 + rand() * 50},110,${0.25 + rand() * 0.25})`);
    grad.addColorStop(1, 'rgba(255,170,120,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, cw, 6 + rand() * 12);
  }
  // siluetas lejanas de tejados
  ctx.fillStyle = '#3a2a35';
  ctx.beginPath();
  ctx.moveTo(0, h);
  let x = 0;
  while (x < w) {
    const bw = 24 + rand() * 50;
    const bh = h * (0.9 + rand() * 0.06);
    ctx.lineTo(x, bh);
    ctx.lineTo(x + bw, bh);
    x += bw;
  }
  ctx.lineTo(w, h);
  ctx.fill();
  return toTexture(c, true, false);
}

/** Lámina enmarcada: patrón de sastrería (corpiño y manga) dibujado a línea sobre papel. */
export function makePatternArt(): CanvasTexture {
  const w = 480;
  const h = 600;
  const { c, ctx } = canvasOf(w, h);
  ctx.fillStyle = '#efe4cb';
  ctx.fillRect(0, 0, w, h);
  const rand = mulberry32(2);
  for (let i = 0; i < 1800; i++) {
    ctx.fillStyle = `rgba(120,90,50,${rand() * 0.05})`;
    ctx.fillRect(rand() * w, rand() * h, 1.5, 1.5);
  }
  ctx.strokeStyle = '#4b3524';
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  // corpiño
  ctx.beginPath();
  ctx.moveTo(150, 90);
  ctx.bezierCurveTo(190, 120, 250, 120, 290, 90);
  ctx.lineTo(340, 150);
  ctx.bezierCurveTo(320, 230, 330, 300, 360, 400);
  ctx.lineTo(120, 400);
  ctx.bezierCurveTo(150, 300, 160, 230, 100, 150);
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(220, 100);
  ctx.lineTo(220, 400);
  ctx.moveTo(110, 250);
  ctx.lineTo(350, 250);
  ctx.stroke();
  ctx.setLineDash([]);
  // manga
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(130, 450);
  ctx.bezierCurveTo(180, 410, 280, 410, 330, 450);
  ctx.lineTo(310, 540);
  ctx.lineTo(150, 540);
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = '#4b3524';
  ctx.font = '600 15px serif';
  ctx.fillText('N.º 14 · CORPIÑO', 150, 60);
  ctx.font = 'italic 13px serif';
  ctx.fillText('t. 38 · 1:4', 360, 570);
  for (const [x, y] of [[220, 100], [220, 250], [220, 400], [110, 250], [350, 250]] as const) {
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  return toTexture(c, true, false);
}

/** Tapete de corte autocurable: verde oliva con cuadrícula y marcas. */
export function makeCuttingMat(): CanvasTexture {
  const w = 512;
  const h = 320;
  const { c, ctx } = canvasOf(w, h);
  ctx.fillStyle = '#3f5030';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(235,240,210,0.55)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= w; x += 16) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.globalAlpha = x % 64 === 0 ? 0.9 : 0.35;
    ctx.stroke();
  }
  for (let y = 0; y <= h; y += 16) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
    ctx.globalAlpha = y % 64 === 0 ? 0.9 : 0.35;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return toTexture(c, true, false);
}

/** Destello diagonal para el cristal del espejo cuando está apagado. */
export function makeMirrorSheen(): CanvasTexture {
  const w = 256;
  const h = 512;
  const { c, ctx } = canvasOf(w, h);
  ctx.clearRect(0, 0, w, h);
  const g = ctx.createLinearGradient(0, h, w, 0);
  g.addColorStop(0, 'rgba(255,214,150,0)');
  g.addColorStop(0.35, 'rgba(255,224,170,0.00)');
  g.addColorStop(0.46, 'rgba(255,232,190,0.22)');
  g.addColorStop(0.5, 'rgba(255,240,205,0.34)');
  g.addColorStop(0.54, 'rgba(255,232,190,0.12)');
  g.addColorStop(1, 'rgba(255,214,150,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const g2 = ctx.createLinearGradient(0, 0, w, h);
  g2.addColorStop(0, 'rgba(255,255,255,0.0)');
  g2.addColorStop(0.2, 'rgba(255,240,215,0.10)');
  g2.addColorStop(0.28, 'rgba(255,240,215,0.0)');
  ctx.fillStyle = g2;
  ctx.fillRect(0, 0, w, h);
  return toTexture(c, true, false);
}

/** Textura de «estela» suave para las motas de polvo y halos. */
export function makeSoftDot(): CanvasTexture {
  const { c, ctx } = canvasOf(64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,240,200,1)');
  g.addColorStop(0.35, 'rgba(255,220,160,0.5)');
  g.addColorStop(1, 'rgba(255,200,130,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return toTexture(c, true, false);
}

const shared = new Map<string, PbrTextures>();

/** Tablones de roble COMPARTIDOS (mesa, postes, vigas): una sola generación por tamaño; no se liberan nunca. */
export function getOakBoards(size: number, seed = 21, boards = 4): PbrTextures {
  const key = `${size}|${seed}|${boards}`;
  let set = shared.get(key);
  if (!set) {
    set = makeOakBoards(size, seed, boards);
    shared.set(key, set);
  }
  return set;
}
