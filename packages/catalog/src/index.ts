import {
  NotImplementedError,
  type CatalogData,
  type CatalogRepository,
  type SizeRecommendation,
  type SizingInput,
} from '@fitroom/shared';

/** Datos del catálogo (validados con CatalogDataSchema). STUB — agente CATALOG. */
export function loadCatalogData(): CatalogData {
  throw new NotImplementedError('catalog.loadCatalogData');
}

export function createStaticCatalog(_data?: CatalogData): CatalogRepository {
  throw new NotImplementedError('catalog.createStaticCatalog');
}

/** Recomendación de talla con confianza. STUB — agente CATALOG. */
export function recommendSize(_input: SizingInput): SizeRecommendation {
  throw new NotImplementedError('catalog.recommendSize');
}
