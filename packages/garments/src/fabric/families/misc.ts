import { hash01, hashU32 } from '../prng.js';
import {
  LowResField,
  PeriodicFbm,
  PeriodicNoise2D,
  PeriodicValueNoise2D,
  sinTurns,
  smooth01,
} from '../noise.js';
import type { FamilyBuilder, FamilyContext } from '../types.js';
import { MIN_PX_PER_THREAD, fillRowNoise, resolveThreadGrid } from './grid.js';

/**
 * Familias no tejidas con estructura propia: crepé de seda (microarrugado), cuero (grano de poros),
 * pana (canutillos de pelo cortado) y felpa polar (pelo denso con fibras en una dirección).
 * Los campos de baja frecuencia se precalculan en `LowResField` (muestreo bilineal barato) para
 * mantener el coste por píxel bajo.
 */

// ---------------------------------------------------------------------------------------------
// Crepé de seda: superficie "guijarro" fina por torsión alta de los hilos
// ---------------------------------------------------------------------------------------------
export const buildSilkCrepe: FamilyBuilder = (ctx) => {
  const { size: S, seed, fields } = ctx;
  const { H, T, M, R } = fields;
  const g = resolveThreadGrid(ctx.fabric, S, 2, 2, MIN_PX_PER_THREAD);
  const threads = g.nu;
  // longitud de onda del arrugado ≈ 2 hilos
  const p1 = Math.max(10, Math.min(Math.floor(S / 8), Math.round(threads / 1.7)));
  const pw = Math.max(2, Math.round(p1 / 5));
  const wA = new PeriodicNoise2D(pw, hashU32(seed, 1));
  const wB = new PeriodicNoise2D(pw, hashU32(seed, 2));
  const warpU = new LowResField(96, (u, v) => wA.sample(u * pw, v * pw));
  const warpV = new LowResField(96, (u, v) => wB.sample(u * pw, v * pw));
  const nA = new PeriodicValueNoise2D(p1, p1, hashU32(seed, 3));
  const nB = new PeriodicValueNoise2D(p1 * 2, p1 * 2, hashU32(seed, 4));
  const nC = new PeriodicValueNoise2D(p1 * 4, p1 * 4, hashU32(seed, 5));
  const noiseRow = new Float32Array(S);
  const noiseSeed = hashU32(seed, 0xc4e9e);
  ctx.bands((y0, y1) => {
    for (let y = y0; y < y1; y++) {
      fillRowNoise(noiseRow, noiseSeed, y);
      const v = (y + 0.5) / S;
      for (let x = 0; x < S; x++) {
        const u = (x + 0.5) / S;
        // dominio deformado → red de pliegues orgánica (no alineada con los ejes)
        const wx = u * p1 + 0.9 * warpU.sample(u, v);
        const wy = v * p1 + 0.9 * warpV.sample(u, v);
        const a = nA.sample(wx, wy);
        const crease = 1 - Math.abs(a); // 1 en las crestas redondeadas, 0 en el pliegue
        const b = nB.sample(wx * 2 + 0.4, wy * 2 + 0.9);
        const c = nC.sample(wx * 4 + 0.2, wy * 4 + 0.5);
        const n = noiseRow[x]! - 0.5;
        let h = 0.36 + 0.14 * crease * crease + 0.26 * b + 0.15 * c + 0.012 * n;
        h = h < 0 ? 0 : h > 1.1 ? 1.1 : h;
        const i = y * S + x;
        H[i] = h;
        T[i] = (0.94 + 0.12 * h) * (1 + 0.02 * n);
        M[i] = 0;
        R[i] = 0.05 - 0.14 * h; // crestas más brillantes
      }
    }
  });
  return {
    bumpUnitPx: S / p1 / 1.6,
    normalStrength: 0.5,
    aoStrength: 0.4,
    aoRadiusPx: Math.max(2, Math.round(S / p1 / 3)),
    secondary: null,
    normalizeTone: true,
    metal: 0,
    grid: null,
    threadsAcrossTile: threads,
    threadsAlongTile: g.nv,
    pxPerThread: S / threads,
    weaveRepeat: { u: 1, v: 1 },
  };
};

// ---------------------------------------------------------------------------------------------
// Cuero: grano de poros (Voronoi) con pliegues entre "guijarros", poros y moteado de color
// ---------------------------------------------------------------------------------------------
export const buildLeather: FamilyBuilder = (ctx) => {
  const { size: S, seed, fields } = ctx;
  const { H, T, M, R } = fields;
  const requested = ctx.fabric.threadsPerCm * ctx.fabric.tileCm;
  const nc = Math.max(8, Math.min(Math.floor(S / 14), Math.round(requested * 1.25)));
  const E = nc + 2;
  // puntos característicos jitterizados con borde de envoltura de 1 celda (evita módulos por píxel)
  const pts = new Float32Array(E * E * 3); // x, y (0..1 en la celda), poro
  for (let ey = 0; ey < E; ey++) {
    for (let ex = 0; ex < E; ex++) {
      const cx = (ex - 1 + nc) % nc;
      const cy = (ey - 1 + nc) % nc;
      const o = (ey * E + ex) * 3;
      pts[o] = 0.5 + (hash01(seed, cx, cy, 41) - 0.5) * 0.9;
      pts[o + 1] = 0.5 + (hash01(seed, cx, cy, 42) - 0.5) * 0.9;
      pts[o + 2] = hash01(seed, cx, cy, 43);
    }
  }
  const pw = Math.max(3, Math.round(nc / 3));
  const nW1 = new PeriodicNoise2D(pw, hashU32(seed, 9));
  const nW2 = new PeriodicNoise2D(pw, hashU32(seed, 10));
  const warpU = new LowResField(128, (u, v) => nW1.sample(u * pw, v * pw));
  const warpV = new LowResField(128, (u, v) => nW2.sample(u * pw, v * pw));
  const fbm = new PeriodicFbm(3, 3, hashU32(seed, 11), 0.55);
  const mott = new LowResField(96, (u, v) => fbm.sample(u * 3, v * 3));
  const pu = Math.max(4, Math.round(nc * 1.3));
  const nU = new PeriodicNoise2D(pu, hashU32(seed, 12));
  const und = new LowResField(256, (u, v) => nU.sample(u * pu, v * pu));
  const noiseRow = new Float32Array(S);
  const noiseSeed = hashU32(seed, 0x1ea7);
  const cellTones = new Float32Array(nc * nc);
  for (let i = 0; i < nc * nc; i++) cellTones[i] = 1 + (hash01(seed, i, 0, 44) - 0.5) * 0.08;
  ctx.bands((y0, y1) => {
    for (let y = y0; y < y1; y++) {
      fillRowNoise(noiseRow, noiseSeed, y);
      const v0 = (y + 0.5) / S;
      for (let x = 0; x < S; x++) {
        const u0 = (x + 0.5) / S;
        // deformación de dominio para que los guijarros sean irregulares
        const u = u0 * nc + 0.34 * warpU.sample(u0, v0);
        const v = v0 * nc + 0.34 * warpV.sample(u0, v0);
        const cxf = Math.floor(u);
        const cyf = Math.floor(v);
        const wx0 = ((cxf % nc) + nc) % nc;
        const wy0 = ((cyf % nc) + nc) % nc;
        let f1 = 9;
        let f2 = 9;
        let w1x = 0;
        let w1y = 0;
        let pore = 0;
        let id = 0;
        for (let oy = -1; oy <= 1; oy++) {
          const rowO = (wy0 + 1 + oy) * E;
          const py = cyf + oy;
          for (let ox = -1; ox <= 1; ox++) {
            const o = (rowO + wx0 + 1 + ox) * 3;
            const ddx = u - (cxf + ox + pts[o]!);
            const ddy = v - (py + pts[o + 1]!);
            const d = ddx * ddx + ddy * ddy;
            if (d < f1) {
              f2 = f1;
              f1 = d;
              w1x = ddx;
              w1y = ddy;
              pore = pts[o + 2]!;
              id = ((wy0 + oy + nc) % nc) * nc + ((wx0 + ox + nc) % nc);
            } else if (d < f2) {
              f2 = d;
            }
          }
        }
        const d1 = Math.sqrt(f1);
        const e = Math.sqrt(f2) - d1; // 0 en el pliegue entre guijarros
        const dome = smooth01(0.0, 0.5, e);
        const bub = 1 - Math.min(1, (d1 * d1) / 0.55);
        let h = 0.16 + 0.3 * dome + 0.42 * bub;
        // poro: depresión pequeña en algunos guijarros
        if (pore > 0.55 && d1 < 0.6) {
          const qx = w1x - 0.15 * (pore - 0.75);
          const qy = w1y + 0.1 * (pore - 0.75);
          h -= 0.22 * Math.exp(-(qx * qx + qy * qy) / 0.004);
        }
        const n = noiseRow[x]! - 0.5;
        h += 0.07 * und.sample(u0, v0) + 0.02 * n;
        h = h < 0 ? 0 : h > 1.1 ? 1.1 : h;
        const m = mott.sample(u0, v0);
        const i = y * S + x;
        H[i] = h;
        T[i] = (0.88 + 0.16 * dome) * (1 + 0.15 * m) * cellTones[id]! * (1 + 0.025 * n);
        M[i] = 0;
        R[i] = 0.16 * (1 - dome) - 0.08 * dome * (0.5 + 0.5 * m) + 0.04 * n;
      }
    }
  });
  return {
    bumpUnitPx: S / nc,
    normalStrength: 0.7,
    aoStrength: 0.5,
    aoRadiusPx: Math.max(2, Math.round((S / nc) * 0.3)),
    secondary: null,
    normalizeTone: true,
    metal: 0,
    grid: null,
    threadsAcrossTile: nc,
    threadsAlongTile: nc,
    pxPerThread: S / nc,
    weaveRepeat: { u: 1, v: 1 },
  };
};

// ---------------------------------------------------------------------------------------------
// Pana: canutillos (wales) de pelo cortado con la trama base visible en los surcos
// ---------------------------------------------------------------------------------------------
export const buildCorduroy: FamilyBuilder = (ctx) => {
  const { size: S, seed, fields } = ctx;
  const { H, T, M, R } = fields;
  const requested = ctx.fabric.threadsPerCm * ctx.fabric.tileCm;
  // 1 canutillo ≈ 6 hilos; mínimo ~18 px por canutillo
  const nW = Math.max(3, Math.min(Math.floor(S / 18), Math.round(requested / 6)));
  const nGround = Math.max(nW * 4, Math.min(Math.floor(S / 8), Math.round(requested)));
  const tuftN = new PeriodicValueNoise2D(nW * 4, nW * 2, hashU32(seed, 62)); // mechones alargados a lo largo del canutillo
  const tuft = new LowResField(Math.min(512, S), (u, v) => tuftN.sample(u * nW * 4, v * nW * 2));
  const dN = new PeriodicNoise2D(Math.max(2, nW), hashU32(seed, 65));
  const fade = new LowResField(96, (u, v) => dN.sample(u * nW, v * nW));
  const wTone = new Float32Array(nW);
  const wH = new Float32Array(nW);
  for (let i = 0; i < nW; i++) {
    wTone[i] = 1 + (hash01(seed, i, 0, 64) - 0.5) * 0.08;
    wH[i] = 1 + (hash01(seed, i, 1, 64) - 0.5) * 0.1;
  }
  // tablas por columna: perfil del lomo, fibras paralelas al canutillo y trama base
  const colRidge = new Float32Array(S);
  const colI = new Int32Array(S);
  const colStreak = new Float32Array(S);
  const colGround = new Float32Array(S);
  const rowGround = new Float32Array(S);
  const rawStreak = new Float32Array(S);
  for (let x = 0; x < S; x++) rawStreak[x] = hash01(seed, x, 7, 66) - 0.5;
  for (let x = 0; x < S; x++) {
    const uc = (x / S) * nW;
    const i = Math.floor(uc);
    const fu = uc - i;
    colI[x] = i;
    const d = (fu - 0.5) / 0.46;
    colRidge[x] = d > -1 && d < 1 ? Math.pow(1 - d * d, 0.75) : 0;
    colStreak[x] = 0.5 * rawStreak[x]! + 0.25 * (rawStreak[(x + 1) % S]! + rawStreak[(x + S - 1) % S]!);
    colGround[x] = sinTurns((x / S) * nGround);
  }
  for (let y = 0; y < S; y++) rowGround[y] = sinTurns((y / S) * nGround);
  const noiseRow = new Float32Array(S);
  const noiseSeed = hashU32(seed, 0xc0d);
  ctx.bands((y0, y1) => {
    for (let y = y0; y < y1; y++) {
      fillRowNoise(noiseRow, noiseSeed, y);
      const v = (y + 0.5) / S;
      const rg = rowGround[y]!;
      for (let x = 0; x < S; x++) {
        const u = (x + 0.5) / S;
        const i = colI[x]!;
        const ridge = colRidge[x]!;
        const ground = 0.5 + 0.5 * colGround[x]! * rg; // trama base en el surco
        const tf = tuft.sample(u, v);
        const n = noiseRow[x]! - 0.5;
        const fd = fade.sample(u, v);
        let h = 0.08 + 0.06 * ground * (1 - ridge);
        h += ridge * (0.6 * wH[i]! + 0.1 * tf + 0.07 * n);
        h = h < 0 ? 0 : h > 1.1 ? 1.1 : h;
        const idx = y * S + x;
        H[idx] = h;
        // pelo cortado: más claro en el lomo, rayado de fibras paralelas al canutillo
        T[idx] =
          wTone[i]! *
          (0.56 + 0.5 * ridge) *
          (1 + 0.2 * colStreak[x]! + 0.12 * n + 0.08 * tf) *
          (0.95 + 0.1 * fd);
        M[idx] = 0;
        R[idx] = 0.08 * (1 - ridge) - 0.04 * ridge;
      }
    }
  });
  return {
    bumpUnitPx: S / nW / 1.5,
    normalStrength: 0.7,
    aoStrength: 0.8,
    aoRadiusPx: Math.max(2, Math.round(S / nW / 4)),
    secondary: null,
    normalizeTone: true,
    metal: 0,
    grid: { nu: nW, nv: Math.max(1, Math.round(S / 8)) },
    threadsAcrossTile: nW,
    threadsAlongTile: nW,
    pxPerThread: S / nW,
    weaveRepeat: { u: 1, v: 1 },
  };
};

// ---------------------------------------------------------------------------------------------
// Felpa polar: pelo denso en mechones suaves con fibras dispuestas en una dirección
// ---------------------------------------------------------------------------------------------
export const buildFleece: FamilyBuilder = (ctx: FamilyContext) => {
  const { size: S, seed, fields } = ctx;
  const { H, T, M, R } = fields;
  const requested = ctx.fabric.threadsPerCm * ctx.fabric.tileCm;
  const tufts = Math.max(6, Math.min(Math.floor(S / 10), Math.round(requested / 1.2)));
  const bigP = Math.max(2, Math.round(tufts / 4));
  const clumpN = new PeriodicFbm(tufts, 3, hashU32(seed, 71), 0.55);
  const clump = new LowResField(Math.min(S, tufts * 8), (u, v) => clumpN.sample(u * tufts, v * tufts));
  const bigN = new PeriodicNoise2D(bigP, hashU32(seed, 72));
  const big = new LowResField(64, (u, v) => bigN.sample(u * bigP, v * bigP));
  const noiseRow = new Float32Array(S);
  const noiseSeed = hashU32(seed, 0xf1ee);
  ctx.bands((y0, y1) => {
    for (let y = y0; y < y1; y++) {
      fillRowNoise(noiseRow, noiseSeed, y);
      const v = (y + 0.5) / S;
      for (let x = 0; x < S; x++) {
        const u = (x + 0.5) / S;
        const c = clump.sample(u, v);
        const b = big.sample(u, v);
        const n = noiseRow[x]! - 0.5;
        let h = 0.5 + 0.3 * c + 0.1 * b + 0.04 * n;
        h = h < 0 ? 0 : h > 1.1 ? 1.1 : h;
        const i = y * S + x;
        H[i] = h;
        T[i] = (0.9 + 0.2 * h) * (1 + 0.07 * n);
        M[i] = 0;
        R[i] = 0.03 + 0.04 * n;
      }
    }
  });
  // fibras sueltas: trazos suaves orientados (pelo cepillado hacia abajo) con envoltura
  const count = Math.round((S * S) / 90);
  const len = Math.max(6, Math.round((S / tufts) * 1.1));
  ctx.push(() => {
    for (let n = 0; n < count; n++) {
      let px = hash01(seed, n, 1, 73) * S;
      let py = hash01(seed, n, 2, 73) * S;
      const ang = -Math.PI / 2 + (hash01(seed, n, 3, 73) - 0.5) * 1.1; // hacia -v (abajo)
      const curl = (hash01(seed, n, 4, 73) - 0.5) * 0.14;
      const bright = hash01(seed, n, 5, 73);
      const L = len * (0.6 + 0.8 * hash01(seed, n, 6, 73));
      let a = ang;
      for (let s = 0; s < L; s++) {
        const fall = Math.sin((Math.PI * (s + 0.5)) / L); // se desvanece en ambos extremos
        // trazo de 2 px de ancho con núcleo claro
        for (let k = 0; k < 2; k++) {
          const xi = (((Math.floor(px) + k) % S) + S) % S;
          const yi = ((Math.floor(py) % S) + S) % S;
          const idx = yi * S + xi;
          const w = k === 0 ? 1 : 0.5;
          H[idx] = H[idx]! + 0.05 * fall * w;
          T[idx] = T[idx]! * (1 + (0.1 + 0.16 * bright) * fall * w);
        }
        px += Math.cos(a);
        py += Math.sin(a);
        a += curl;
      }
    }
  });
  return {
    bumpUnitPx: S / tufts,
    normalStrength: 0.38,
    aoStrength: 0.5,
    aoRadiusPx: Math.max(2, Math.round(S / tufts / 2)),
    secondary: null,
    normalizeTone: true,
    metal: 0,
    grid: null,
    threadsAcrossTile: tufts,
    threadsAlongTile: tufts,
    pxPerThread: S / tufts,
    weaveRepeat: { u: 1, v: 1 },
  };
};
