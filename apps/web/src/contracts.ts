/**
 * CONTRATO DE FRONTERA entre agentes WORLD (mundo 3D + UI) y MIRROR (cámara + espejo + runtime).
 * Congelado: cambios sólo coordinados con el orquestador. Se permiten ampliaciones ADITIVAS.
 */
import type {
  BodyModel,
  FabricDef,
  FabricTextureSet,
  GarmentDefinition,
  GarmentGeometry,
  MeasurementEstimate,
  Measurements,
  ScanProgress,
  SkeletonPose,
  SwatchVariant,
} from '@fitroom/shared';

// ---------- Cámara ----------
export type CameraStatus =
  | 'idle'
  | 'requesting' // esperando el permiso del navegador
  | 'ready'
  | 'denied' // el usuario rechazó el permiso
  | 'unavailable' // sin dispositivo de cámara
  | 'insecure-context' // no https ni localhost
  | 'error';

export interface CameraController {
  readonly status: CameraStatus;
  /** Elemento <video> en reproducción cuando status === 'ready'. NUNCA se envía por red. */
  readonly video: HTMLVideoElement | null;
  readonly errorMessage?: string;
  /** Debe invocarse desde un gesto del usuario (clic en «Encender cámara»). */
  start(): Promise<void>;
  stop(): void;
}

// ---------- Espejo ----------
export interface EquippedItem {
  readonly garment: GarmentDefinition;
  readonly fabric: FabricDef;
  readonly trimFabric?: FabricDef;
  readonly variant: SwatchVariant;
  readonly sizeLabel: string;
}

export type TrackingState = 'initializing' | 'searching' | 'tracking' | 'lost';

/** De dónde sale la pose: la cámara real, o un guion sintético (tests, demo sin cámara). */
export type PoseSourceKind = 'camera' | 'synthetic';

export interface MirrorStageProps {
  /** Tamaño del espejo en unidades de mundo (m); la relación de aspecto debe respetar la del vídeo. */
  readonly width: number;
  readonly height: number;
  readonly measurements: Measurements;
  readonly equipped: readonly EquippedItem[];
  readonly poseSource: PoseSourceKind;
  readonly camera: CameraController;
  /** Efecto espejo horizontal (por defecto true). */
  readonly mirrored?: boolean;
  /** Calidad: 'low' desactiva sombras/simulación secundaria en equipos modestos. */
  readonly quality?: 'low' | 'medium' | 'high';
  readonly onTrackingChange?: (state: TrackingState) => void;
  /** Se invoca en cada tick de métricas (≈1 Hz) para HUD de depuración / pruebas de rendimiento. */
  readonly onStats?: (stats: MirrorStats) => void;
}

export interface MirrorStats {
  readonly fps: number;
  readonly poseMs: number;
  readonly skinMs: number;
  readonly clothMs: number;
  readonly triangles: number;
}

/** Imperativo expuesto vía ref por <MirrorStage>. */
export interface MirrorHandle {
  /** Foto del espejo (vídeo + prendas) como PNG. Sólo local: el navegador la descarga, jamás se sube. */
  capture(): Promise<Blob>;
}

// ---------- Escaneo de talla ----------
export interface BodyScanApi {
  readonly progress: ScanProgress;
  /** Estimación final (con incertidumbres) cuando progress.phase === 'complete'. */
  readonly estimate: MeasurementEstimate | null;
  /** Arranca el escaneo con la estatura declarada (necesaria para la escala métrica). */
  start(heightCm: number): void;
  cancel(): void;
}

// ---------- Modelos 3D listos para render (orquestación de body + garments + texturas) ----------
export interface LoadedGarment {
  readonly item: EquippedItem;
  readonly geometry: GarmentGeometry;
  readonly textures: { readonly main: FabricTextureSet; readonly trim?: FabricTextureSet };
}

export interface FittingModels {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly body: BodyModel | null;
  readonly garments: readonly LoadedGarment[];
  readonly errorMessage?: string;
}

/** Vista estática/animada de una prenda ya cargada (para maniquíes del perchero, muestras y vista previa). */
export interface GarmentViewProps {
  readonly garment: LoadedGarment;
  readonly body: BodyModel;
  /** Pose del esqueleto (por defecto, reposo). */
  readonly pose?: SkeletonPose;
  /** Activar simulación de tela secundaria (por defecto false en vitrinas). */
  readonly simulate?: boolean;
  readonly quality?: 'low' | 'medium' | 'high';
}

export interface BodyMannequinProps {
  readonly body: BodyModel;
  readonly pose?: SkeletonPose;
  /** 'mannequin' = maniquí mate de atelier; 'ghost' = translúcido; 'occluder' = sólo profundidad (invisible). */
  readonly look?: 'mannequin' | 'ghost' | 'occluder';
}

/**
 * Exports obligatorios (los implementa MIRROR; los consume WORLD):
 *   camera/index.ts  : useCamera(): CameraController
 *   mirror/index.ts  : MirrorStage (forwardRef<MirrorHandle, MirrorStageProps>)
 *                      useBodyScan(camera: CameraController, source: PoseSourceKind): BodyScanApi
 *                      useFittingModels(measurements: Measurements | null, equipped: readonly EquippedItem[]): FittingModels
 *                      GarmentView (R3F, props GarmentViewProps), BodyMannequin (R3F, props BodyMannequinProps)
 *
 * Mientras MIRROR no entregue, WORLD desarrolla contra mocks propios (apps/web/src/world/dev/) y
 * integra lo real en cuanto exista `apps/web/src/mirror/STATUS.md` con "READY".
 */
export type { ScanProgress };
