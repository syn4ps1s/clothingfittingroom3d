import type {
  GarmentDefinition,
  GarmentFit,
  GarmentTemplate,
  LocalizedText,
  SwatchVariant,
} from '@fitroom/shared';
import { CATEGORY_SLOT, TEMPLATE_CATEGORY } from '../src/validate.js';
import { buildSizes, type SizeTableSource } from './lib.js';

/** Definición compacta de una prenda; `toGarment` la expande a `GarmentDefinition` con la tabla de tallas completa. */
export interface GarmentSource {
  readonly id: string;
  readonly name: LocalizedText;
  readonly description: LocalizedText;
  readonly brand: string;
  readonly template: GarmentTemplate;
  readonly fit: GarmentFit;
  readonly fabricId: string;
  readonly trimFabricId?: string;
  readonly table: SizeTableSource;
  /** parámetros de plantilla (ver docs/template-params.md) */
  readonly params: Readonly<Record<string, number>>;
  readonly variants: readonly SwatchVariant[];
  readonly tags: readonly string[];
  readonly priceEur: number;
}

export function toGarment(src: GarmentSource): GarmentDefinition {
  const category = TEMPLATE_CATEGORY[src.template];
  return {
    id: src.id,
    name: src.name,
    description: src.description,
    brand: src.brand,
    category,
    template: src.template,
    slot: CATEGORY_SLOT[category],
    fit: src.fit,
    fabricId: src.fabricId,
    ...(src.trimFabricId ? { trimFabricId: src.trimFabricId } : {}),
    variants: [...src.variants],
    sizes: buildSizes(src.table),
    params: { ...src.params },
    price: { amount: src.priceEur, currency: 'EUR' },
    tags: [...src.tags],
  };
}
