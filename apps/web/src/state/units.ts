import { MEASUREMENT_LIMITS, type MeasurementKey } from '@fitroom/shared';

/** Sistema de unidades de la interfaz. El estado interno SIEMPRE es canónico: cm y kg. */
export type UnitSystem = 'metric' | 'imperial';
export type DisplayUnit = 'cm' | 'in' | 'kg' | 'lb';

export const CM_PER_INCH = 2.54;
export const KG_PER_POUND = 0.45359237;

export const cmToIn = (cm: number): number => cm / CM_PER_INCH;
export const inToCm = (inches: number): number => inches * CM_PER_INCH;
export const kgToLb = (kg: number): number => kg / KG_PER_POUND;
export const lbToKg = (lb: number): number => lb * KG_PER_POUND;

export function unitFor(key: MeasurementKey, system: UnitSystem): DisplayUnit {
  const base = MEASUREMENT_LIMITS[key].unit;
  if (system === 'metric') return base;
  return base === 'cm' ? 'in' : 'lb';
}

/** Factor canónico → visualización (para valores y para incertidumbres, que no llevan desfase). */
function factor(key: MeasurementKey, system: UnitSystem): number {
  if (system === 'metric') return 1;
  return MEASUREMENT_LIMITS[key].unit === 'cm' ? 1 / CM_PER_INCH : 1 / KG_PER_POUND;
}

/** Valor canónico (cm/kg) → valor en la unidad mostrada (sin redondear). */
export function toDisplay(key: MeasurementKey, canonical: number, system: UnitSystem): number {
  return canonical * factor(key, system);
}

/** Valor en la unidad mostrada → canónico (cm/kg). */
export function fromDisplay(key: MeasurementKey, shown: number, system: UnitSystem): number {
  return shown / factor(key, system);
}

/** Incertidumbre canónica → mostrada. */
export const sigmaToDisplay = toDisplay;

export interface DisplayLimits {
  readonly min: number;
  readonly max: number;
  readonly unit: DisplayUnit;
}

/** Límites de plausibilidad en la unidad mostrada (mínimo hacia arriba, máximo hacia abajo: nunca más permisivo que el real). */
export function displayLimits(key: MeasurementKey, system: UnitSystem): DisplayLimits {
  const { min, max } = MEASUREMENT_LIMITS[key];
  const f = factor(key, system);
  const round = system === 'metric' ? 1 : 10;
  return {
    min: Math.ceil(min * f * round) / round,
    max: Math.floor(max * f * round) / round,
    unit: unitFor(key, system),
  };
}

/** Redondeo para mostrar: 1 decimal. */
export function roundForDisplay(value: number): number {
  return Math.round(value * 10) / 10;
}

export function formatNumber(value: number, lang: string, maxDecimals = 1): string {
  if (!Number.isFinite(value)) return '';
  return new Intl.NumberFormat(lang, {
    maximumFractionDigits: maxDecimals,
    minimumFractionDigits: 0,
    useGrouping: false,
  }).format(value);
}

export type ParsedNumber =
  | { readonly kind: 'empty' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'ok'; readonly value: number };

const NUMBER_RE = /^(?:\d+(?:[.,]\d*)?|[.,]\d+)$/;

/**
 * Interpreta lo que escribe la persona: acepta coma o punto decimal y, opcionalmente, la unidad mostrada
 * pegada al número («178 cm»). Rechaza negativos, exponentes, Infinity, NaN y separadores repetidos.
 */
export function parseDecimalInput(text: string, unit?: DisplayUnit): ParsedNumber {
  let s = text.trim();
  if (s === '') return { kind: 'empty' };
  if (unit) {
    const suffix = unit === 'in' ? /\s*(?:in|"|″|pulg)$/i : new RegExp(`\\s*${unit}s?$`, 'i');
    s = s.replace(suffix, '').trim();
    if (s === '') return { kind: 'invalid' };
  }
  if (!NUMBER_RE.test(s)) return { kind: 'invalid' };
  const value = Number(s.replace(',', '.'));
  return Number.isFinite(value) ? { kind: 'ok', value } : { kind: 'invalid' };
}
