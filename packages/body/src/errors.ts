import type { MeasurementKey } from '@fitroom/shared';

/** Códigos de error tipados del paquete `body`. */
export type BodyErrorCode =
  | 'invalid-measurements' // no cumple el esquema zod (NaN, ±Inf, fuera de rango, claves desconocidas…)
  | 'skeleton-infeasible' // dentro de rango pero físicamente imposible (p. ej. entrepierna 110 cm con 120 cm de estatura)
  | 'invalid-skin-matrices' // matrices de skinning con tamaño incorrecto
  | 'internal'; // invariante interna rota (bug): nunca debería ocurrir

export interface BodyIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Error tipado de entrada/ejecución del paquete. `buildBody` y `completeMeasurements` NUNCA devuelven una malla
 * o unas medidas corruptas: o producen un resultado válido o lanzan esto.
 */
export class BodyInputError extends Error {
  readonly code: BodyErrorCode;
  readonly issues: readonly BodyIssue[];
  readonly keys: readonly MeasurementKey[];

  constructor(
    code: BodyErrorCode,
    message: string,
    issues: readonly BodyIssue[] = [],
    keys: readonly MeasurementKey[] = [],
  ) {
    super(`${code}: ${message}`);
    this.name = 'BodyInputError';
    this.code = code;
    this.issues = issues;
    this.keys = keys;
  }
}
