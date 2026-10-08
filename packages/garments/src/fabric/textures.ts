import {
  FabricSchema,
  SwatchVariantSchema,
  type FabricDef,
  type SwatchVariant,
} from '@fitroom/shared';
import { encodeSrgb8, hexToLinear } from './color.js';
import { blurRowsH, normalAoBand, packRgba, type NormalAoParams } from './maps.js';
import { normalizeSeed, seedFromString } from './prng.js';
import { buildPatternSteps } from './patterns.js';
import { FAMILY_BUILDERS } from './families/index.js';
import type {
  FabricTextureInfo,
  FabricTextureResult,
  FamilyContext,
  Fields,
  Step,
} from './types.js';

/** Error tipado para entradas inválidas (telas/muestras/tamaños fuera de contrato). */
export class FabricInputError extends Error {
  readonly issues: readonly string[];
  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = 'FabricInputError';
    this.issues = issues;
  }
}

/** Tamaños aceptados en tiempo de ejecución: potencias de 2 entre 16 y 4096 (el contrato público usa 512/1024/2048). */
export function isValidTextureSize(n: number): boolean {
  return Number.isInteger(n) && n >= 16 && n <= 4096 && (n & (n - 1)) === 0;
}

export interface TexturePlan {
  readonly steps: readonly Step[];
  result(): FabricTextureResult;
}

/** Filas por paso: ~16 k píxeles por paso (≈1–3 ms) para poder ceder al event loop con granularidad fina. */
function rowsPerBand(size: number): number {
  return Math.max(1, Math.min(size, Math.floor(16384 / size)));
}

/** Semilla por defecto: determinista a partir de los ids de tela y muestra. */
export function defaultSeed(fabric: FabricDef, variant: SwatchVariant): number {
  return seedFromString(`${fabric.id}|${variant.id}`);
}

/**
 * Prepara el trabajo completo como una lista de pasos acotados. La versión síncrona los ejecuta
 * seguidos; la asíncrona cede al event loop entre pasos. El resultado es idéntico bit a bit.
 */
export function planFabricTextures(
  fabricIn: FabricDef,
  variantIn: SwatchVariant,
  size: number,
  seedIn?: number,
): TexturePlan {
  if (!isValidTextureSize(size)) {
    throw new FabricInputError(`size inválido: ${size} (potencia de 2 entre 16 y 4096)`);
  }
  const fp = FabricSchema.safeParse(fabricIn);
  if (!fp.success) {
    throw new FabricInputError(
      'FabricDef inválido',
      fp.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }
  const vp = SwatchVariantSchema.safeParse(variantIn);
  if (!vp.success) {
    throw new FabricInputError(
      'SwatchVariant inválido',
      vp.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }
  const fabric = fp.data;
  const variant = vp.data;
  const seed = normalizeSeed(seedIn, defaultSeed(fabric, variant));

  const S = size;
  const px = S * S;
  const fields: Fields = {
    size: S,
    H: new Float32Array(px),
    T: new Float32Array(px),
    M: new Float32Array(px),
    R: new Float32Array(px),
  };
  const steps: Step[] = [];
  const band = rowsPerBand(S);
  const ctx: FamilyContext = {
    fabric,
    variant,
    size: S,
    seed,
    fields,
    rowsPerBand: band,
    base: hexToLinear(variant.color),
    push: (s) => steps.push(s),
    bands: (fn) => {
      for (let y0 = 0; y0 < S; y0 += band) {
        const y1 = Math.min(S, y0 + band);
        steps.push(() => fn(y0, y1));
      }
    },
  };

  const plan = FAMILY_BUILDERS[fabric.family](ctx);

  // ---- patrón (estampado / hilo teñido) ----
  const patternRes = buildPatternSteps(ctx, plan, variant.pattern);

  // ---- normalización de tono medio (respeta variant.color) ----
  let toneScale = 1;
  if (plan.normalizeTone) {
    const partial: number[] = [];
    ctx.bands((y0, y1) => {
      let s = 0;
      for (let i = y0 * S; i < y1 * S; i++) s += fields.T[i]!;
      partial.push(s);
    });
    steps.push(() => {
      let tot = 0;
      for (const p of partial) tot += p;
      const mean = tot / px;
      toneScale = mean > 1e-6 ? 1 / mean : 1;
    });
  }

  // ---- reliefe → AO + normal ----
  // intensidad ligada a la tela: más grueso/pesado = relieve más marcado
  const reliefFactor = Math.min(1.5, Math.max(0.65, Math.pow(fabric.thicknessMm / 1.2, 0.3)));
  const normalStrength = plan.normalStrength * reliefFactor;
  const Hb = new Float32Array(px);
  const normal = new Uint8Array(px * 4);
  const normal32 = new Uint32Array(normal.buffer);
  const aoBytes = new Uint8Array(px);
  const aoRadius = Math.max(1, Math.min(S >> 2, plan.aoRadiusPx));
  const nap: NormalAoParams = {
    size: S,
    strength: normalStrength,
    bumpUnitPx: plan.bumpUnitPx,
    aoStrength: plan.aoStrength,
    aoRadius,
  };
  ctx.bands((y0, y1) => blurRowsH(fields.H, Hb, S, aoRadius, y0, y1));
  const colSum = new Float32Array(S);
  ctx.bands((y0, y1) => normalAoBand(fields.H, Hb, nap, y0, y1, normal32, aoBytes, colSum));

  // ---- albedo ----
  const albedo = new Uint8Array(px * 4);
  const albedo32 = new Uint32Array(albedo.buffer);
  const base = ctx.base;
  const c2 = patternRes.color2;
  const c3 = patternRes.color3;
  const m1 = patternRes.mask1;
  const m2 = patternRes.mask2;
  const sec = plan.secondary;
  // camino rápido (sin patrón ni color secundario): una tabla tono → RGBA empaquetado
  const LQ = 2048;
  const LMAX = LQ * 3;
  let lut: Uint32Array | null = null;
  if (!m1 && !m2 && !sec) {
    steps.push(() => {
      lut = new Uint32Array(LMAX + 1);
      for (let k = 0; k <= LMAX; k++) {
        const t = k / LQ;
        lut[k] = packRgba(
          encodeSrgb8(base[0] * t),
          encodeSrgb8(base[1] * t),
          encodeSrgb8(base[2] * t),
          255,
        );
      }
    });
  }
  ctx.bands((y0, y1) => {
    const { T, M } = fields;
    if (lut) {
      const table = lut;
      for (let i = y0 * S; i < y1 * S; i++) {
        let ti = (T[i]! * toneScale * LQ) | 0;
        ti = ti < 0 ? 0 : ti > LMAX ? LMAX : ti;
        albedo32[i] = table[ti]!;
      }
      return;
    }
    for (let i = y0 * S; i < y1 * S; i++) {
      let r = base[0];
      let g = base[1];
      let b = base[2];
      if (m1 && c2) {
        const a = m1[i]!;
        r += (c2[0] - r) * a;
        g += (c2[1] - g) * a;
        b += (c2[2] - b) * a;
      }
      if (m2 && c3) {
        const a = m2[i]!;
        r += (c3[0] - r) * a;
        g += (c3[1] - g) * a;
        b += (c3[2] - b) * a;
      }
      if (sec) {
        const k = M[i]! * sec.k;
        r += (sec.target[0] - r) * k;
        g += (sec.target[1] - g) * k;
        b += (sec.target[2] - b) * k;
      }
      const t = T[i]! * toneScale;
      albedo32[i] = packRgba(encodeSrgb8(r * t), encodeSrgb8(g * t), encodeSrgb8(b * t), 255);
    }
  });

  // ---- ORM ----
  const orm = new Uint8Array(px * 4);
  const orm32 = new Uint32Array(orm.buffer);
  const roughBase = plan.roughnessBase ?? fabric.roughness;
  const sheenGloss = 0.12 * fabric.sheen;
  const metalByte = Math.round(Math.min(1, Math.max(0, plan.metal)) * 255);
  ctx.bands((y0, y1) => {
    const { R, H } = fields;
    for (let i = y0 * S; i < y1 * S; i++) {
      let r = roughBase + R[i]! - sheenGloss * (H[i]! - 0.5);
      r = r < 0.04 ? 0.04 : r > 1 ? 1 : r;
      orm32[i] = packRgba(aoBytes[i]!, (r * 255 + 0.5) | 0, metalByte, 255);
    }
  });

  const info: FabricTextureInfo = {
    family: fabric.family,
    seed,
    size: S,
    requestedThreadsAcrossTile: fabric.threadsPerCm * fabric.tileCm,
    threadsAcrossTile: plan.threadsAcrossTile,
    threadsAlongTile: plan.threadsAlongTile,
    pxPerThread: plan.pxPerThread,
    effectiveThreadsPerCm: plan.threadsAcrossTile / fabric.tileCm,
    frequencyLowered: plan.threadsAcrossTile < fabric.threadsPerCm * fabric.tileCm * 0.97,
    weaveRepeat: plan.weaveRepeat,
    normalStrength,
    ...(patternRes.info ? { pattern: patternRes.info } : {}),
  };

  return {
    steps,
    result: () => ({
      size: S,
      albedo,
      normal,
      orm,
      tileMeters: fabric.tileCm / 100,
      info,
    }),
  };
}

/**
 * Texturas PBR procedurales (albedo sRGB, normal tangent-space OpenGL, ORM) de un par tela+muestra.
 * Tileable, con escala física real (`tileMeters = tileCm/100`). Determinista para una `seed` dada
 * (por defecto se deriva de los ids de tela y muestra).
 */
export function generateFabricTextures(
  fabric: FabricDef,
  variant: SwatchVariant,
  size: 512 | 1024 | 2048,
  seed?: number,
): FabricTextureResult {
  const plan = planFabricTextures(fabric, variant, size, seed);
  for (const step of plan.steps) step();
  return plan.result();
}

export interface AsyncOptions {
  /** presupuesto de CPU por porción antes de ceder al event loop (ms). Por defecto 6. */
  readonly sliceMs?: number;
  readonly signal?: AbortSignal;
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Misma salida que {@link generateFabricTextures}, pero cede al event loop por bandas (no bloquea el hilo principal). */
export async function generateFabricTexturesAsync(
  fabric: FabricDef,
  variant: SwatchVariant,
  size: 512 | 1024 | 2048,
  seed?: number,
  options: AsyncOptions = {},
): Promise<FabricTextureResult> {
  const plan = planFabricTextures(fabric, variant, size, seed);
  const slice = options.sliceMs ?? 6;
  let t0 = performance.now();
  for (const step of plan.steps) {
    options.signal?.throwIfAborted();
    step();
    if (performance.now() - t0 >= slice) {
      await yieldToEventLoop();
      t0 = performance.now();
    }
  }
  options.signal?.throwIfAborted();
  return plan.result();
}
