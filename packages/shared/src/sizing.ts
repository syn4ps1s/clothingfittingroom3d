import type { GarmentDefinition, GarmentDimension } from './catalog.js';
import type { Measurements } from './measurements.js';

export const FIT_PREFERENCES = ['snug', 'regular', 'roomy'] as const;
export type FitPreference = (typeof FIT_PREFERENCES)[number];

export type FitVerdict = 'too-tight' | 'snug' | 'good' | 'roomy' | 'too-loose';

export interface FitDimension {
  readonly dimension: GarmentDimension;
  /** medida corporal comparada (cm) */
  readonly bodyCm: number;
  readonly garmentCm: number;
  /** garment − body (cm); negativo = la prenda es más pequeña que el cuerpo */
  readonly easeCm: number;
  readonly verdict: FitVerdict;
}

export type SizeNote =
  | 'between-sizes'
  | 'below-smallest-size'
  | 'above-largest-size'
  | 'low-measurement-confidence'
  | 'height-out-of-range';

export interface SizeRecommendation {
  readonly garmentId: string;
  /** etiqueta de talla recomendada, p.ej. "M" */
  readonly size: string;
  readonly overall: FitVerdict;
  readonly dimensions: readonly FitDimension[];
  /** 0..1: baja si hay incertidumbre en las medidas o la persona queda fuera de la tabla */
  readonly confidence: number;
  readonly alternatives: readonly { size: string; overall: FitVerdict }[];
  readonly notes: readonly SizeNote[];
}

export interface SizingInput {
  readonly garment: GarmentDefinition;
  readonly measurements: Measurements;
  readonly preference?: FitPreference;
  /** sigma (cm) por medida, si proviene de un escaneo; aumenta la incertidumbre/penaliza confianza */
  readonly sigmaCm?: Partial<Record<keyof Measurements, number>>;
  /** elasticidad de la tela (FabricDef.stretch, 0..1): una tela elástica relaja el suelo de holgura; opcional. */
  readonly fabric?: { readonly stretch: number };
}
