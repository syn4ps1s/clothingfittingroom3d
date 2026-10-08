import { hash01, hashU32 } from '../prng.js';
import { LowResField, PeriodicNoise2D, sinTurns, smooth01 } from '../noise.js';
import type { FamilyBuilder, FamilyContext, FamilyPlan } from '../types.js';
import { MIN_PX_PER_STITCH, fillRowNoise, resolveThreadGrid } from './grid.js';

/**
 * Familias de PUNTO. Una puntada de jersey (stockinette) se ve como una "V": dos patas (hilos con torsión)
 * que parten del vértice inferior hacia arriba y hacia los lados, y se meten bajo la hilera superior.
 * En coordenadas plegadas g = |fu − 0.5| (distancia al eje de la columna), cada pata es una recta
 * g = pendiente · t, siendo t la fase dentro de la hilera. La sección de la pata es elíptica y lleva
 * estrías de torsión (plies). La forma de UNA puntada se precalcula en una tabla (StitchTable) y el
 * relleno de la textura sólo hace lecturas bilineales: cuesta ~15 flops/píxel.
 * Las columnas "purl" (revés) se ven como pequeños bultos horizontales y quedan más bajas.
 */

interface LegParams {
  readonly slope: number;
  readonly cosA: number;
  readonly halfW: number;
  readonly plyAmp: number;
  readonly plyTurns: number;
  readonly profileExp: number;
}

/** altura 0..1 de las patas de la V para (fu, t) dentro de la celda de puntada (evaluación directa) */
function knitLegs(fu: number, t: number, p: LegParams): number {
  const g = fu < 0.5 ? 0.5 - fu : fu - 0.5;
  let h = 0;
  const kmin = t < 0.16 ? -1 : 0;
  const kmax = t > 0.64 ? 1 : 0;
  for (let k = kmin; k <= kmax; k++) {
    const tau = t - k; // fase de esta pata respecto a SU hilera
    if (tau < -0.36 || tau > 1.16) continue;
    const gc = p.slope * (tau < 0 ? -tau : tau);
    const d = ((g - gc) * p.cosA) / p.halfW;
    if (d <= -1 || d >= 1) continue;
    let prof = Math.pow(1 - d * d, p.profileExp);
    // la punta inferior se mete bajo la hilera anterior; la superior se curva hacia el interior
    if (tau < 0.1) prof *= smooth01(-0.36, 0.1, tau);
    else if (tau > 0.88) prof *= 1 - 0.5 * smooth01(0.88, 1.16, tau);
    prof *= 1 + p.plyAmp * Math.sin((tau * p.plyTurns + d * 0.38) * Math.PI * 2);
    if (prof > h) h = prof;
  }
  return h;
}

const TBL_U = 112;
const TBL_T = 128;
const TBL_U0 = -0.3;
const TBL_U1 = 1.3;

/** Forma de una puntada precalculada; periódica en t, dominio ampliado en fu para absorber la deformación. */
class StitchTable {
  private readonly data = new Float32Array(TBL_U * TBL_T);
  constructor(p: LegParams) {
    for (let ty = 0; ty < TBL_T; ty++) {
      for (let tx = 0; tx < TBL_U; tx++) {
        const fu = TBL_U0 + (tx / (TBL_U - 1)) * (TBL_U1 - TBL_U0);
        this.data[ty * TBL_U + tx] = knitLegs(fu, ty / TBL_T, p);
      }
    }
  }
  sample(fu: number, t: number): number {
    let x = ((fu - TBL_U0) / (TBL_U1 - TBL_U0)) * (TBL_U - 1);
    x = x < 0 ? 0 : x > TBL_U - 1.001 ? TBL_U - 1.001 : x;
    const y = t * TBL_T;
    const x0 = x | 0;
    const y0 = y | 0;
    const fx = x - x0;
    const fy = y - y0;
    const y1 = y0 + 1 === TBL_T ? 0 : y0 + 1;
    const d = this.data;
    const a = d[y0 * TBL_U + x0]! + (d[y0 * TBL_U + x0 + 1]! - d[y0 * TBL_U + x0]!) * fx;
    const b = d[y1 * TBL_U + x0]! + (d[y1 * TBL_U + x0 + 1]! - d[y1 * TBL_U + x0]!) * fx;
    return a + (b - a) * fy;
  }
}

interface KnitSpec {
  readonly kind: 'jersey' | 'rib' | 'cable';
  readonly nw: number;
  readonly nc: number;
  readonly legs: LegParams;
  readonly fiber: number;
  readonly fuzz: number;
  readonly shade: number;
  /** variación aleatoria por puntada (tono) */
  readonly stitchVar: number;
  /** deformación suave de la rejilla (fracción de celda) */
  readonly warp: number;
  readonly normalStrength: number;
  readonly aoStrength: number;
}

function planKnit(ctx: FamilyContext, spec: KnitSpec): FamilyPlan {
  const { size: S, seed, fields } = ctx;
  const { H, T, M, R } = fields;
  const { nw, nc } = spec;
  const kind = spec.kind;
  const fiber = spec.fiber;
  const fuzz = spec.fuzz;
  const shade = spec.shade;
  const cellTone = new Float32Array(nw * nc);
  const colTone = new Float32Array(nw);
  let table: StitchTable | null = null;
  let warpU: LowResField | null = null;
  let warpV: LowResField | null = null;
  let ampF: LowResField | null = null;

  ctx.push(() => {
    table = new StitchTable(spec.legs);
    const per = Math.max(2, Math.round(nw / 4));
    const nA = new PeriodicNoise2D(per, hashU32(seed, 21));
    const nB = new PeriodicNoise2D(per, hashU32(seed, 22));
    const nC = new PeriodicNoise2D(per, hashU32(seed, 23));
    warpU = new LowResField(64, (u, v) => nA.sample(u * per, v * per));
    warpV = new LowResField(64, (u, v) => nB.sample(u * per, v * per));
    ampF = new LowResField(64, (u, v) => nC.sample(u * per, v * per));
    for (let j = 0; j < nc; j++) {
      for (let i = 0; i < nw; i++) {
        cellTone[j * nw + i] = 1 + (hash01(seed, i, j, 33) - 0.5) * 0.14 * spec.stitchVar;
      }
    }
    for (let i = 0; i < nw; i++) colTone[i] = 1 + (hash01(seed, i, 0, 34) - 0.5) * 0.07 * spec.stitchVar;
  });

  const noiseRow = new Float32Array(S);
  const noiseSeed = hashU32(seed, 0xc0de);
  const wAmp = spec.warp;

  ctx.bands((y0, y1) => {
    const tb = table!;
    const wu = warpU!;
    const wv = warpV!;
    const am = ampF!;
    for (let y = y0; y < y1; y++) {
      fillRowNoise(noiseRow, noiseSeed, y);
      const base = y * S;
      const vy = (y + 0.5) / S;
      for (let x = 0; x < S; x++) {
        const ux = (x + 0.5) / S;
        // deformación suave y continua de la rejilla de puntadas
        const uc = ux * nw + wAmp * wu.sample(ux, vy);
        const vc = vy * nc + wAmp * 0.8 * wv.sample(ux, vy);
        const i0 = Math.floor(uc);
        const j0 = Math.floor(vc);
        const fu = uc - i0;
        const t = vc - j0;
        const iw = ((i0 % nw) + nw) % nw;
        const jw = ((j0 % nc) + nc) % nc;
        const cell = jw * nw + iw;
        const amp = 1 + 0.12 * am.sample(ux, vy) * spec.stitchVar;
        const n = noiseRow[x]! - 0.5;
        let h = 0;
        let rough = 0;

        if (kind === 'jersey') {
          h = 0.1 + 0.9 * tb.sample(fu, t) * amp;
        } else if (kind === 'rib') {
          // canalé 2×2: columnas 0,1 derecho (abultadas); 2,3 revés (hundidas)
          const m = iw & 3;
          const pp = ((m & 1) + fu) * 0.5; // posición dentro del par
          if (m < 2) {
            const ridge = Math.sqrt(sinTurns(pp * 0.5) > 0 ? sinTurns(pp * 0.5) : 0);
            h = (0.36 + 0.64 * tb.sample(fu, t) * amp) * (0.6 + 0.4 * ridge);
          } else {
            const bump = Math.sqrt(sinTurns(fu * 0.5)) * sinTurns(t * 0.5);
            h = 0.04 + 0.1 * bump;
            rough = 0.05;
          }
        } else {
          // trenzas (cable): motivo de 10 columnas · 2 revés(0,9) · 2 derecho(1,8) · 6 de trenza (2..7)
          const m10 = uc - 10 * Math.floor(uc / 10);
          const frU = m10 - Math.floor(m10);
          const purl = 0.07 + 0.26 * Math.sqrt(sinTurns(frU * 0.5)) * sinTurns(t * 0.5);
          if (m10 < 1 || m10 >= 9) {
            h = purl;
            rough = 0.05;
          } else if (m10 < 2 || m10 >= 8) {
            h = 0.16 + 0.62 * tb.sample(frU, t) * amp;
          } else {
            const up = m10 - 2; // 0..6
            const q0 = vc / 8 - Math.floor(vc / 8);
            let f: number;
            if (q0 < 0.12) f = 0;
            else if (q0 < 0.5) f = smooth01(0.12, 0.5, q0);
            else if (q0 < 0.62) f = 1;
            else f = 1 - smooth01(0.62, 1, q0);
            const eA = 3 * f;
            const eB = 3 * (1 - f);
            const aOver = q0 < 0.5;
            let hA = -1;
            let hB = -1;
            if (up >= eA && up < eA + 3) {
              const xi = (up - eA) / 3;
              const w3 = xi * 3;
              const rope = 0.45 + 0.55 * Math.sqrt(sinTurns(xi * 0.5));
              hA = (0.14 + 0.86 * tb.sample(w3 - Math.floor(w3), t) * amp) * rope + (aOver ? 0.22 : -0.14);
            }
            if (up >= eB && up < eB + 3) {
              const xi = (up - eB) / 3;
              const w3 = xi * 3;
              const rope = 0.45 + 0.55 * Math.sqrt(sinTurns(xi * 0.5));
              hB = (0.14 + 0.86 * tb.sample(w3 - Math.floor(w3), t) * amp) * rope + (aOver ? -0.14 : 0.22);
            }
            h = hA > hB ? hA : hB;
            if (h < 0) h = purl * 0.8; // la trenza se estrecha al cruzarse: se ve el revés de fondo
          }
        }

        h += fuzz * n;
        const hn = h < 0 ? 0 : h > 1.2 ? 1.2 : h;
        const idx = base + x;
        H[idx] = hn;
        const tone = cellTone[cell]! * colTone[iw]!;
        T[idx] = tone * (1 - shade * (1 - (hn > 1 ? 1 : hn)) + fiber * n * 2);
        M[idx] = 0;
        R[idx] = rough;
      }
    }
  });

  return {
    bumpUnitPx: S / nw,
    normalStrength: spec.normalStrength,
    aoStrength: spec.aoStrength,
    aoRadiusPx: Math.max(2, Math.round((S / nw) * 0.4)),
    secondary: null,
    normalizeTone: true,
    metal: 0,
    grid: { nu: nw, nv: nc },
    threadsAcrossTile: nw,
    threadsAlongTile: nc,
    pxPerThread: S / nw,
    weaveRepeat: { u: kind === 'cable' ? 10 : kind === 'rib' ? 4 : 1, v: kind === 'cable' ? 8 : 1 },
  };
}

/** relación hileras/columnas de una puntada de jersey (la puntada es más ancha que alta) */
const COURSE_ASPECT = 1.28;

function legParams(
  aspect: number,
  halfW: number,
  plyAmp: number,
  plyTurns: number,
  profileExp = 0.7,
): LegParams {
  const slope = 0.5;
  const h = 1 / aspect; // alto de la puntada en anchos de columna
  return { slope, cosA: h / Math.hypot(h, slope), halfW, plyAmp, plyTurns, profileExp };
}

export const buildJersey: FamilyBuilder = (ctx) => {
  const g = resolveThreadGrid(ctx.fabric, ctx.size, 1, 1, MIN_PX_PER_STITCH, COURSE_ASPECT);
  return planKnit(ctx, {
    kind: 'jersey',
    nw: g.nu,
    nc: g.nv,
    legs: legParams(COURSE_ASPECT, 0.3, 0.11, 1.3),
    fiber: 0.05,
    fuzz: 0.05,
    shade: 0.3,
    stitchVar: 1,
    warp: 0.06,
    normalStrength: 0.62,
    aoStrength: 0.7,
  });
};

export const buildWoolKnit: FamilyBuilder = (ctx) => {
  // cada motivo de trenza son 10 columnas y 8 hileras
  const g = resolveThreadGrid(ctx.fabric, ctx.size, 10, 8, MIN_PX_PER_STITCH, COURSE_ASPECT);
  return planKnit(ctx, {
    kind: 'cable',
    nw: g.nu,
    nc: g.nv,
    legs: legParams(COURSE_ASPECT, 0.33, 0.13, 1.1),
    fiber: 0.09,
    fuzz: 0.07,
    shade: 0.38,
    stitchVar: 1.3,
    warp: 0.07,
    normalStrength: 0.8,
    aoStrength: 0.9,
  });
};

export const buildMerino: FamilyBuilder = (ctx) => {
  const g = resolveThreadGrid(ctx.fabric, ctx.size, 4, 1, MIN_PX_PER_STITCH, COURSE_ASPECT);
  return planKnit(ctx, {
    kind: 'rib',
    nw: g.nu,
    nc: g.nv,
    legs: legParams(COURSE_ASPECT, 0.3, 0.09, 1.3),
    fiber: 0.06,
    fuzz: 0.05,
    shade: 0.34,
    stitchVar: 0.8,
    warp: 0.04,
    normalStrength: 0.62,
    aoStrength: 0.75,
  });
};
