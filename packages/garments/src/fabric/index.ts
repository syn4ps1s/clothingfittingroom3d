/**
 * Texturas PBR procedurales de telas (albedo/normal/ORM) y mapa de arrugas.
 * Propiedad del agente GARMENT-FABRIC (carpeta `src/fabric/`). Ver `FABRIC_STATUS.md`.
 */
export {
  generateFabricTextures,
  generateFabricTexturesAsync,
  FabricInputError,
  type AsyncOptions,
} from './textures.js';
export { generateWrinkleNormalMap, generateWrinkleNormalMapAsync } from './wrinkle.js';
export type { FabricTextureResult, FabricTextureInfo, PatternFitInfo } from './types.js';
