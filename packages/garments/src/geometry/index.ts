import {
  NotImplementedError,
  type BodyModel,
  type GarmentDefinition,
  type GarmentGeometry,
} from '@fitroom/shared';

/**
 * Geometría de alta resolución de una prenda ajustada a un cuerpo y a una talla.
 * STUB de la fundación — propiedad del agente GARMENT-GEO (carpeta `src/geometry/`).
 */
export function generateGarment(
  _def: GarmentDefinition,
  _sizeLabel: string,
  _body: BodyModel,
): GarmentGeometry {
  throw new NotImplementedError('garments.generateGarment');
}
