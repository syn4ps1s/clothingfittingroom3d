import type { ClothSolver } from '@fitroom/shared';

/** Error tipado por geometría/ajustes inconsistentes con el contrato (se lanza en el borde, no en el bucle caliente). */
export class ClothSolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClothSolverError';
  }
}

/**
 * Opciones del solver. `createClothSolver(geometry)` funciona sin ellas; el catálogo/runtime puede afinar:
 *  - `thicknessMm` = `FabricDef.thicknessMm` de la tela principal (margen de colisión = espesor + 3 mm).
 *  - `particleBudget` = nº máximo de partículas de la malla proxy (el coste del paso depende de esto
 *    y del nº de vértices de render, no de la resolución de la geometría).
 */
export interface ClothSolverOptions {
  /** espesor de la tela (mm) para el margen de colisión. Por defecto 1 mm → margen 4 mm. */
  readonly thicknessMm?: number;
  /** máximo de partículas simuladas. Por defecto 2500 (rango 4..20000). */
  readonly particleBudget?: number;
  /** tope de iteraciones de restricciones por subpaso. Por defecto 5. */
  readonly maxIterations?: number;
  /** fracción de la gravedad real aplicada (la prenda ya viene "caída" en reposo). Por defecto 0,3. */
  readonly gravityScale?: number;
  /** sumidero de avisos (anomalías reales). Por defecto `console.warn`, limitado a unos pocos mensajes. */
  readonly warn?: (message: string) => void;
}

/** Contadores de diagnóstico (nunca se reinician salvo con un solver nuevo). */
export interface ClothSolverStats {
  steps: number;
  /** vértices skinneados no finitos (o |x| ≥ 1e5) sustituidos por una estimación segura */
  nonFiniteInputVertices: number;
  /** partículas cuyo estado dejó de ser finito y se restauró al objetivo skinneado */
  particleRepairs: number;
  /** teleports detectados (global o por partícula) */
  teleports: number;
  /** pasos con `dt` inválido o enorme */
  badDt: number;
  /** capsulas descartadas por degeneradas (NaN, radio ≤ 0, …) */
  skippedCapsules: number;
  /** iteraciones y subpasos del último paso */
  lastIterations: number;
  lastSubsteps: number;
}

/** `ClothSolver` del contrato + diagnóstico. Es asignable a `ClothSolver`. */
export interface ClothSolverEx extends ClothSolver {
  readonly stats: Readonly<ClothSolverStats>;
  /** nº de partículas de la malla proxy */
  readonly particleCount: number;
  /** margen de colisión (m) = espesor de tela + 3 mm */
  readonly collisionMargin: number;
}
