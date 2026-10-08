import { z } from 'zod';

/**
 * Catálogo: definiciones de telas, muestras (variantes de color/estampado) y prendas.
 * Todo lo que entra desde datos externos (JSON del catálogo) se valida con estos esquemas.
 */
export const LocalizedTextSchema = z.strictObject({
  es: z.string().min(1).max(300),
  en: z.string().min(1).max(300),
});
export type LocalizedText = z.infer<typeof LocalizedTextSchema>;

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'id en kebab-case');
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color #rrggbb');

export const FABRIC_FAMILIES = [
  'cotton-jersey',
  'cotton-poplin',
  'denim',
  'linen',
  'wool-knit',
  'merino',
  'satin',
  'silk-crepe',
  'leather',
  'corduroy',
  'fleece',
  'twill',
  'tweed',
] as const;
export type FabricFamily = (typeof FABRIC_FAMILIES)[number];

/** Parámetros físicos y de apariencia de una tela (alimentan texturas PBR y simulación). */
export const FabricSchema = z.strictObject({
  id: idSchema,
  name: LocalizedTextSchema,
  family: z.enum(FABRIC_FAMILIES),
  /** gramaje (g/m²) — influye en caída y espesor */
  weightGsm: z.number().min(40).max(900),
  /** elasticidad 0 (rígida) .. 1 (muy elástica) */
  stretch: z.number().min(0).max(1),
  /** rigidez a flexión 0 (muy fluida) .. 1 (rígida) */
  stiffness: z.number().min(0).max(1),
  /** rugosidad base PBR 0..1 */
  roughness: z.number().min(0).max(1),
  /** brillo de fibra (velvet/sheen) 0..1 */
  sheen: z.number().min(0).max(1),
  /** hilos por cm del tejido (escala del micro-patrón) */
  threadsPerCm: z.number().min(2).max(80),
  /** tamaño físico (cm) de una repetición de la textura */
  tileCm: z.number().min(2).max(60),
  /** espesor (mm) */
  thicknessMm: z.number().min(0.2).max(8),
});
export type FabricDef = z.infer<typeof FabricSchema>;

export const PatternSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('solid') }),
  z.strictObject({
    type: z.literal('stripes'),
    color2: hexColor,
    widthMm: z.number().min(0.5).max(80),
    gapMm: z.number().min(0.5).max(80),
    angleDeg: z.number().min(0).max(180),
  }),
  z.strictObject({
    type: z.literal('plaid'),
    color2: hexColor,
    color3: hexColor.optional(),
    sizeMm: z.number().min(10).max(120),
  }),
  z.strictObject({
    type: z.literal('dots'),
    color2: hexColor,
    radiusMm: z.number().min(0.5).max(15),
    spacingMm: z.number().min(3).max(60),
  }),
  z.strictObject({
    type: z.literal('herringbone'),
    color2: hexColor,
    sizeMm: z.number().min(2).max(40),
  }),
  z.strictObject({
    type: z.literal('floral'),
    color2: hexColor,
    color3: hexColor.optional(),
    scaleMm: z.number().min(10).max(120),
  }),
]);
export type PatternSpec = z.infer<typeof PatternSchema>;

/** Muestra de tela: color + estampado. Es lo que el usuario toca en la mesa de muestras. */
export const SwatchVariantSchema = z.strictObject({
  id: idSchema,
  name: LocalizedTextSchema,
  color: hexColor,
  pattern: PatternSchema,
});
export type SwatchVariant = z.infer<typeof SwatchVariantSchema>;

export const GARMENT_CATEGORIES = ['tops', 'bottoms', 'dresses', 'outerwear'] as const;
export type GarmentCategory = (typeof GARMENT_CATEGORIES)[number];

export const GARMENT_TEMPLATES = [
  'tee',
  'long_sleeve',
  'tank',
  'polo',
  'shirt',
  'sweater',
  'hoodie',
  'jeans',
  'chinos',
  'shorts',
  'skirt',
  'dress',
  'blazer',
  'jacket',
  'coat',
] as const;
export type GarmentTemplate = (typeof GARMENT_TEMPLATES)[number];

/**
 * Ranura de capa: 'upper' camisetas/camisas, 'lower' pantalones/falda, 'full' vestidos (ocupa upper+lower),
 * 'outer' abrigos/chaquetas (se superpone a 'upper'). Una persona lleva como máximo una prenda por ranura.
 */
export const GARMENT_SLOTS = ['upper', 'lower', 'full', 'outer'] as const;
export type GarmentSlot = (typeof GARMENT_SLOTS)[number];

export const FITS = ['slim', 'regular', 'relaxed', 'oversized'] as const;
export type GarmentFit = (typeof FITS)[number];

/** Medidas de la PRENDA (circunferencias completas, no medio contorno), en cm. */
export const GarmentSpecSchema = z.strictObject({
  chestCm: z.number().min(40).max(220).optional(),
  waistCm: z.number().min(30).max(220).optional(),
  hemCm: z.number().min(40).max(300).optional(),
  hipCm: z.number().min(40).max(240).optional(),
  thighCm: z.number().min(20).max(120).optional(),
  legOpeningCm: z.number().min(15).max(80).optional(),
  shoulderWidthCm: z.number().min(25).max(80).optional(),
  /** largo espalda (cuello→bajo) para tops/vestidos; cintura→bajo para faldas */
  lengthCm: z.number().min(20).max(180).optional(),
  sleeveLengthCm: z.number().min(0).max(100).optional(),
  inseamCm: z.number().min(0).max(110).optional(),
  riseCm: z.number().min(15).max(50).optional(),
});
export type GarmentSpec = z.infer<typeof GarmentSpecSchema>;
export type GarmentDimension = keyof GarmentSpec;

/** Rango de medidas CORPORALES para las que está pensada una talla (tabla de tallas de marca). */
const range = z.tuple([z.number().min(0).max(300), z.number().min(0).max(300)]);
export const SizeBodyRangeSchema = z.strictObject({
  heightCm: range.optional(),
  chestCm: range.optional(),
  waistCm: range.optional(),
  hipCm: range.optional(),
  shoulderWidthCm: range.optional(),
  inseamCm: range.optional(),
});
export type SizeBodyRange = z.infer<typeof SizeBodyRangeSchema>;

export const GarmentSizeSchema = z.strictObject({
  label: z.string().min(1).max(8),
  body: SizeBodyRangeSchema,
  garment: GarmentSpecSchema,
});
export type GarmentSizeSpec = z.infer<typeof GarmentSizeSchema>;

export const GarmentDefinitionSchema = z.strictObject({
  id: idSchema,
  name: LocalizedTextSchema,
  description: LocalizedTextSchema,
  brand: z.string().min(1).max(60),
  category: z.enum(GARMENT_CATEGORIES),
  template: z.enum(GARMENT_TEMPLATES),
  slot: z.enum(GARMENT_SLOTS),
  fit: z.enum(FITS),
  fabricId: idSchema,
  trimFabricId: idSchema.optional(),
  variants: z.array(SwatchVariantSchema).min(1).max(12),
  /** ordenadas de menor a mayor */
  sizes: z.array(GarmentSizeSchema).min(1).max(12),
  /** parámetros específicos de plantilla (profundidad de escote, largo de tiro, etc.) */
  params: z.record(z.string().max(40), z.number().finite()).optional(),
  price: z
    .strictObject({ amount: z.number().min(0).max(10000), currency: z.literal('EUR') })
    .optional(),
  tags: z.array(z.string().min(1).max(30)).max(12),
});
export type GarmentDefinition = z.infer<typeof GarmentDefinitionSchema>;

export const CatalogDataSchema = z.strictObject({
  version: z.number().int().min(1),
  fabrics: z.array(FabricSchema).min(1),
  garments: z.array(GarmentDefinitionSchema).min(1),
});
export type CatalogData = z.infer<typeof CatalogDataSchema>;

/** Puerto de acceso al catálogo. MVP: datos estáticos validados; mañana: API REST sin tocar la app. */
export interface CatalogRepository {
  listGarments(filter?: {
    category?: GarmentCategory;
    slot?: GarmentSlot;
    text?: string;
  }): Promise<readonly GarmentDefinition[]>;
  getGarment(id: string): Promise<GarmentDefinition | undefined>;
  getFabric(id: string): Promise<FabricDef | undefined>;
  listFabrics(): Promise<readonly FabricDef[]>;
}
