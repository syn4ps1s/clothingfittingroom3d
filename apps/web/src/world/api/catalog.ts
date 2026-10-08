import { useMemo } from 'react';
import {
  NotImplementedError,
  type CatalogData,
  type FabricDef,
  type FitDimension,
  type FitVerdict,
  type GarmentDefinition,
  type Measurements,
  type SizeRecommendation,
  type SizingInput,
} from '@fitroom/shared';
import { loadCatalogData, recommendSize as realRecommend } from '@fitroom/catalog';
import { READY } from 'virtual:fitroom-status';
import { appParams } from '../../app/params';
import type { EquippedItem } from '../../contracts';
import type { Worn } from '../../state/wardrobe';
import { wornEntries } from '../../state/wardrobe';
import { DEV_CATALOG } from '../dev/fixtures';
import { evaluateSizeFallback, recommendSizeFallback } from '../dev/recommend';

export interface FitEvaluation {
  readonly overall: FitVerdict;
  readonly dimensions: readonly FitDimension[];
}

export interface CatalogApi {
  readonly source: 'real' | 'dev';
  readonly data: CatalogData;
  fabric(id: string): FabricDef | undefined;
  garment(id: string): GarmentDefinition | undefined;
  /** Talla recomendada con confianza. */
  recommend(
    garment: GarmentDefinition,
    measurements: Measurements,
    sigmaCm?: SizingInput['sigmaCm'],
  ): SizeRecommendation;
  /** Veredicto por zona para UNA talla concreta (la elegida por la persona). */
  evaluate(
    garment: GarmentDefinition,
    sizeLabel: string,
    measurements: Measurements,
    sigmaCm?: SizingInput['sigmaCm'],
  ): FitEvaluation;
}

let warned = false;
const warnOnce = (what: string, err: unknown) => {
  if (!warned) {
    warned = true;
    console.warn(`${what} no está disponible; uso el respaldo de desarrollo.`, err);
  }
};

function build(data: CatalogData, source: 'real' | 'dev'): CatalogApi {
  const fabrics = new Map(data.fabrics.map((f) => [f.id, f]));
  const garments = new Map(data.garments.map((g) => [g.id, g]));
  const useRealSizing = source === 'real';
  return {
    source,
    data,
    fabric: (id) => fabrics.get(id),
    garment: (id) => garments.get(id),
    recommend(garment, measurements, sigmaCm) {
      if (useRealSizing) {
        try {
          return realRecommend({ garment, measurements, sigmaCm });
        } catch (err) {
          if (!(err instanceof NotImplementedError)) warnOnce('recommendSize', err);
        }
      }
      return recommendSizeFallback({ garment, measurements, sigmaCm });
    },
    evaluate(garment, sizeLabel, measurements, sigmaCm) {
      const size = garment.sizes.find((s) => s.label === sizeLabel) ?? garment.sizes[0]!;
      if (useRealSizing) {
        try {
          // Tabla de una sola talla: el tallaje oficial devuelve las zonas de ESA talla.
          const r = realRecommend({ garment: { ...garment, sizes: [size] }, measurements, sigmaCm });
          return { overall: r.overall, dimensions: r.dimensions };
        } catch (err) {
          if (!(err instanceof NotImplementedError)) warnOnce('recommendSize', err);
        }
      }
      const ev = evaluateSizeFallback(garment, size, measurements);
      return { overall: ev.overall, dimensions: ev.dimensions };
    },
  };
}

let cached: CatalogApi | null = null;

/** Catálogo real si `@fitroom/catalog` está READY; si no (o con `?mock=1`), el mini-catálogo de desarrollo. */
export function getCatalog(): CatalogApi {
  if (cached) return cached;
  if (READY.catalog && !appParams().mock) {
    try {
      cached = build(loadCatalogData(), 'real');
      return cached;
    } catch (err) {
      warnOnce('loadCatalogData', err);
    }
  }
  cached = build(DEV_CATALOG, 'dev');
  return cached;
}

export function useCatalog(): CatalogApi {
  return useMemo(() => getCatalog(), []);
}

/** Convierte lo que lleva puesto la persona en los `EquippedItem` del contrato del espejo. */
export function buildEquipped(worn: Worn, catalog: CatalogApi): EquippedItem[] {
  const out: EquippedItem[] = [];
  for (const { item } of wornEntries(worn)) {
    const garment = catalog.garment(item.garmentId);
    const fabric = garment && catalog.fabric(garment.fabricId);
    if (!garment || !fabric) continue;
    const variant = garment.variants.find((v) => v.id === item.variantId) ?? garment.variants[0]!;
    const trimFabric = garment.trimFabricId ? catalog.fabric(garment.trimFabricId) : undefined;
    out.push({ garment, fabric, trimFabric, variant, sizeLabel: item.size });
  }
  return out;
}
