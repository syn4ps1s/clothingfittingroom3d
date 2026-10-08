/**
 * @fitroom/catalog — datos de catálogo, repositorio en memoria, recomendación de talla y propuestas de prendas/conjuntos.
 * Paquete PURO (sin DOM, three ni React). Todo texto del catálogo debe renderizarse como TEXTO (nunca como HTML).
 */
export { CatalogDataError, SizingInputError, type CatalogIssue, type SizingErrorCode } from './errors.js';
export { loadCatalogData } from './loader.js';
export { CATALOG_VERSION } from './version.js';
export {
  CATALOG_LIMITS,
  CATEGORY_SLOT,
  CatalogDataStrictSchema,
  TEMPLATE_CATEGORY,
  hasUnsafeText,
  parseCatalogData,
  scanRawCatalog,
} from './validate.js';
export { createStaticCatalog, type GarmentFilter, type StaticCatalog } from './repository.js';
export { normalizeText } from './util.js';
export { recommendSize, type SizingInputEx } from './sizing/recommend.js';
export {
  DEFAULT_SCALE_CM,
  FIT_TOLERANCE_SCALE,
  TEMPLATE_PROFILES,
  VERDICT_BANDS,
  nominalEase,
  type EaseRule,
  type TemplateProfile,
} from './sizing/profiles.js';
export {
  TEMPLATE_PARAM_SPECS,
  templateParam,
  type ParamSpec,
} from './params.js';
export {
  fitQuality,
  garmentScore,
  rankGarments,
  rankGarmentsSync,
  resolveCatalogData,
  type CatalogSource,
  type RankOptions,
  type RankReason,
  type RankedGarment,
} from './outfits/rank.js';
export {
  suggestOutfits,
  suggestOutfitsSync,
  type OutfitItem,
  type OutfitOptions,
  type OutfitReason,
  type OutfitRole,
  type OutfitSuggestion,
} from './outfits/outfits.js';
export {
  classifyHarmony,
  colorfulness,
  hexToOklch,
  hueDistance,
  hueHarmony,
  pairHarmony,
  paletteOf,
  variantHarmony,
  type HarmonyKind,
  type Oklch,
  type PaletteColor,
} from './outfits/color.js';
export {
  CATALOG_TAGS,
  FORMALITY_TAGS,
  OCCASION_TAGS,
  SEASON_TAGS,
  STYLE_TAGS,
  assessOccasion,
  formalityLabel,
  formalityOf,
  type FormalityTag,
  type OccasionAssessment,
  type OccasionTag,
  type SeasonTag,
} from './outfits/tags.js';
