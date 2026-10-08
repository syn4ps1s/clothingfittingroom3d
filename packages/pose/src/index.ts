import {
  NotImplementedError,
  type CameraIntrinsics,
  type MeasurementEstimate,
  type PoseFrame,
  type PoseProvider,
  type PoseToSkeleton,
  type ScanSession,
} from '@fitroom/shared';

export interface MediaPipeOptions {
  /** URL del .task (p. ej. /models/pose_landmarker_lite.task) — mismo origen */
  readonly modelUrl: string;
  /** URL base de los WASM (p. ej. /wasm) — mismo origen */
  readonly wasmBaseUrl: string;
  readonly runningMode?: 'VIDEO' | 'IMAGE';
  readonly outputSegmentationMask?: boolean;
}

/** Detector real on-device. STUB — implementar en el agente POSE. */
export function createMediaPipePoseProvider(_opts: MediaPipeOptions): PoseProvider {
  throw new NotImplementedError('pose.createMediaPipePoseProvider');
}

/** Guion determinista de poses para tests / e2e sin cámara. STUB. */
export type SyntheticPoseName =
  'a-pose' | 't-pose' | 'arms-up' | 'walk' | 'turn' | 'sit' | 'jitter';
export function createSyntheticPoseProvider(_opts: {
  readonly heightCm: number;
  readonly script: readonly { readonly pose: SyntheticPoseName; readonly durationMs: number }[];
  readonly seed?: number;
}): PoseProvider {
  throw new NotImplementedError('pose.createSyntheticPoseProvider');
}

/** Landmarks → pose del esqueleto canónico (rotaciones swing + raíz en espacio cámara). STUB. */
export const poseToSkeleton: PoseToSkeleton = () => {
  throw new NotImplementedError('pose.poseToSkeleton');
};

/** Sesión guiada de escaneo de talla. STUB. */
export function createScanSession(_opts: {
  readonly heightCm: number;
  readonly camera: CameraIntrinsics;
}): ScanSession {
  throw new NotImplementedError('pose.createScanSession');
}

/** Estimación a partir de UNA foto (modo foto). STUB. */
export function estimateMeasurementsFromFrame(
  _frame: PoseFrame,
  _heightCm: number,
): MeasurementEstimate {
  throw new NotImplementedError('pose.estimateMeasurementsFromFrame');
}
