/** Errores tipados del generador de prendas. */
export type GarmentErrorCode =
  | 'unknown-size'
  | 'invalid-definition'
  | 'invalid-body'
  | 'unsupported-template'
  | 'generation-failed';

export class GarmentGeometryError extends Error {
  readonly code: GarmentErrorCode;
  constructor(code: GarmentErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'GarmentGeometryError';
    this.code = code;
  }
}
