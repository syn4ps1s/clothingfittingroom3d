import type { GarmentDefinition } from '@fitroom/shared';

/**
 * Vocabulario CERRADO de etiquetas (`GarmentDefinition.tags`). Los datos del catálogo sólo usan estas;
 * la UI puede mostrarlas como filtros (con su traducción en i18n).
 */
export const FORMALITY_TAGS = { casual: 0, 'smart-casual': 1, formal: 2 } as const;
export type FormalityTag = keyof typeof FORMALITY_TAGS;

export const SEASON_TAGS = ['summer', 'winter', 'all-season'] as const;
export type SeasonTag = (typeof SEASON_TAGS)[number];

/** Ocasiones: se pueden pedir como filtro (`occasion`). */
export const OCCASION_TAGS = ['office', 'weekend', 'evening', 'beach', 'outdoor'] as const;
export type OccasionTag = (typeof OCCASION_TAGS)[number];

export const STYLE_TAGS = ['essential', 'classic', 'layering', 'minimal'] as const;

export const CATALOG_TAGS: readonly string[] = [
  ...Object.keys(FORMALITY_TAGS),
  ...SEASON_TAGS,
  ...OCCASION_TAGS,
  ...STYLE_TAGS,
];

/** Pares de ocasiones incompatibles en un mismo conjunto. */
const CONFLICTS: readonly (readonly [string, string])[] = [
  ['beach', 'office'],
  ['beach', 'formal'],
  ['beach', 'evening'],
];

/** Formalidad media de una prenda (0 casual … 2 formal); 0,5 si no declara ninguna. */
export function formalityOf(garment: Pick<GarmentDefinition, 'tags'>): number {
  const levels: number[] = [];
  for (const tag of garment.tags) {
    if (Object.hasOwn(FORMALITY_TAGS, tag)) levels.push(FORMALITY_TAGS[tag as FormalityTag]);
  }
  return levels.length === 0 ? 0.5 : levels.reduce((a, b) => a + b, 0) / levels.length;
}

export function formalityLabel(level: number): FormalityTag {
  return level < 0.5 ? 'casual' : level < 1.35 ? 'smart-casual' : 'formal';
}

export interface OccasionAssessment {
  /** 0..1 */
  readonly score: number;
  readonly formality: FormalityTag;
  readonly formalitySpread: number;
  /** ocasiones compartidas por TODAS las prendas */
  readonly sharedOccasions: readonly OccasionTag[];
  readonly seasonClash: boolean;
  readonly occasionConflict: boolean;
}

/** Coherencia de ocasión de un conjunto: formalidad homogénea, misma estación y sin ocasiones incompatibles. */
export function assessOccasion(garments: readonly Pick<GarmentDefinition, 'tags'>[]): OccasionAssessment {
  const levels = garments.map(formalityOf);
  const spread = Math.max(...levels) - Math.min(...levels);
  const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
  const formalityFactor = spread <= 0.5 ? 1 : Math.max(0.2, 1 - 0.55 * (spread - 0.5) ** 1.1 * 1.4);

  const has = (tag: string) => garments.some((g) => g.tags.includes(tag));
  const seasonClash = has('summer') && has('winter');
  const occasionConflict = CONFLICTS.some(([a, b]) => has(a) && has(b));
  const shared = OCCASION_TAGS.filter((o) => garments.every((g) => g.tags.includes(o)));

  let score = formalityFactor;
  if (seasonClash) score *= 0.3;
  if (occasionConflict) score *= 0.5;
  if (shared.length > 0) score = Math.min(1, score + 0.08);
  return {
    score: Math.max(0, Math.min(1, score)),
    formality: formalityLabel(mean),
    formalitySpread: spread,
    sharedOccasions: shared,
    seasonClash,
    occasionConflict,
  };
}
