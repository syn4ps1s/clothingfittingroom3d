import { z } from 'zod';

/**
 * Medidas corporales (cm / kg). Fuente única de verdad para formularios, validación,
 * estimación por cámara y tallaje. Los rangos son límites de PLAUSIBILIDAD humana
 * (adultos y adolescentes); fuera de ellos la entrada se rechaza, nunca se "corrige" en silencio.
 */
export const MEASUREMENT_KEYS = [
  'heightCm',
  'weightKg',
  'chestCm',
  'waistCm',
  'hipCm',
  'shoulderWidthCm',
  'armLengthCm',
  'inseamCm',
  'neckCm',
  'thighCm',
] as const;
export type MeasurementKey = (typeof MEASUREMENT_KEYS)[number];

export interface MeasurementLimit {
  readonly min: number;
  readonly max: number;
  readonly unit: 'cm' | 'kg';
  /** Obligatoria para tener un cuerpo utilizable (el resto puede derivarse de la estatura). */
  readonly required: boolean;
}

export const MEASUREMENT_LIMITS: Readonly<Record<MeasurementKey, MeasurementLimit>> = {
  heightCm: { min: 120, max: 230, unit: 'cm', required: true },
  weightKg: { min: 30, max: 250, unit: 'kg', required: false },
  chestCm: { min: 60, max: 180, unit: 'cm', required: false },
  waistCm: { min: 45, max: 180, unit: 'cm', required: false },
  hipCm: { min: 60, max: 200, unit: 'cm', required: false },
  shoulderWidthCm: { min: 28, max: 70, unit: 'cm', required: false },
  armLengthCm: { min: 40, max: 95, unit: 'cm', required: false },
  inseamCm: { min: 55, max: 110, unit: 'cm', required: false },
  neckCm: { min: 25, max: 55, unit: 'cm', required: false },
  thighCm: { min: 30, max: 90, unit: 'cm', required: false },
};

export const BODY_BASES = ['neutral', 'feminine', 'masculine'] as const;
export type BodyBase = (typeof BODY_BASES)[number];

const num = (k: MeasurementKey) =>
  z.number().min(MEASUREMENT_LIMITS[k].min).max(MEASUREMENT_LIMITS[k].max);

/** Medidas COMPLETAS (todas presentes). Es lo que consumen `buildBody` y el tallaje. */
export const MeasurementsSchema = z.strictObject({
  heightCm: num('heightCm'),
  weightKg: num('weightKg'),
  chestCm: num('chestCm'),
  waistCm: num('waistCm'),
  hipCm: num('hipCm'),
  shoulderWidthCm: num('shoulderWidthCm'),
  armLengthCm: num('armLengthCm'),
  inseamCm: num('inseamCm'),
  neckCm: num('neckCm'),
  thighCm: num('thighCm'),
  bodyBase: z.enum(BODY_BASES),
});
export type Measurements = z.infer<typeof MeasurementsSchema>;

/** Entrada parcial del usuario: sólo la estatura es obligatoria. El resto se deriva (ver @fitroom/body). */
export const PartialMeasurementsSchema = z.strictObject({
  heightCm: num('heightCm'),
  weightKg: num('weightKg').optional(),
  chestCm: num('chestCm').optional(),
  waistCm: num('waistCm').optional(),
  hipCm: num('hipCm').optional(),
  shoulderWidthCm: num('shoulderWidthCm').optional(),
  armLengthCm: num('armLengthCm').optional(),
  inseamCm: num('inseamCm').optional(),
  neckCm: num('neckCm').optional(),
  thighCm: num('thighCm').optional(),
  bodyBase: z.enum(BODY_BASES).optional(),
});
export type PartialMeasurements = z.infer<typeof PartialMeasurementsSchema>;

export type MeasurementSource =
  | 'user' // escrita/confirmada por la persona
  | 'scan-video' // estimada por cámara en vivo (múltiples fotogramas)
  | 'scan-photo' // estimada por una fotografía
  | 'regression' // derivada estadísticamente de otras medidas
  | 'default'; // valor poblacional por defecto

export interface EstimatedValue {
  readonly value: number;
  /** Incertidumbre (1 desviación típica) en la misma unidad. Nunca mostrar una estimación sin ella. */
  readonly sigma: number;
  readonly source: MeasurementSource;
}

/** Resultado de un escaneo: valores con incertidumbre. La persona SIEMPRE puede revisarlos/editarlos. */
export type MeasurementEstimate = {
  readonly heightCm: EstimatedValue;
} & {
  readonly [K in Exclude<MeasurementKey, 'heightCm'>]?: EstimatedValue;
};
