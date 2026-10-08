import type { SkinnedMeshData } from './mesh.js';
import type { BodyRegion } from './body.js';
import type { GarmentSlot } from './catalog.js';

/** Material slots de una prenda: la tela principal, ribetes/puños, forro, y herrajes (botones/cremalleras). */
export const MATERIAL_SLOTS = ['main', 'trim', 'lining', 'hardware'] as const;
export type MaterialSlot = (typeof MATERIAL_SLOTS)[number];

export interface GarmentMeshGroup {
  readonly start: number; // en índices
  readonly count: number;
  readonly slot: MaterialSlot;
}

/** "Pintura" por vértice para la simulación de tela (la deriva el generador, el solver la consume). */
export interface ClothSetup {
  /** Distancia máxima (m) que un vértice puede alejarse de su posición skinneada. 0 = rígido al hueso. */
  readonly maxDistance: Float32Array;
  /** Masa inversa por vértice (0 = anclado). */
  readonly invMass: Float32Array;
  /** 0 (fluida) .. 1 (rígida): escala de las restricciones de flexión. */
  readonly stiffness: number;
  /** 0..1 amortiguación de velocidad por paso. */
  readonly damping: number;
}

/**
 * Geometría de una prenda YA ajustada a un cuerpo y a una talla concretos.
 * Skinneada al esqueleto canónico, con UVs para texturas PBR tileables en metros (ver `uvMetersPerTile`).
 */
export interface GarmentGeometry {
  readonly garmentId: string;
  readonly sizeLabel: string;
  readonly slot: GarmentSlot;
  readonly mesh: SkinnedMeshData & { readonly uvs: Float32Array };
  readonly groups: readonly GarmentMeshGroup[];
  readonly cloth: ClothSetup;
  /** Oclusión ambiental horneada por vértice 0 (oscuro) .. 1 (abierto). */
  readonly ao: Float32Array;
  /** Regiones del cuerpo que la prenda cubre (la piel de esas zonas puede ocultarse / se usa para oclusión). */
  readonly coversRegions: readonly BodyRegion[];
  /** Metros que cubre una unidad UV en U/V (para que el patrón tenga la escala física correcta). */
  readonly uvMetersPerTile: number;
}

/** Texturas PBR procedurales de un par tela+muestra (RGBA8, tamaño potencia de 2, tileables). */
export interface FabricTextureSet {
  readonly size: number;
  /** sRGB */
  readonly albedo: Uint8Array;
  /** tangent-space, convención OpenGL (+Y arriba) como three.js */
  readonly normal: Uint8Array;
  /** R = oclusión, G = rugosidad, B = metalicidad */
  readonly orm: Uint8Array;
  /** Metros físicos de una repetición de la textura (= FabricDef.tileCm/100) */
  readonly tileMeters: number;
}

import type { WorldCapsule } from './body.js';

/**
 * Solver de tela (PBD con restricciones de distancia máxima al estado skinneado, como motores de juegos).
 * Debe ser ESTABLE: nunca producir NaN/Inf ni "explotar", sea cual sea la entrada (pose extrema, dt grande, saltos).
 */
export interface ClothSolver {
  readonly vertexCount: number;
  /**
   * @param dtSeconds paso de tiempo real (se acota internamente)
   * @param skinned posiciones skinneadas objetivo (xyz por vértice)
   * @param capsules colisionadores del cuerpo en mundo
   * @param out posiciones resultantes (xyz por vértice), misma longitud que `skinned`
   */
  step(
    dtSeconds: number,
    skinned: Float32Array,
    capsules: readonly WorldCapsule[],
    out: Float32Array,
  ): void;
  /** Intensidad de arrugas 0..1 por vértice del último paso (compresión de aristas respecto al reposo). */
  readonly wrinkle: Float32Array;
  /** Descarta el estado dinámico (p. ej. tras pérdida de tracking o cambio de prenda). */
  reset(): void;
}
