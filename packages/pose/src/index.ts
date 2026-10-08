import {
  NotImplementedError,
  type CameraIntrinsics,
  type MeasurementEstimate,
  type PoseFrame,
  type ScanSession,
} from '@fitroom/shared';

// ---- Detector real (MediaPipe, on-device) ---------------------------------------------------------
export {
  createMediaPipePoseProvider,
  PoseProviderError,
  convertPoseResult,
  convertMask,
  primaryPersonScore,
  sourceSize,
} from './mediapipe.js';
export type {
  MediaPipeOptions,
  MediaPipePoseProvider,
  PoseProviderErrorCode,
  RawLandmark,
  RawMask,
  RawPoseResult,
} from './mediapipe.js';

// ---- Proveedor sintético ------------------------------------------------------------------------
export {
  createSyntheticPoseProvider,
  synthesizeFrame,
  skeletonFromState,
  landmarkPositions,
} from './synthetic.js';
export type {
  SyntheticPoseName,
  ExtendedPoseName,
  AnyPoseName,
  SyntheticPoseOptions,
  SyntheticPoseProvider,
  SyntheticFaults,
  SynthesisOptions,
  PlacementOptions,
  OcclusionGroup,
  TimeWindow,
} from './synthetic.js';
export { ALL_POSE_NAMES, evalPose, blendPoseStates, samplePlausiblePose } from './poses.js';
export type { PoseState } from './poses.js';
export { renderCapsuleMask, rasterizeMeshMask, ellipseAxes } from './silhouette.js';
export type { CapsuleMaskInput, MeshMaskInput } from './silhouette.js';

// ---- Retargeting y suavizado ---------------------------------------------------------------------
export { poseToSkeleton, createPoseRetargeter } from './retarget.js';
export type { PoseRetargeter, RetargetOptions } from './retarget.js';
export { JOINT_LIMITS, applyJointLimit } from './limits.js';
export {
  OneEuroFilter,
  PoseSmoother,
  DEFAULT_IMAGE_FILTER,
  DEFAULT_WORLD_FILTER,
} from './filters.js';
export type { OneEuroOptions, PoseSmootherOptions } from './filters.js';

// ---- Utilidades de cámara y rig ------------------------------------------------------------------
export {
  cameraScales,
  rayFromNormalized,
  projectToNormalized,
  sanitizeCamera,
  DEFAULT_CAMERA,
} from './camera.js';
export { defaultMeasurementsForHeight, defaultRestForHeight, restLandmarks } from './rig.js';

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
