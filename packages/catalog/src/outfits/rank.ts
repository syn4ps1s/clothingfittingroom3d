import type {
  CatalogData,
  CatalogRepository,
  FabricDef,
  FitPreference,
  FitVerdict,
  GarmentCategory,
  GarmentDefinition,
  GarmentSlot,
  Measurements,
  SizeRecommendation,
  SizingInput,
} from '@fitroom/shared';
import { clamp01, round } from '../util.js';
import { recommendSize } from '../sizing/recommend.js';
import { createStaticCatalog } from '../repository.js';
import type { OccasionTag } from './tags.js';

/** Fuente de catálogo: datos validados (síncrono) o cualquier repositorio (asíncrono). */
export type CatalogSource = CatalogData | CatalogRepository;

export type RankReason =
  | 'good-fit'
  | 'snug-fit'
  | 'roomy-fit'
  | 'poor-fit'
  | 'between-sizes'
  | 'out-of-size-range'
  | 'height-mismatch'
  | 'uncertain-measurements';

export interface RankedGarment {
  /** 1 = la mejor propuesta */
  readonly rank: number;
  readonly garment: GarmentDefinition;
  readonly fabric: FabricDef;
  /** talla recomendada y su explicación */
  readonly recommendation: SizeRecommendation;
  /** 0..1: calidad del ajuste ponderada por la confianza */
  readonly score: number;
  /** motivos (códigos) para que la UI los traduzca */
  readonly reasons: readonly RankReason[];
}

export interface RankOptions {
  readonly preference?: FitPreference;
  readonly sigmaCm?: SizingInput['sigmaCm'];
  readonly category?: GarmentCategory;
  readonly slot?: GarmentSlot;
  /** sólo prendas etiquetadas con esta ocasión */
  readonly occasion?: OccasionTag;
  /** descarta propuestas con puntuación inferior (por defecto 0: se devuelven todas) */
  readonly minScore?: number;
  readonly limit?: number;
}

/** Calidad por veredicto respecto a la preferencia: lo ideal es «good» (o algo ceñido/holgado si así se prefiere). */
const VERDICT_ORD: Readonly<Record<FitVerdict, number>> = {
  'too-tight': -2,
  snug: -1,
  good: 0,
  roomy: 1,
  'too-loose': 2,
};
const PREFERENCE_TARGET: Readonly<Record<FitPreference, number>> = { snug: -0.5, regular: 0, roomy: 0.5 };

export function fitQuality(overall: FitVerdict, preference: FitPreference = 'regular'): number {
  const d = Math.abs(VERDICT_ORD[overall] - PREFERENCE_TARGET[preference]);
  return Math.exp(-0.45 * d * d);
}

function reasonsOf(rec: SizeRecommendation): RankReason[] {
  const out: RankReason[] = [];
  if (rec.overall === 'good') out.push('good-fit');
  else if (rec.overall === 'snug') out.push('snug-fit');
  else if (rec.overall === 'roomy') out.push('roomy-fit');
  else out.push('poor-fit');
  if (rec.notes.includes('between-sizes')) out.push('between-sizes');
  if (rec.notes.includes('below-smallest-size') || rec.notes.includes('above-largest-size')) {
    out.push('out-of-size-range');
  }
  if (rec.notes.includes('height-out-of-range')) out.push('height-mismatch');
  if (rec.notes.includes('low-measurement-confidence')) out.push('uncertain-measurements');
  return out;
}

export function garmentScore(rec: SizeRecommendation, preference: FitPreference = 'regular'): number {
  let notes = 1;
  if (rec.notes.includes('below-smallest-size') || rec.notes.includes('above-largest-size')) notes *= 0.5;
  if (rec.notes.includes('height-out-of-range')) notes *= 0.9;
  return round(clamp01(fitQuality(rec.overall, preference) * (0.55 + 0.45 * rec.confidence) * notes), 4);
}

/** Núcleo síncrono y puro: ordena las prendas de unos datos de catálogo para unas medidas. */
export function rankGarmentsSync(
  data: CatalogData,
  measurements: Measurements,
  opts: RankOptions = {},
): readonly RankedGarment[] {
  const fabrics = new Map<string, FabricDef>(data.fabrics.map((f) => [f.id, f]));
  const preference = opts.preference ?? 'regular';
  const minScore = opts.minScore ?? 0;
  const scored: { garment: GarmentDefinition; order: number; recommendation: SizeRecommendation; score: number }[] = [];
  data.garments.forEach((garment, order) => {
    if (opts.category !== undefined && garment.category !== opts.category) return;
    if (opts.slot !== undefined && garment.slot !== opts.slot) return;
    if (opts.occasion !== undefined && !garment.tags.includes(opts.occasion)) return;
    const fabric = fabrics.get(garment.fabricId)!;
    const recommendation = recommendSize({
      garment,
      measurements,
      preference,
      ...(opts.sigmaCm ? { sigmaCm: opts.sigmaCm } : {}),
      fabric,
    });
    const score = garmentScore(recommendation, preference);
    if (score >= minScore) scored.push({ garment, order, recommendation, score });
  });
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.recommendation.confidence - a.recommendation.confidence ||
      a.order - b.order,
  );
  const limited = opts.limit !== undefined ? scored.slice(0, Math.max(0, Math.floor(opts.limit))) : scored;
  return Object.freeze(
    limited.map((r, i) =>
      Object.freeze({
        rank: i + 1,
        garment: r.garment,
        fabric: fabrics.get(r.garment.fabricId)!,
        recommendation: r.recommendation,
        score: r.score,
        reasons: Object.freeze(reasonsOf(r.recommendation)),
      }),
    ),
  );
}

function isRepository(source: CatalogSource): source is CatalogRepository {
  return typeof (source as CatalogRepository).listGarments === 'function';
}

/** Resuelve cualquier fuente de catálogo a datos validados (para uso síncrono). */
export async function resolveCatalogData(source: CatalogSource): Promise<CatalogData> {
  if (!isRepository(source)) return source;
  const withData = (source as { data?: CatalogData }).data;
  if (withData) return withData;
  const [garments, fabrics] = await Promise.all([source.listGarments(), source.listFabrics()]);
  // Se revalida como cualquier dato externo (un repositorio remoto es una frontera de confianza).
  return createStaticCatalog({ version: 1, fabrics: [...fabrics], garments: [...garments] }).data;
}

/**
 * Prendas del catálogo ordenadas por ajuste y confianza para unas medidas, cada una con su talla recomendada.
 * Determinista. Lanza `SizingInputError` si las medidas son inválidas.
 */
export async function rankGarments(
  catalog: CatalogSource,
  measurements: Measurements,
  opts: RankOptions = {},
): Promise<readonly RankedGarment[]> {
  return rankGarmentsSync(await resolveCatalogData(catalog), measurements, opts);
}
