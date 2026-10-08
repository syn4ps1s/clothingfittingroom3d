import type { SkinnedMeshData } from './mesh.js';
import type { Measurements } from './measurements.js';
import type { RestSkeleton } from './skeleton.js';

/** Regiones anatómicas por vértice del cuerpo (las prendas las usan para recortar y ocultar piel). */
export const BODY_REGIONS = [
  'head',
  'neck',
  'torso',
  'l_arm',
  'r_arm',
  'l_hand',
  'r_hand',
  'pelvis',
  'l_leg',
  'r_leg',
  'l_foot',
  'r_foot',
] as const;
export type BodyRegion = (typeof BODY_REGIONS)[number];

/** Cápsula de colisión anclada a dos articulaciones (para tela, oclusión barata y tests de penetración). */
export interface CapsuleCollider {
  readonly name: string;
  /** índices de joint (ver J en skeleton.ts); los extremos siguen a esos joints. */
  readonly jointA: number;
  readonly jointB: number;
  /** Punto a lo largo de cada joint en espacio local de reposo = posición de reposo del joint + offset. */
  readonly offsetA: readonly [number, number, number];
  readonly offsetB: readonly [number, number, number];
  readonly radius: number;
}

/**
 * Modelo de cuerpo paramétrico listo para skinning.
 * `mesh` está en A-pose de reposo, con los pies sobre y=0 y centrado en x=0, z≈0.
 */
export interface BodyModel {
  readonly measurements: Measurements;
  readonly skeleton: RestSkeleton;
  readonly mesh: SkinnedMeshData;
  /** índice de BODY_REGIONS por vértice */
  readonly regions: Uint8Array;
  readonly colliders: readonly CapsuleCollider[];
}

/** Cápsula ya transformada a espacio mundo para un fotograma concreto. */
export interface WorldCapsule {
  readonly a: readonly [number, number, number];
  readonly b: readonly [number, number, number];
  readonly radius: number;
}
