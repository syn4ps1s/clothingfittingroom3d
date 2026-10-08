import type {
  CatalogData,
  FabricDef,
  GarmentDefinition,
  Measurements,
  SizeRecommendation,
  SwatchVariant,
} from '@fitroom/shared';
import { clamp01, round } from '../util.js';
import {
  classifyHarmony,
  colorfulness,
  hexToOklch,
  hueDistance,
  paletteOf,
  variantHarmony,
  type HarmonyKind,
  type Oklch,
  type PaletteColor,
} from './color.js';
import {
  garmentScore,
  rankGarmentsSync,
  resolveCatalogData,
  type CatalogSource,
  type RankOptions,
  type RankedGarment,
} from './rank.js';
import { assessOccasion, type FormalityTag, type OccasionTag } from './tags.js';

export type OutfitRole = 'top' | 'bottom' | 'full' | 'outer';

export type OutfitReason =
  | 'neutral-palette'
  | 'accent-color'
  | 'monochrome-palette'
  | 'analogous-colors'
  | 'complementary-colors'
  | 'triadic-colors'
  | 'colors-clash'
  | 'pattern-clash'
  | 'consistent-formality'
  | 'formality-gap'
  | 'season-clash'
  | 'occasion-conflict'
  | 'shared-occasion'
  | 'good-fit-all'
  | 'layered';

export interface OutfitItem {
  readonly role: OutfitRole;
  readonly garment: GarmentDefinition;
  readonly fabric: FabricDef;
  /** muestra de color/estampado elegida para armonizar el conjunto */
  readonly variant: SwatchVariant;
  /** talla recomendada para esta persona y su explicación */
  readonly recommendation: SizeRecommendation;
  /** 0..1 */
  readonly fitScore: number;
}

export interface OutfitSuggestion {
  /** determinista: `prenda:muestra+prenda:muestra…` */
  readonly id: string;
  /** orden: [full | top, bottom], outer */
  readonly items: readonly OutfitItem[];
  /** 0..1 */
  readonly score: number;
  readonly breakdown: { readonly fit: number; readonly color: number; readonly occasion: number };
  readonly harmony: { readonly kind: HarmonyKind; readonly score: number };
  readonly formality: FormalityTag;
  readonly occasionTags: readonly OccasionTag[];
  readonly reasons: readonly OutfitReason[];
}

export interface OutfitOptions extends Pick<RankOptions, 'preference' | 'sigmaCm' | 'occasion'> {
  /** nº máximo de conjuntos (por defecto 6) */
  readonly limit?: number;
  /** 'auto' añade una prenda exterior si mejora el conjunto (por defecto), 'always' la exige, 'never' la excluye */
  readonly outer?: 'auto' | 'always' | 'never';
  /** veces máximas que una misma prenda puede repetirse en la lista (por defecto 2) */
  readonly maxPerGarment?: number;
  /** prendas candidatas por ranura (por defecto 8) */
  readonly poolSize?: number;
  /** puntuación mínima de ajuste individual para entrar en un conjunto (por defecto 0,45) */
  readonly minFitScore?: number;
}

const W_FIT = 0.4;
const W_COLOR = 0.35;
const W_OCCASION = 0.25;
const LAYER_BONUS = 0.02;
/** Croma OKLCH a partir del cual un color se considera estridente, y lo que resta cada uno. */
const LOUD_CHROMA = 0.16;
const LOUD_PENALTY = 0.04;
/** Penalización por cada vez que una prenda ya aparece en conjuntos elegidos (fomenta variedad en la lista). */
const DIVERSITY_PENALTY = 0.05;

interface Cell {
  readonly variant: SwatchVariant;
  readonly palette: readonly PaletteColor[];
  readonly base: Oklch;
  readonly patterned: boolean;
}

interface Candidate {
  /** identificador numérico único en la llamada (clave de la caché de pares) */
  readonly uid: number;
  readonly role: OutfitRole;
  readonly ranked: RankedGarment;
  readonly fit: number;
  readonly cells: readonly Cell[];
}

interface HarmonyEval {
  readonly score: number;
  readonly kind: HarmonyKind;
  readonly patternClash: boolean;
  readonly choice: readonly number[];
}

/** Pares evaluados y su peso para 1–3 prendas (la prenda principal manda; el exterior pesa menos). */
function pairsFor(n: number): readonly (readonly [number, number, number])[] {
  if (n === 2) return [[0, 1, 1]];
  if (n === 3)
    return [
      [0, 1, 0.5],
      [0, 2, 0.25],
      [1, 2, 0.25],
    ];
  return [];
}

/** Mejor combinación de muestras (una por prenda) para un conjunto de candidatos. Determinista (empates: índices menores). */
function bestVariants(items: readonly Candidate[], pairCache: Map<number, number>): HarmonyEval {
  const n = items.length;
  const pairs = pairsFor(n);
  const choice = new Array<number>(n).fill(0);
  let best: HarmonyEval | undefined;

  const pairScore = (ia: number, va: number, ib: number, vb: number): number => {
    const a = items[ia]!;
    const b = items[ib]!;
    const key = (a.uid * 16 + va) * 65536 + (b.uid * 16 + vb);
    let v = pairCache.get(key);
    if (v === undefined) {
      v = variantHarmony(a.cells[va]!.palette, b.cells[vb]!.palette);
      pairCache.set(key, v);
    }
    return v;
  };

  const evaluate = (): void => {
    let weighted = 0;
    let wsum = 0;
    for (const [i, j, w] of pairs) {
      weighted += w * pairScore(i, choice[i]!, j, choice[j]!);
      wsum += w;
    }
    let score = wsum > 0 ? weighted / wsum : 0.9; // una sola prenda: sin pares que chocar
    const cells = items.map((it, i) => it.cells[choice[i]!]!);
    const patterned = cells.filter((c) => c.patterned).length;
    const patternClash = patterned >= 2;
    if (patternClash) score *= patterned >= 3 ? 0.5 : 0.72;

    const bases = cells.map((c) => c.base);
    const kind = classifyHarmony(bases);
    // más de dos familias cromáticas distintas: conjunto «de feria»
    const hues: number[] = [];
    for (const c of bases.filter((b) => colorfulness(b) >= 0.5)) {
      if (!hues.some((h) => hueDistance(h, c.h) <= 35)) hues.push(c.h);
    }
    if (hues.length > 2) score *= 0.8;
    // colores estridentes (croma muy alto) restan un poco: a igualdad de armonía gana la opción sobria
    score -= LOUD_PENALTY * bases.filter((b) => b.c > LOUD_CHROMA).length;
    if (kind === 'clash') score *= 0.85;
    score = clamp01(score);

    if (best === undefined || score > best.score + 1e-12) {
      best = { score, kind, patternClash, choice: [...choice] };
    }
  };

  const recurse = (depth: number): void => {
    if (depth === n) {
      evaluate();
      return;
    }
    for (let v = 0; v < items[depth]!.cells.length; v++) {
      choice[depth] = v;
      recurse(depth + 1);
    }
  };
  recurse(0);
  return best!;
}

function fitOf(items: readonly Candidate[]): number {
  const scores = items.map((i) => i.fit);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  return 0.5 * mean + 0.5 * Math.min(...scores);
}

interface Assessment {
  readonly fit: number;
  readonly occasion: ReturnType<typeof assessOccasion>;
  readonly layered: boolean;
  readonly total: number;
}

/** Puntuación (barata, sin construir objetos) de un conjunto con su mejor combinación de muestras. */
function assess(items: readonly Candidate[], harmony: HarmonyEval): Assessment {
  const occasion = assessOccasion(items.map((i) => i.ranked.garment));
  const fit = fitOf(items);
  const layered = items.some((i) => i.role === 'outer');
  const total = clamp01(
    W_FIT * fit +
      W_COLOR * harmony.score +
      W_OCCASION * occasion.score +
      (layered ? LAYER_BONUS : 0),
  );
  return { fit, occasion, layered, total };
}

interface Built {
  readonly suggestion: OutfitSuggestion;
  readonly garmentIds: readonly string[];
}

function build(items: readonly Candidate[], harmony: HarmonyEval, a: Assessment): Built {
  const { occasion, fit, layered, total } = a;
  const outfitItems: OutfitItem[] = items.map((it, i) => ({
    role: it.role,
    garment: it.ranked.garment,
    fabric: it.ranked.fabric,
    variant: it.cells[harmony.choice[i]!]!.variant,
    recommendation: it.ranked.recommendation,
    fitScore: it.fit,
  }));

  const reasons: OutfitReason[] = [];
  const kindReason: Record<HarmonyKind, OutfitReason> = {
    neutral: 'neutral-palette',
    accent: 'accent-color',
    monochrome: 'monochrome-palette',
    analogous: 'analogous-colors',
    complementary: 'complementary-colors',
    triadic: 'triadic-colors',
    clash: 'colors-clash',
  };
  reasons.push(kindReason[harmony.kind]);
  if (harmony.patternClash) reasons.push('pattern-clash');
  if (occasion.formalitySpread <= 0.5) reasons.push('consistent-formality');
  else if (occasion.formalitySpread >= 1) reasons.push('formality-gap');
  if (occasion.seasonClash) reasons.push('season-clash');
  if (occasion.occasionConflict) reasons.push('occasion-conflict');
  if (occasion.sharedOccasions.length > 0) reasons.push('shared-occasion');
  if (items.every((i) => i.fit >= 0.85)) reasons.push('good-fit-all');
  if (layered) reasons.push('layered');

  return {
    garmentIds: items.map((i) => i.ranked.garment.id),
    suggestion: Object.freeze({
      id: outfitItems.map((o) => `${o.garment.id}:${o.variant.id}`).join('+'),
      items: Object.freeze(outfitItems.map((o) => Object.freeze(o))),
      score: round(total, 4),
      breakdown: Object.freeze({
        fit: round(fit, 4),
        color: round(harmony.score, 4),
        occasion: round(occasion.score, 4),
      }),
      harmony: Object.freeze({ kind: harmony.kind, score: round(harmony.score, 4) }),
      formality: occasion.formality,
      occasionTags: Object.freeze([...occasion.sharedOccasions]),
      reasons: Object.freeze(reasons),
    }),
  };
}

function toCandidate(
  uid: number,
  role: OutfitRole,
  ranked: RankedGarment,
  preference: OutfitOptions['preference'],
): Candidate {
  return {
    uid,
    role,
    ranked,
    fit: garmentScore(ranked.recommendation, preference ?? 'regular'),
    cells: ranked.garment.variants.map((variant) => ({
      variant,
      palette: paletteOf(variant),
      base: hexToOklch(variant.color),
      patterned: variant.pattern.type !== 'solid',
    })),
  };
}

/**
 * Conjuntos completos (superior + inferior, o vestido; con prenda exterior opcional) para unas medidas.
 * Cada prenda lleva su talla recomendada; las muestras se eligen para que los colores armonicen
 * (neutros, análogos, complementarios; penaliza choques y estampados enfrentados) y se puntúa la coherencia de
 * ocasión (formalidad, estación, ocasiones incompatibles). Determinista: mismas entradas → mismo orden.
 */
export function suggestOutfitsSync(
  data: CatalogData,
  measurements: Measurements,
  opts: OutfitOptions = {},
): readonly OutfitSuggestion[] {
  const preference = opts.preference ?? 'regular';
  const limit = Math.max(0, Math.floor(opts.limit ?? 6));
  const poolSize = Math.max(1, Math.floor(opts.poolSize ?? 8));
  const minFit = opts.minFitScore ?? 0.45;
  const maxPer = Math.max(1, Math.floor(opts.maxPerGarment ?? 2));
  const outerMode = opts.outer ?? 'auto';

  const ranked = rankGarmentsSync(data, measurements, {
    preference,
    ...(opts.sigmaCm ? { sigmaCm: opts.sigmaCm } : {}),
    ...(opts.occasion ? { occasion: opts.occasion } : {}),
  });
  const wearable = ranked.filter(
    (r) =>
      r.recommendation.overall !== 'too-tight' &&
      r.recommendation.overall !== 'too-loose' &&
      garmentScore(r.recommendation, preference) >= minFit,
  );
  let uid = 0;
  const pool = (slot: GarmentDefinition['slot'], role: OutfitRole): Candidate[] =>
    wearable
      .filter((r) => r.garment.slot === slot)
      .slice(0, poolSize)
      .map((r) => toCandidate(uid++, role, r, preference));
  const uppers = pool('upper', 'top');
  const lowers = pool('lower', 'bottom');
  const fulls = pool('full', 'full');
  const outers = outerMode === 'never' ? [] : pool('outer', 'outer');

  const bases: Candidate[][] = [];
  for (const u of uppers) for (const l of lowers) bases.push([u, l]);
  for (const f of fulls) bases.push([f]);

  interface Option {
    readonly items: readonly Candidate[];
    readonly harmony: HarmonyEval;
    readonly assessment: Assessment;
    readonly key: string;
  }
  const better = (a: Option, b: Option | undefined): boolean =>
    b === undefined ||
    a.assessment.total > b.assessment.total + 1e-12 ||
    (Math.abs(a.assessment.total - b.assessment.total) <= 1e-12 && a.key < b.key);

  const pairCache = new Map<number, number>();
  const candidates: Built[] = [];
  for (const base of bases) {
    const optionOf = (items: readonly Candidate[]): Option => {
      const harmony = bestVariants(items, pairCache);
      return {
        items,
        harmony,
        assessment: assess(items, harmony),
        key: items
          .map((i, k) => `${i.ranked.garment.id}:${i.cells[harmony.choice[k]!]!.variant.id}`)
          .join('+'),
      };
    };
    const plain = optionOf(base);
    let bestLayered: Option | undefined;
    for (const outer of outers) {
      const option = optionOf([...base, outer]);
      if (better(option, bestLayered)) bestLayered = option;
    }
    let chosen: Option | undefined = outerMode === 'always' && bestLayered ? undefined : plain;
    if (
      bestLayered &&
      (chosen === undefined || bestLayered.assessment.total >= chosen.assessment.total - 0.005)
    ) {
      chosen = bestLayered;
    }
    if (chosen) candidates.push(build(chosen.items, chosen.harmony, chosen.assessment));
  }

  candidates.sort(
    (a, b) =>
      b.suggestion.score - a.suggestion.score ||
      (a.suggestion.id < b.suggestion.id ? -1 : a.suggestion.id > b.suggestion.id ? 1 : 0),
  );
  // Selección voraz con diversidad: cada repetición de una prenda ya elegida resta DIVERSITY_PENALTY a la puntuación.
  const used = new Map<string, number>();
  const out: OutfitSuggestion[] = [];
  const remaining = [...candidates];
  while (out.length < limit && remaining.length > 0) {
    let pick = -1;
    let pickValue = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i]!;
      if (c.garmentIds.some((id) => (used.get(id) ?? 0) >= maxPer)) continue;
      const repeats = c.garmentIds.reduce((sum, id) => sum + (used.get(id) ?? 0), 0);
      const value = c.suggestion.score - DIVERSITY_PENALTY * repeats;
      if (value > pickValue + 1e-12) {
        pick = i;
        pickValue = value;
      }
    }
    if (pick < 0) break;
    const [chosenOne] = remaining.splice(pick, 1);
    for (const id of chosenOne!.garmentIds) used.set(id, (used.get(id) ?? 0) + 1);
    out.push(chosenOne!.suggestion);
  }
  return Object.freeze(out);
}

/** Igual que `suggestOutfitsSync`, aceptando cualquier fuente de catálogo (datos o repositorio asíncrono). */
export async function suggestOutfits(
  catalog: CatalogSource,
  measurements: Measurements,
  opts: OutfitOptions = {},
): Promise<readonly OutfitSuggestion[]> {
  return suggestOutfitsSync(await resolveCatalogData(catalog), measurements, opts);
}
