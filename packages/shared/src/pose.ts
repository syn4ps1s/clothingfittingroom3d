import type { MeasurementEstimate } from './measurements.js';
import type { RestSkeleton, SkeletonPose } from './skeleton.js';

/** Número de landmarks de MediaPipe Pose. */
export const POSE_LANDMARK_COUNT = 33;

/** Índices de MediaPipe Pose Landmarker (los "left/right" son de la PERSONA, no de la imagen). */
export const LM = {
  nose: 0,
  l_eye_inner: 1,
  l_eye: 2,
  l_eye_outer: 3,
  r_eye_inner: 4,
  r_eye: 5,
  r_eye_outer: 6,
  l_ear: 7,
  r_ear: 8,
  mouth_l: 9,
  mouth_r: 10,
  l_shoulder: 11,
  r_shoulder: 12,
  l_elbow: 13,
  r_elbow: 14,
  l_wrist: 15,
  r_wrist: 16,
  l_pinky: 17,
  r_pinky: 18,
  l_index: 19,
  r_index: 20,
  l_thumb: 21,
  r_thumb: 22,
  l_hip: 23,
  r_hip: 24,
  l_knee: 25,
  r_knee: 26,
  l_ankle: 27,
  r_ankle: 28,
  l_heel: 29,
  r_heel: 30,
  l_foot_index: 31,
  r_foot_index: 32,
} as const;

export interface ImageLandmark {
  /** 0..1, izquierda→derecha de la imagen SIN espejar */
  readonly x: number;
  /** 0..1, arriba→abajo */
  readonly y: number;
  /** profundidad relativa (≈ misma escala que x) */
  readonly z: number;
  /** 0..1 */
  readonly visibility: number;
}

export interface WorldLandmark {
  /** Metros, origen en el centro de las caderas. Ya en convención del proyecto: +X izquierda de la persona, +Y arriba, +Z hacia la cámara. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly visibility: number;
}

export interface SegmentationMask {
  readonly width: number;
  readonly height: number;
  /** 0..255 (probabilidad de persona) */
  readonly data: Uint8Array;
}

/** Una detección de pose en un instante (salida de cualquier PoseProvider). */
export interface PoseFrame {
  readonly timestampMs: number;
  readonly imageSize: { readonly width: number; readonly height: number };
  readonly image: readonly ImageLandmark[];
  readonly world: readonly WorldLandmark[];
  readonly mask?: SegmentationMask;
  /** nº de personas detectadas en el fotograma (solo se usa la principal) */
  readonly personCount: number;
}

/** Opaco para mantener los paquetes core sin DOM. En el navegador: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | ImageBitmap. */
export type PoseSource = object;

/**
 * Puerto de detección de pose. Implementaciones: MediaPipe (navegador, on-device) y Sintético (tests/e2e).
 * `detect` devuelve null si no hay persona.
 */
export interface PoseProvider {
  readonly name: string;
  init(): Promise<void>;
  detect(source: PoseSource, timestampMs: number): PoseFrame | null;
  dispose(): void;
}

export interface CameraIntrinsics {
  /** Campo de visión vertical (grados). Webcams típicas: 50–65. */
  readonly verticalFovDeg: number;
  /** ancho/alto */
  readonly aspect: number;
}

/** Función de retargeting (implementada en @fitroom/pose). */
export type PoseToSkeleton = (
  frame: PoseFrame,
  rest: RestSkeleton,
  camera: CameraIntrinsics,
) => SkeletonPose | null;

// ---- Escaneo guiado de talla ----

export const SCAN_PHASES = [
  'idle',
  'searching',
  'adjusting',
  'hold',
  'capturing',
  'complete',
  'failed',
] as const;
export type ScanPhase = (typeof SCAN_PHASES)[number];

/** Pistas para el usuario (claves i18n, nunca texto). */
export const SCAN_HINTS = [
  'ok',
  'no-person',
  'multiple-people',
  'step-back',
  'step-closer',
  'show-full-body',
  'face-camera',
  'raise-arms-a-pose',
  'hold-still',
  'too-dark',
  'move-to-center',
] as const;
export type ScanHint = (typeof SCAN_HINTS)[number];

export interface ScanProgress {
  readonly phase: ScanPhase;
  readonly hint: ScanHint;
  /** 0..1 */
  readonly progress: number;
  readonly framesUsed: number;
}

export interface ScanSession {
  /** Alimentar con cada fotograma (o null si no hay persona). `lumaMean` 0..255 opcional para detectar poca luz. */
  push(frame: PoseFrame | null, nowMs: number, lumaMean?: number): ScanProgress;
  /** Disponible sólo cuando phase === 'complete'. */
  result(): MeasurementEstimate | null;
  reset(): void;
}
