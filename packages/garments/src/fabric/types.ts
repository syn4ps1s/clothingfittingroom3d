import type { FabricDef, FabricFamily, FabricTextureSet, SwatchVariant } from '@fitroom/shared';
import type { RGB } from './color.js';

/**
 * Convención de ejes de las texturas (IMPORTANTE para el consumidor):
 *  - Fila 0 del buffer = v = 0 (abajo), columna 0 = u = 0, tal y como espera un `DataTexture` de
 *    three.js con `flipY = false`. La normal es tangent-space OpenGL (+Y = dirección de v creciente).
 *  - La urdimbre (warp) corre a lo largo de v (vertical) y la trama (weft) a lo largo de u.
 */

/** Cómo se resolvió la escala del tejido y del patrón (para tests, documentación y depuración). */
export interface FabricTextureInfo {
  readonly family: FabricFamily;
  readonly seed: number;
  readonly size: number;
  /** hilos (o puntadas) por tile pedidos: `threadsPerCm × tileCm` */
  readonly requestedThreadsAcrossTile: number;
  /** hilos/columnas de punto en u realmente usados (entero, múltiplo del repetido del tejido) */
  readonly threadsAcrossTile: number;
  /** hilos/hileras en v realmente usados */
  readonly threadsAlongTile: number;
  readonly pxPerThread: number;
  /** densidad efectiva (hilos/cm) tras ajustes */
  readonly effectiveThreadsPerCm: number;
  /** `true` si hubo que bajar la frecuencia para mantener ≥ 8 px por hilo */
  readonly frequencyLowered: boolean;
  /** repetición del ligamento (hilos en u × v) */
  readonly weaveRepeat: { readonly u: number; readonly v: number };
  /** intensidad aplicada al mapa normal */
  readonly normalStrength: number;
  /** ajuste del patrón al tile, si hay patrón */
  readonly pattern?: PatternFitInfo;
}

export interface PatternFitInfo {
  readonly type: SwatchVariant['pattern']['type'];
  /** periodo pedido (mm); para plaid/herringbone/floral es sizeMm/scaleMm; para dots spacingMm */
  readonly requestedPeriodMm: number;
  /** periodo efectivo (mm) = tileMm / repeats */
  readonly effectivePeriodMm: number;
  /** repeticiones enteras en el tile */
  readonly repeats: number;
  readonly requestedAngleDeg?: number;
  readonly effectiveAngleDeg?: number;
  /** factor de escala aplicado a anchos/radios (efectivo/pedido) */
  readonly scale: number;
}

/** Resultado de `generateFabricTextures`: es un `FabricTextureSet` más metadatos. */
export interface FabricTextureResult extends FabricTextureSet {
  readonly info: FabricTextureInfo;
}

/** Unidad de trabajo acotada (una banda de filas, etc.) para poder ceder al event loop entre pasos. */
export type Step = () => void;

/** Campos intermedios (todos size×size). Un "pase" por familia los rellena. */
export interface Fields {
  readonly size: number;
  /** relieve 0..1 aprox. (0 = fondo, 1 = lo más alto) */
  readonly H: Float32Array;
  /** tono multiplicativo (≈1) */
  readonly T: Float32Array;
  /** mezcla 0..1 hacia el color secundario de la familia */
  readonly M: Float32Array;
  /** desplazamiento aditivo de rugosidad */
  readonly R: Float32Array;
}

export interface SecondaryColor {
  /** color objetivo (lineal) hacia el que mezcla M */
  readonly target: RGB;
  /** cuánto llega M=1 hacia `target` (0..1) */
  readonly k: number;
}

/** Contexto común que reciben los constructores de familia. */
export interface FamilyContext {
  readonly fabric: FabricDef;
  readonly variant: SwatchVariant;
  readonly size: number;
  readonly seed: number;
  readonly fields: Fields;
  /** filas por banda (paso de trabajo) */
  readonly rowsPerBand: number;
  /** color base (lineal) */
  readonly base: RGB;
  /** registra un paso */
  push(step: Step): void;
  /** registra un recorrido por bandas de filas */
  bands(fn: (y0: number, y1: number) => void): void;
}

/** Salida de un constructor de familia. */
export interface FamilyPlan {
  /** píxeles de la textura por "unidad de relieve" (hilo, puntada, grano) → normaliza gradientes */
  readonly bumpUnitPx: number;
  /** intensidad base del mapa normal (antes del factor por tela) */
  readonly normalStrength: number;
  /** intensidad de la oclusión de cavidades 0..1 */
  readonly aoStrength: number;
  /** radio (px) del desenfoque para las cavidades */
  readonly aoRadiusPx: number;
  readonly secondary: SecondaryColor | null;
  /** normalizar el tono medio a 1 para respetar `variant.color` */
  readonly normalizeTone: boolean;
  /** metalicidad constante (0 para todas las telas) */
  readonly metal: number;
  /** rejilla de hilos para "pegar" franjas/cuadros a los hilos (null = sin ajuste) */
  readonly grid: { readonly nu: number; readonly nv: number } | null;
  readonly threadsAcrossTile: number;
  readonly threadsAlongTile: number;
  readonly pxPerThread: number;
  readonly weaveRepeat: { readonly u: number; readonly v: number };
  /** rugosidad base (si difiere de fabric.roughness) */
  readonly roughnessBase?: number;
}

export type FamilyBuilder = (ctx: FamilyContext) => FamilyPlan;
