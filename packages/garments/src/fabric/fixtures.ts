import { FABRIC_FAMILIES, type FabricDef, type FabricFamily, type SwatchVariant } from '@fitroom/shared';

/**
 * Telas y muestras de ejemplo (valores plausibles, uno por familia). Las usan los tests y las
 * herramientas de QA visual; también documentan rangos razonables para el catálogo.
 */

const make = (family: FabricFamily, o: Partial<FabricDef>): FabricDef => ({
  id: family,
  name: { es: family, en: family },
  family,
  weightGsm: 200,
  stretch: 0.2,
  stiffness: 0.4,
  roughness: 0.8,
  sheen: 0.1,
  threadsPerCm: 20,
  tileCm: 6,
  thicknessMm: 0.8,
  ...o,
});

export const EXAMPLE_FABRICS: Readonly<Record<FabricFamily, FabricDef>> = {
  'cotton-jersey': make('cotton-jersey', {
    weightGsm: 160,
    stretch: 0.6,
    stiffness: 0.15,
    roughness: 0.88,
    sheen: 0.05,
    threadsPerCm: 9,
    tileCm: 6,
    thicknessMm: 0.7,
  }),
  'cotton-poplin': make('cotton-poplin', {
    weightGsm: 115,
    stretch: 0.05,
    stiffness: 0.35,
    roughness: 0.72,
    threadsPerCm: 40,
    tileCm: 6,
    thicknessMm: 0.3,
  }),
  denim: make('denim', {
    weightGsm: 340,
    stretch: 0.1,
    stiffness: 0.75,
    roughness: 0.9,
    sheen: 0.02,
    threadsPerCm: 26,
    tileCm: 8,
    thicknessMm: 0.9,
  }),
  linen: make('linen', {
    weightGsm: 180,
    stretch: 0.03,
    stiffness: 0.5,
    roughness: 0.88,
    sheen: 0.05,
    threadsPerCm: 14,
    tileCm: 8,
    thicknessMm: 0.6,
  }),
  'wool-knit': make('wool-knit', {
    weightGsm: 380,
    stretch: 0.5,
    stiffness: 0.3,
    roughness: 0.95,
    sheen: 0.04,
    threadsPerCm: 3.2,
    tileCm: 14,
    thicknessMm: 5,
  }),
  merino: make('merino', {
    weightGsm: 190,
    stretch: 0.55,
    stiffness: 0.2,
    roughness: 0.85,
    sheen: 0.12,
    threadsPerCm: 7,
    tileCm: 7,
    thicknessMm: 1.6,
  }),
  satin: make('satin', {
    weightGsm: 120,
    stretch: 0.05,
    stiffness: 0.1,
    roughness: 0.32,
    sheen: 0.8,
    threadsPerCm: 60,
    tileCm: 6,
    thicknessMm: 0.25,
  }),
  'silk-crepe': make('silk-crepe', {
    weightGsm: 90,
    stretch: 0.08,
    stiffness: 0.12,
    roughness: 0.5,
    sheen: 0.5,
    threadsPerCm: 30,
    tileCm: 6,
    thicknessMm: 0.3,
  }),
  leather: make('leather', {
    weightGsm: 600,
    stretch: 0.05,
    stiffness: 0.85,
    roughness: 0.5,
    sheen: 0.3,
    threadsPerCm: 6,
    tileCm: 8,
    thicknessMm: 1.4,
  }),
  corduroy: make('corduroy', {
    weightGsm: 280,
    stretch: 0.08,
    stiffness: 0.6,
    roughness: 0.92,
    sheen: 0.15,
    threadsPerCm: 26,
    tileCm: 6,
    thicknessMm: 1.8,
  }),
  fleece: make('fleece', {
    weightGsm: 300,
    stretch: 0.25,
    stiffness: 0.2,
    roughness: 0.98,
    sheen: 0.05,
    threadsPerCm: 10,
    tileCm: 6,
    thicknessMm: 4,
  }),
  twill: make('twill', {
    weightGsm: 220,
    stretch: 0.08,
    stiffness: 0.55,
    roughness: 0.78,
    threadsPerCm: 28,
    tileCm: 6,
    thicknessMm: 0.7,
  }),
  tweed: make('tweed', {
    weightGsm: 380,
    stretch: 0.05,
    stiffness: 0.7,
    roughness: 0.93,
    sheen: 0.03,
    threadsPerCm: 9,
    tileCm: 10,
    thicknessMm: 1.8,
  }),
};

export const EXAMPLE_COLORS: Readonly<Record<FabricFamily, string>> = {
  'cotton-jersey': '#7f9fc2',
  'cotton-poplin': '#cfd9e8',
  denim: '#27415e',
  linen: '#cdbb9d',
  'wool-knit': '#d8ccb6',
  merino: '#2d3d63',
  satin: '#8e2b4a',
  'silk-crepe': '#2f7a62',
  leather: '#6b3f27',
  corduroy: '#b3873a',
  fleece: '#7b8c80',
  twill: '#a89873',
  tweed: '#75665a',
};

export const EXAMPLE_PATTERNS: readonly SwatchVariant['pattern'][] = [
  { type: 'solid' },
  { type: 'stripes', color2: '#f2efe6', widthMm: 5, gapMm: 7, angleDeg: 90 },
  { type: 'plaid', color2: '#b83a3a', color3: '#f0e6d0', sizeMm: 40 },
  { type: 'dots', color2: '#f4f0e8', radiusMm: 2.2, spacingMm: 10 },
  { type: 'herringbone', color2: '#ece4d2', sizeMm: 10 },
  { type: 'floral', color2: '#e8a3b5', color3: '#4f7a4a', scaleMm: 30 },
];

export function exampleVariant(
  family: FabricFamily,
  pattern: SwatchVariant['pattern'] = { type: 'solid' },
  color: string = EXAMPLE_COLORS[family],
): SwatchVariant {
  return { id: `v-${pattern.type}`, name: { es: 'muestra', en: 'swatch' }, color, pattern };
}

export const ALL_FAMILIES: readonly FabricFamily[] = FABRIC_FAMILIES;
