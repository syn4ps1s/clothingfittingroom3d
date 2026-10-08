import type { CatalogData } from '@fitroom/shared';
import bottoms from './data/bottoms.json';
import dresses from './data/dresses.json';
import fabrics from './data/fabrics.json';
import outerwear from './data/outerwear.json';
import tops from './data/tops.json';
import { CATALOG_VERSION } from './version.js';
import { parseCatalogData } from './validate.js';

let cached: CatalogData | undefined;

/**
 * Datos del catálogo empaquetado, validados con `CatalogDataSchema` + reglas de integridad en la carga.
 * Falla de forma EXPLÍCITA (`CatalogDataError`) si los datos están corruptos: nunca devuelve un catálogo a medias.
 * El resultado es profundamente inmutable y se memoiza (la validación se paga una sola vez).
 */
export function loadCatalogData(): CatalogData {
  if (cached === undefined) {
    cached = parseCatalogData({
      version: CATALOG_VERSION,
      fabrics,
      garments: [...tops, ...bottoms, ...dresses, ...outerwear],
    });
  }
  return cached;
}
