import { median } from './geom.js';

/**
 * Estadística robusta (mediana + rechazo por MAD). Pura, determinista y tolerante a NaN/vacíos.
 */

/** Desviación absoluta mediana (sin escalar). NaN si no hay datos. */
export function mad(values: readonly number[], center = median(values)): number {
  if (values.length === 0) return NaN;
  return median(values.map((v) => Math.abs(v - center)));
}

/** Constante que hace la MAD consistente con la desviación típica de una normal. */
export const MAD_TO_SIGMA = 1.4826;

export interface RobustStats {
  /** mediana de las muestras conservadas */
  readonly value: number;
  /** σ robusta de las conservadas (1.4826·MAD, con suelo `minSigma`) */
  readonly spread: number;
  /** nº de muestras conservadas / rechazadas como atípicas */
  readonly kept: number;
  readonly rejected: number;
}

/**
 * Mediana con rechazo de atípicos: descarta |x − mediana| > `k`·σ_MAD (σ_MAD con suelo `minSigma`) y
 * recalcula una vez. Ignora entradas no finitas. Devuelve `null` si no queda ninguna muestra.
 */
export function robustLocation(
  values: readonly number[],
  opts: { readonly k?: number; readonly minSigma?: number } = {},
): RobustStats | null {
  const k = opts.k ?? 3.5;
  const minSigma = opts.minSigma ?? 0;
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length === 0) return null;
  const m0 = median(xs);
  const s0 = Math.max(MAD_TO_SIGMA * mad(xs, m0), minSigma);
  const kept = s0 > 0 ? xs.filter((v) => Math.abs(v - m0) <= k * s0) : xs;
  const use = kept.length > 0 ? kept : xs;
  const m1 = median(use);
  return {
    value: m1,
    spread: Math.max(MAD_TO_SIGMA * mad(use, m1), minSigma),
    kept: use.length,
    rejected: xs.length - use.length,
  };
}

/** Combina σ independientes en cuadratura. */
export const rss = (...xs: readonly number[]): number => Math.sqrt(xs.reduce((a, b) => a + b * b, 0));

/**
 * Fusión de un a priori `a` con una medida `b` por inverso de varianza, ROBUSTA al conflicto: si discrepan
 * más de 1σ combinada, la varianza del a priori se infla hasta que la discrepancia sea de exactamente 1σ
 * (el dato manda cuando contradice a la población; el a priori sólo regulariza). `z` es la discrepancia
 * original en σ.
 */
export function fuse(
  prior: { readonly value: number; readonly sigma: number },
  data: { readonly value: number; readonly sigma: number },
): { value: number; sigma: number; z: number } {
  const d = Math.abs(prior.value - data.value);
  const z = d / Math.hypot(prior.sigma, data.sigma);
  let varPrior = prior.sigma * prior.sigma;
  if (z > 1) varPrior = Math.max(varPrior, d * d - data.sigma * data.sigma);
  const wa = 1 / varPrior;
  const wb = 1 / (data.sigma * data.sigma);
  return {
    value: (prior.value * wa + data.value * wb) / (wa + wb),
    sigma: Math.sqrt(1 / (wa + wb)),
    z,
  };
}
