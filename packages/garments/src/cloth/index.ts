/**
 * Solver de tela PBD con malla proxy + interpolación al mallado de render.
 * Propiedad del agente GARMENT-FABRIC (carpeta `src/cloth/`). Ver `FABRIC_STATUS.md`.
 */
export { createClothSolver } from './solver.js';
export {
  ClothSolverError,
  type ClothSolverEx,
  type ClothSolverOptions,
  type ClothSolverStats,
} from './types.js';
