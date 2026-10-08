import { hash01, hashU32 } from '../prng.js';
import { LowResField, PeriodicFbm, PeriodicNoise1D, sinTurns, smooth01 } from '../noise.js';
import { mixRgb, shiftHueLinear, type RGB } from '../color.js';
import type { FamilyBuilder, FamilyContext, FamilyPlan } from '../types.js';
import { fillRowNoise, resolveThreadGrid } from './grid.js';

/**
 * Motor de TEJIDO PLANO / SARGA / RASO / ESPIGA.
 *
 * Modelo físico simplificado: cada hilo de urdimbre (vertical, índice i) y de trama (horizontal, j) es un
 * cilindro aplastado cuya altura sube (z=+1) donde pasa POR ENCIMA del hilo cruzado y baja (z=-1) donde pasa
 * por debajo. La altura de la superficie es el máximo entre ambos hilos; el color visible es el del hilo
 * superior. El ligamento se describe con una matriz `state` (1 = urdimbre por encima).
 * Todo se evalúa por píxel a partir de tablas por columna/fila, así que cuesta ~40 flops/píxel.
 */

interface SlubSpec {
  /** amplitud del grosor extra en el engrosamiento (0..1.5) */
  readonly amp: number;
  /** variación de tono asociada */
  readonly tone: number;
  /** longitud de onda de los engrosamientos en nº de hilos */
  readonly wavelength: number;
  /** umbral de ruido (0..1): más alto = engrosamientos más escasos */
  readonly threshold: number;
}

export interface WeaveSpec {
  readonly px: number;
  readonly py: number;
  /** 1 = urdimbre por encima; índice [jj * px + ii] */
  readonly state: Uint8Array;
  /** fracción de la celda que ocupa el hilo (el resto es hueco) */
  readonly warpWidth: number;
  readonly weftWidth: number;
  /** exponente del perfil de sección (0.5 redondo … 0.2 cinta plana) */
  readonly profileExp: number;
  /** amplitud de la ondulación por cruce */
  readonly undulation: number;
  /** relieve propio del cuerpo del hilo */
  readonly bodyWarp: number;
  readonly bodyWeft: number;
  readonly holeDepth: number;
  /** variación aleatoria de grosor por hilo (0..0.5) */
  readonly threadVar: number;
  /** variación aleatoria de tono por hilo (0..0.3) */
  readonly toneVar: number;
  readonly slubWarp: SlubSpec | null;
  readonly slubWeft: SlubSpec | null;
  /** torsión del hilo (estrías diagonales) */
  readonly twist: { readonly amp: number; readonly turnsPerThread: number } | null;
  readonly warpM: number;
  readonly weftM: number;
  /** si se da: cada hilo escoge M al azar de esta lista (tweed, lino) */
  readonly mLevels: readonly number[] | null;
  readonly warpRough: number;
  readonly weftRough: number;
  readonly warpTone: number;
  readonly weftTone: number;
  /** bandas de brillo a lo largo de los hilos (raso) */
  readonly lustre: number;
  /** ruido por píxel en el tono (fibras) */
  readonly fiber: number;
  /** ruido por píxel en el relieve */
  readonly fuzz: number;
  /** desgaste de la urdimbre (denim): zonas donde se descubre la trama clara */
  readonly fade: { readonly amount: number; readonly periodTiles: number } | null;
  /** oscurecimiento por cavidad en el albedo (0..0.5) */
  readonly shade: number;
  /**
   * costillas diagonales de la sarga: los "flotados" se apilan en diagonal y forman crestas continuas.
   * `period` = hilos por repetición diagonal; `fold` > 0 invierte la dirección cada `fold` hilos (espiga).
   */
  readonly rib: { readonly amp: number; readonly period: number; readonly fold: number } | null;
}

const DEFAULTS: Omit<WeaveSpec, 'px' | 'py' | 'state'> = {
  warpWidth: 0.94,
  weftWidth: 0.94,
  profileExp: 0.45,
  undulation: 0.22,
  bodyWarp: 0.32,
  bodyWeft: 0.32,
  holeDepth: 0.5,
  threadVar: 0.05,
  toneVar: 0.03,
  slubWarp: null,
  slubWeft: null,
  twist: null,
  warpM: 0,
  weftM: 0,
  mLevels: null,
  warpRough: 0,
  weftRough: 0,
  warpTone: 1,
  weftTone: 1,
  lustre: 0,
  fiber: 0.03,
  fuzz: 0.02,
  fade: null,
  shade: 0.28,
  rib: null,
};

export function weaveSpec(
  px: number,
  py: number,
  state: Uint8Array,
  over: Partial<Omit<WeaveSpec, 'px' | 'py' | 'state'>>,
): WeaveSpec {
  return { ...DEFAULTS, ...over, px, py, state };
}

/** Matrices de ligamento. Convención: [jj * px + ii], 1 = urdimbre arriba. Eje v hacia arriba. */
export const WEAVES = {
  plain: (): { px: number; py: number; state: Uint8Array } => ({
    px: 2,
    py: 2,
    state: Uint8Array.from([1, 0, 0, 1]),
  }),
  /** sarga a/b de dirección derecha ("/" con v hacia arriba); `up` = hilos de urdimbre arriba, `down` abajo */
  twill: (up: number, down: number): { px: number; py: number; state: Uint8Array } => {
    const n = up + down;
    const state = new Uint8Array(n * n);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) state[j * n + i] = (i - j + n * 8) % n < up ? 1 : 0;
    return { px: n, py: n, state };
  },
  /** raso de `n` pasos (salto `step`): cada hilo pasa por debajo una sola vez */
  satin: (n: number, step: number): { px: number; py: number; state: Uint8Array } => {
    const state = new Uint8Array(n * n);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) state[j * n + i] = (step * j) % n === i ? 0 : 1;
    return { px: n, py: n, state };
  },
  /** espiga: sarga 2/2 que invierte su dirección cada `g` hilos */
  herringbone: (g: number): { px: number; py: number; state: Uint8Array } => {
    const px = 2 * g;
    const py = 4;
    const state = new Uint8Array(px * py);
    for (let j = 0; j < py; j++) {
      for (let i = 0; i < px; i++) {
        const local = i < g ? i : px - 1 - i;
        state[j * px + i] = (local - j + 64) % 4 < 2 ? 1 : 0;
      }
    }
    return { px, py, state };
  },
};

/** perfil de sección de un hilo: (1-d²)^e dentro del ancho, -1 fuera */
function crossSection(f: number, width: number, exp: number): number {
  const d = (f - 0.5) / (0.5 * width);
  if (d <= -1 || d >= 1) return -1;
  return Math.pow(1 - d * d, exp);
}

/** pesos de mezcla con los vecinos anterior/siguiente a lo largo del hilo (suaviza el cruce) */
function neighbourWeights(f: number): { wp: number; wn: number } {
  if (f < 0.5) return { wp: 0.5 * (1 - smooth01(0, 1, f * 2)), wn: 0 };
  return { wp: 0, wn: 0.5 * smooth01(0, 1, (f - 0.5) * 2) };
}

/** Construye el plan de un tejido a partir de un `WeaveSpec`. */
export function planWoven(
  ctx: FamilyContext,
  spec: WeaveSpec,
  nu: number,
  nv: number,
  secondary: FamilyPlan['secondary'],
  normalStrength: number,
  aoStrength: number,
): FamilyPlan {
  const { size: S, seed, fields } = ctx;
  const { H, T, M, R } = fields;
  const { px, py, state } = spec;

  // ---- tablas por columna (x) y fila (y) ----
  const colI = new Int32Array(S);
  const colMod = new Int32Array(S); // i % px
  const colProf = new Float32Array(S); // perfil de la urdimbre en esta columna
  const colFu = new Float32Array(S);
  const colUc = new Float32Array(S); // u continuo en hilos
  const rowJ = new Int32Array(S);
  const rowJJ = new Int32Array(S); // j % py
  const rowProf = new Float32Array(S);
  const rowWP = new Float32Array(S);
  const rowWN = new Float32Array(S);
  const rowFv = new Float32Array(S);
  const rowVc = new Float32Array(S);
  const colWP = new Float32Array(S);
  const colWN = new Float32Array(S);
  const colModP = new Int32Array(S);
  const colModN = new Int32Array(S);
  for (let x = 0; x < S; x++) {
    const uc = ((x + 0.5) * nu) / S;
    const i = Math.floor(uc);
    const fu = uc - i;
    colI[x] = i;
    colFu[x] = fu;
    colUc[x] = uc;
    colMod[x] = i % px;
    colModP[x] = (i - 1 + px * 1024) % px;
    colModN[x] = (i + 1) % px;
    colProf[x] = crossSection(fu, spec.warpWidth, spec.profileExp);
    const w = neighbourWeights(fu);
    colWP[x] = w.wp;
    colWN[x] = w.wn;
  }
  for (let y = 0; y < S; y++) {
    const vc = ((y + 0.5) * nv) / S;
    const j = Math.floor(vc);
    const fv = vc - j;
    rowJ[y] = j;
    rowJJ[y] = j % py;
    rowFv[y] = fv;
    rowVc[y] = vc;
    rowProf[y] = crossSection(fv, spec.weftWidth, spec.profileExp);
    const w = neighbourWeights(fv);
    rowWP[y] = w.wp;
    rowWN[y] = w.wn;
  }
  // altura de la trama a lo largo de u: depende sólo de (j % py, x) → tabla precalculada
  const zfTab = new Float32Array(py * S);
  for (let jj = 0; jj < py; jj++) {
    for (let x = 0; x < S; x++) {
      const eC = 1 - state[jj * px + colMod[x]!]!;
      const eP = 1 - state[jj * px + colModP[x]!]!;
      const eN = 1 - state[jj * px + colModN[x]!]!;
      zfTab[jj * S + x] = (eC + (eP - eC) * colWP[x]! + (eN - eC) * colWN[x]!) * 2 - 1;
    }
  }

  // ---- tablas por hilo ----
  const thickW = new Float32Array(nu);
  const toneW = new Float32Array(nu);
  const mW = new Float32Array(nu);
  const phaseW = new Float32Array(nu);
  const thickF = new Float32Array(nv);
  const toneF = new Float32Array(nv);
  const mF = new Float32Array(nv);
  const phaseF = new Float32Array(nv);
  const pickM = (base: number, a: number, b: number): number => {
    if (spec.mLevels && spec.mLevels.length > 0) {
      const k = Math.min(
        spec.mLevels.length - 1,
        Math.floor(hash01(seed, a, b, 51) * spec.mLevels.length),
      );
      return spec.mLevels[k]!;
    }
    return base;
  };
  for (let i = 0; i < nu; i++) {
    thickW[i] = 1 + spec.threadVar * (hash01(seed, i, 1, 11) * 2 - 1);
    toneW[i] = spec.warpTone * (1 + spec.toneVar * (hash01(seed, i, 2, 11) * 2 - 1));
    mW[i] = pickM(spec.warpM, i, 1);
    phaseW[i] = hash01(seed, i, 3, 11);
  }
  for (let j = 0; j < nv; j++) {
    thickF[j] = 1 + spec.threadVar * (hash01(seed, j, 4, 11) * 2 - 1);
    toneF[j] = spec.weftTone * (1 + spec.toneVar * (hash01(seed, j, 5, 11) * 2 - 1));
    mF[j] = pickM(spec.weftM, j, 2);
    phaseF[j] = hash01(seed, j, 6, 11);
  }

  let slubWarpT: Float32Array | null = null;
  let slubWeftT: Float32Array | null = null;
  const buildSlub = (s2: SlubSpec, threads: number, along: number, stream: number): Float32Array => {
    const t = new Float32Array(threads * S);
    const p1 = Math.max(2, Math.round(along / s2.wavelength));
    const p2 = Math.max(3, Math.round(p1 * 2.7));
    for (let k = 0; k < threads; k++) {
      const n1 = new PeriodicNoise1D(p1, hashU32(seed, k, stream), 1);
      const n2 = new PeriodicNoise1D(p2, hashU32(seed, k, stream), 2);
      for (let s = 0; s < S; s++) {
        const q = s / S;
        const n = 0.62 * n1.sample(q * p1) + 0.38 * n2.sample(q * p2);
        t[k * S + s] = smooth01(s2.threshold, s2.threshold + 0.28, n);
      }
    }
    return t;
  };
  let fade: LowResField | null = null;

  ctx.push(() => {
    if (spec.slubWarp) slubWarpT = buildSlub(spec.slubWarp, nu, nv, 21);
    if (spec.slubWeft) slubWeftT = buildSlub(spec.slubWeft, nv, nu, 22);
    if (spec.fade) {
      // campo de desgaste alargado a lo largo de la urdimbre (v): baja frecuencia en v, doble en u
      const P = Math.max(1, Math.round(spec.fade.periodTiles));
      const fbm = new PeriodicFbm(P, 3, hashU32(seed, 77), 0.55);
      fade = new LowResField(128, (u, v) => fbm.sample(u * P * 2, v * P) * 0.5 + 0.5);
    }
  });

  // costillas diagonales: sin(2π(a−b)) = sin a · cos b − cos a · sin b con tablas por columna/fila
  const rib = spec.rib;
  const colRibS = new Float32Array(S);
  const colRibC = new Float32Array(S);
  const rowRibS = new Float32Array(S);
  const rowRibC = new Float32Array(S);
  if (rib) {
    for (let x = 0; x < S; x++) {
      let a = colUc[x]!;
      if (rib.fold > 0) {
        const m = a % (2 * rib.fold);
        a = m < rib.fold ? m : 2 * rib.fold - m;
      }
      colRibS[x] = Math.sin((a / rib.period) * Math.PI * 2);
      colRibC[x] = Math.cos((a / rib.period) * Math.PI * 2);
    }
    for (let y = 0; y < S; y++) {
      rowRibS[y] = Math.sin((rowVc[y]! / rib.period) * Math.PI * 2);
      rowRibC[y] = Math.cos((rowVc[y]! / rib.period) * Math.PI * 2);
    }
  }
  const ribAmp = rib ? rib.amp : 0;
  const noiseRow = new Float32Array(S);
  const noiseSeed = hashU32(seed, 0xf1be);
  // ---- constantes hoisted (V8 no puede asumir que `spec` no cambia) ----
  const und = spec.undulation;
  const bodyW = spec.bodyWarp;
  const bodyF = spec.bodyWeft;
  const hole = spec.holeDepth;
  const hrange = und + Math.max(bodyW, bodyF) * 1.25 + hole;
  const invRange = 1 / hrange;
  const twist = spec.twist;
  const twAmp = twist ? twist.amp : 0;
  const twTurns = twist ? twist.turnsPerThread : 0;
  const lustre = spec.lustre;
  const fiberAmp = spec.fiber * 2;
  const fuzzAmp = spec.fuzz;
  const shadeAmt = spec.shade;
  const warpRough = spec.warpRough;
  const weftRough = spec.weftRough;
  const slubWAmp = spec.slubWarp ? spec.slubWarp.amp : 0;
  const slubWTone = spec.slubWarp ? spec.slubWarp.tone : 0;
  const slubFAmp = spec.slubWeft ? spec.slubWeft.amp : 0;
  const slubFTone = spec.slubWeft ? spec.slubWeft.tone : 0;
  const fadeAmount = spec.fade ? spec.fade.amount : 0;
  const zwRow = new Float32Array(px);

  ctx.bands((y0, y1) => {
    const sw = slubWarpT;
    const sf = slubWeftT;
    const fd = fade;
    for (let y = y0; y < y1; y++) {
      fillRowNoise(noiseRow, noiseSeed, y);
      const j = rowJ[y]!;
      const jj = rowJJ[y]!;
      const jjP = (jj + py - 1) % py;
      const jjN = (jj + 1) % py;
      const wPv = rowWP[y]!;
      const wNv = rowWN[y]!;
      // altura de cada urdimbre de la repetición en esta fila (px valores)
      for (let im = 0; im < px; im++) {
        const sC = state[jj * px + im]!;
        const sP = state[jjP * px + im]!;
        const sN = state[jjN * px + im]!;
        zwRow[im] = (sC + (sP - sC) * wPv + (sN - sC) * wNv) * 2 - 1;
      }
      const profV = rowProf[y]!;
      const thF = thickF[j]!;
      const toF = toneF[j]!;
      const mFj = mF[j]!;
      const phF = phaseF[j]!;
      const fv = rowFv[y]!;
      const vc = rowVc[y]!;
      const zfBase = jj * S;
      const base = y * S;
      const rbS = rowRibS[y]!;
      const rbC = rowRibC[y]!;
      for (let x = 0; x < S; x++) {
        const i = colI[x]!;
        const zw = zwRow[colMod[x]!]!;
        const zf = zfTab[zfBase + x]!;
        const pu = colProf[x]!;
        let thW = thickW[i]!;
        let thFx = thF;
        let toW = toneW[i]!;
        let toFx = toF;
        if (sw) {
          const sl = sw[i * S + y]!;
          thW *= 1 + slubWAmp * sl;
          toW *= 1 + slubWTone * (sl - 0.25);
        }
        if (sf) {
          const sl = sf[j * S + x]!;
          thFx *= 1 + slubFAmp * sl;
          toFx *= 1 + slubFTone * (sl - 0.25);
        }
        let hw = -2;
        if (pu >= 0) {
          hw = und * zw + bodyW * pu * thW;
          if (twAmp !== 0) hw += twAmp * pu * sinTurns(vc * twTurns + colFu[x]! * 0.7 + phaseW[i]!);
        }
        let hf = -2;
        if (profV >= 0) {
          hf = und * zf + bodyF * profV * thFx;
          if (twAmp !== 0) hf += twAmp * profV * sinTurns(colUc[x]! * twTurns + fv * 0.7 + phF);
        }
        const n = noiseRow[x]! - 0.5;
        let h = hw > hf ? hw : hf;
        if (h < -hole) h = -hole;
        h += fuzzAmp * n;
        if (ribAmp !== 0) h += ribAmp * (colRibS[x]! * rbC - colRibC[x]! * rbS);
        let Hn = (h + hole) * invRange;
        Hn = Hn < 0 ? 0 : Hn > 1.25 ? 1.25 : Hn;

        const d = (hw - hf) * 12;
        const t = d <= -1 ? 0 : d >= 1 ? 1 : 0.5 + d * (0.75 - 0.25 * d * d);
        let tone = toFx + (toW - toFx) * t;
        let mix = mFj + (mW[i]! - mFj) * t;
        if (lustre !== 0) tone *= 1 + lustre * t * sinTurns(vc * 0.11 + phaseW[i]! * 3);
        if (fd) {
          const f = fd.sample(colUc[x]! / nu, vc / nv);
          const fadeAmt = smooth01(0.4, 0.85, f) * fadeAmount;
          mix += (1 - mix) * fadeAmt * t;
          tone *= 1 + 0.12 * fadeAmt * t;
        }
        tone *= 1 - shadeAmt * (1 - (Hn > 1 ? 1 : Hn)) + fiberAmp * n;
        const idx = base + x;
        H[idx] = Hn;
        T[idx] = tone;
        M[idx] = mix > 1 ? 1 : mix < 0 ? 0 : mix;
        R[idx] = weftRough + (warpRough - weftRough) * t;
      }
    }
  });

  return {
    bumpUnitPx: S / nu,
    normalStrength,
    aoStrength,
    aoRadiusPx: Math.max(2, Math.round((S / nu) * 0.45)),
    secondary,
    normalizeTone: true,
    metal: 0,
    grid: { nu, nv },
    threadsAcrossTile: nu,
    threadsAlongTile: nv,
    pxPerThread: S / nu,
    weaveRepeat: { u: px, v: py },
  };
}

// ---------------------------------------------------------------------------------------------
// Familias tejidas
// ---------------------------------------------------------------------------------------------

function gridFor(ctx: FamilyContext, repU: number, repV: number) {
  return resolveThreadGrid(ctx.fabric, ctx.size, repU, repV);
}

export const buildPoplin: FamilyBuilder = (ctx) => {
  const w = WEAVES.plain();
  const g = gridFor(ctx, w.px, w.py);
  const spec = weaveSpec(w.px, w.py, w.state, {
    warpWidth: 1,
    weftWidth: 1,
    profileExp: 0.5,
    undulation: 0.15,
    bodyWarp: 0.26,
    bodyWeft: 0.33, // la trama más gruesa marca la fina costilla transversal del popelín
    threadVar: 0.05,
    toneVar: 0.03,
    slubWarp: { amp: 0.2, tone: 0.04, wavelength: 8, threshold: 0.66 },
    slubWeft: { amp: 0.2, tone: 0.04, wavelength: 8, threshold: 0.66 },
    twist: { amp: 0.03, turnsPerThread: 0.8 },
    fiber: 0.022,
    fuzz: 0.012,
    shade: 0.14,
  });
  return planWoven(ctx, spec, g.nu, g.nv, null, 0.55, 0.5);
};

export const buildTwill: FamilyBuilder = (ctx) => {
  const w = WEAVES.twill(2, 1);
  const g = gridFor(ctx, w.px, w.py);
  const spec = weaveSpec(w.px, w.py, w.state, {
    warpWidth: 1,
    weftWidth: 1,
    profileExp: 0.4,
    undulation: 0.2,
    bodyWarp: 0.24,
    bodyWeft: 0.22,
    threadVar: 0.05,
    toneVar: 0.03,
    slubWarp: { amp: 0.2, tone: 0.04, wavelength: 10, threshold: 0.66 },
    slubWeft: { amp: 0.2, tone: 0.04, wavelength: 10, threshold: 0.66 },
    twist: { amp: 0.03, turnsPerThread: 0.8 },
    warpRough: -0.05,
    weftRough: 0.03,
    weftTone: 0.97,
    fiber: 0.025,
    fuzz: 0.012,
    shade: 0.2,
    rib: { amp: 0.17, period: 3, fold: 0 },
  });
  return planWoven(ctx, spec, g.nu, g.nv, null, 0.75, 0.55);
};

export const buildDenim: FamilyBuilder = (ctx) => {
  const w = WEAVES.twill(3, 1);
  const g = gridFor(ctx, w.px, w.py);
  const spec = weaveSpec(w.px, w.py, w.state, {
    warpWidth: 0.96,
    weftWidth: 0.9,
    profileExp: 0.45,
    undulation: 0.24,
    bodyWarp: 0.38,
    bodyWeft: 0.26,
    threadVar: 0.1,
    toneVar: 0.07,
    slubWarp: { amp: 0.4, tone: 0.16, wavelength: 4.5, threshold: 0.52 },
    slubWeft: { amp: 0.2, tone: 0.06, wavelength: 7, threshold: 0.6 },
    twist: { amp: 0.09, turnsPerThread: 0.9 },
    warpM: 0,
    weftM: 0.85,
    mLevels: null,
    warpTone: 0.94,
    weftTone: 1.0,
    warpRough: 0,
    weftRough: 0.06,
    fiber: 0.06,
    fuzz: 0.03,
    fade: { amount: 0.5, periodTiles: 3 },
    shade: 0.3,
    rib: { amp: 0.1, period: 4, fold: 0 },
  });
  // la trama es un crudo claro: se mezcla con el tinte para que siempre sea más clara que la urdimbre
  const weft: RGB = mixRgb(ctx.base, [0.5, 0.5, 0.52], 0.8);
  return planWoven(ctx, spec, g.nu, g.nv, { target: weft, k: 1 }, 1.1, 0.85);
};

export const buildLinen: FamilyBuilder = (ctx) => {
  const w = WEAVES.plain();
  const g = gridFor(ctx, w.px, w.py);
  const spec = weaveSpec(w.px, w.py, w.state, {
    warpWidth: 0.88,
    weftWidth: 0.88,
    profileExp: 0.5,
    undulation: 0.2,
    bodyWarp: 0.3,
    bodyWeft: 0.3,
    holeDepth: 0.5,
    threadVar: 0.16,
    toneVar: 0.08,
    slubWarp: { amp: 0.65, tone: 0.2, wavelength: 4.5, threshold: 0.54 },
    slubWeft: { amp: 0.65, tone: 0.2, wavelength: 4.5, threshold: 0.54 },
    twist: { amp: 0.045, turnsPerThread: 0.6 },
    mLevels: [0, 0, 0.1, 0.3],
    fiber: 0.05,
    fuzz: 0.03,
    shade: 0.26,
  });
  const flax: RGB = mixRgb(ctx.base, [0.6, 0.48, 0.3], 0.5);
  return planWoven(ctx, spec, g.nu, g.nv, { target: flax, k: 0.5 }, 0.75, 0.7);
};

export const buildSatin: FamilyBuilder = (ctx) => {
  const w = WEAVES.satin(8, 3);
  const g = gridFor(ctx, w.px, w.py);
  const spec = weaveSpec(w.px, w.py, w.state, {
    warpWidth: 1,
    weftWidth: 1,
    profileExp: 0.3,
    undulation: 0.04,
    bodyWarp: 0.16,
    bodyWeft: 0.14,
    holeDepth: 0.3,
    threadVar: 0.02,
    toneVar: 0.02,
    slubWarp: { amp: 0.04, tone: 0.07, wavelength: 20, threshold: 0.4 },
    lustre: 0.07,
    warpRough: -0.2,
    weftRough: -0.08,
    warpTone: 1.0,
    weftTone: 1.0,
    fiber: 0.008,
    fuzz: 0.004,
    shade: 0.04,
  });
  return planWoven(ctx, spec, g.nu, g.nv, null, 0.18, 0.2);
};

export const buildTweed: FamilyBuilder = (ctx) => {
  const G = 6;
  const w = WEAVES.herringbone(G);
  const g = gridFor(ctx, w.px, w.py);
  const accentHue = shiftHueLinear(ctx.base, 28, 0.9);
  const accent: RGB = mixRgb(accentHue, [0.55, 0.5, 0.42], 0.35);
  const spec = weaveSpec(w.px, w.py, w.state, {
    warpWidth: 0.94,
    weftWidth: 0.94,
    profileExp: 0.5,
    undulation: 0.18,
    bodyWarp: 0.36,
    bodyWeft: 0.36,
    holeDepth: 0.5,
    threadVar: 0.24,
    toneVar: 0.1,
    slubWarp: { amp: 0.55, tone: 0.14, wavelength: 3.5, threshold: 0.52 },
    slubWeft: { amp: 0.55, tone: 0.14, wavelength: 3.5, threshold: 0.52 },
    twist: { amp: 0.07, turnsPerThread: 0.7 },
    mLevels: [0, 0, 0.12, 0.45, 0.8],
    fiber: 0.08,
    fuzz: 0.05,
    shade: 0.26,
    rib: { amp: 0.12, period: 4, fold: G },
  });
  const plan = planWoven(ctx, spec, g.nu, g.nv, { target: accent, k: 0.7 }, 0.6, 0.6);
  // "motas": neps de color y fibras sueltas estampadas encima del tejido
  const { H, T, M } = ctx.fields;
  const S = ctx.size;
  const count = Math.round((S * S) / 1100);
  ctx.push(() => {
    for (let n = 0; n < count; n++) {
      const cx = Math.floor(hash01(ctx.seed, n, 1, 61) * S);
      const cy = Math.floor(hash01(ctx.seed, n, 2, 61) * S);
      const rad = 1.2 + hash01(ctx.seed, n, 3, 61) * (plan.pxPerThread * 0.26);
      const dark = hash01(ctx.seed, n, 4, 61) < 0.3;
      const level = hash01(ctx.seed, n, 5, 61);
      const r2 = Math.ceil(rad);
      for (let dy = -r2; dy <= r2; dy++) {
        for (let dx = -r2; dx <= r2; dx++) {
          const d = Math.hypot(dx, dy) / rad;
          if (d >= 1) continue;
          const a = 1 - d * d;
          const xx = (cx + dx + S) % S;
          const yy = (cy + dy + S) % S;
          const idx = yy * S + xx;
          if (dark) {
            T[idx] = T[idx]! * (1 - 0.45 * a);
          } else {
            M[idx] = Math.min(1, M[idx]! + a * (0.5 + 0.5 * level));
            T[idx] = T[idx]! * (1 + 0.25 * a);
          }
          H[idx] = H[idx]! + 0.1 * a;
        }
      }
    }
  });
  return plan;
};
