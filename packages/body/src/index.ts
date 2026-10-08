import {
  NotImplementedError,
  type BodyModel,
  type Measurements,
  type PartialMeasurements,
  type WorldCapsule,
  type CapsuleCollider,
} from '@fitroom/shared';

/**
 * Completa medidas parciales (sólo estatura es obligatoria) con regresión antropométrica.
 * STUB de la fundación — implementar en el agente BODY.
 */
export function completeMeasurements(_partial: PartialMeasurements): Measurements {
  throw new NotImplementedError('body.completeMeasurements');
}

/** Construye el cuerpo paramétrico skinneado. STUB — implementar en el agente BODY. */
export function buildBody(_measurements: Measurements): BodyModel {
  throw new NotImplementedError('body.buildBody');
}

/** Transforma los colisionadores del cuerpo a mundo con las matrices de skinning del fotograma. */
export function worldColliders(
  _body: BodyModel,
  _skinMatrices: Float32Array,
  _out?: WorldCapsule[],
): WorldCapsule[] {
  throw new NotImplementedError('body.worldColliders');
}

export type { CapsuleCollider };
