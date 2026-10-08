import {
  NotImplementedError,
  type FabricDef,
  type FabricTextureSet,
  type SwatchVariant,
} from '@fitroom/shared';

/**
 * Texturas PBR procedurales (albedo/normal/ORM), tileables.
 * STUB — propiedad del agente GARMENT-FABRIC (carpeta `src/fabric/`).
 */
export function generateFabricTextures(
  _fabric: FabricDef,
  _variant: SwatchVariant,
  _size: 512 | 1024 | 2048,
  _seed?: number,
): FabricTextureSet {
  throw new NotImplementedError('garments.generateFabricTextures');
}

/** Normal map tileable de pliegues/arrugas (RGBA8) que se mezcla por el atributo `wrinkle`. STUB. */
export function generateWrinkleNormalMap(_size: 512 | 1024, _seed?: number): Uint8Array {
  throw new NotImplementedError('garments.generateWrinkleNormalMap');
}
