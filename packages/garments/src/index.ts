import {
  NotImplementedError,
  type BodyModel,
  type ClothSolver,
  type FabricDef,
  type FabricTextureSet,
  type GarmentDefinition,
  type GarmentGeometry,
  type SwatchVariant,
} from '@fitroom/shared';

/** Geometría de alta resolución de una prenda ajustada a un cuerpo y talla. STUB — agente GARMENT-GEO. */
export function generateGarment(
  _def: GarmentDefinition,
  _sizeLabel: string,
  _body: BodyModel,
): GarmentGeometry {
  throw new NotImplementedError('garments.generateGarment');
}

/** Texturas PBR procedurales (albedo/normal/ORM). STUB — agente GARMENT-FABRIC. */
export function generateFabricTextures(
  _fabric: FabricDef,
  _variant: SwatchVariant,
  _size: 512 | 1024 | 2048,
  _seed?: number,
): FabricTextureSet {
  throw new NotImplementedError('garments.generateFabricTextures');
}

/** Solver de tela PBD. STUB — agente GARMENT-FABRIC. */
export function createClothSolver(_geometry: GarmentGeometry): ClothSolver {
  throw new NotImplementedError('garments.createClothSolver');
}
