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

// ---- Escaneo de talla y estimación de medidas -------------------------------------------------------
export { createScanSession, ALL_SCAN_HINTS } from './scan.js';
export type { ScanSessionOptions, ScanSessionExt, ScanDiagnostics } from './scan.js';
export { estimateMeasurements, estimateMeasurementsFromFrame, frameGeometry } from './measure.js';
export type { EstimatorOptions, MeasureDetails, ScaleEvidence } from './measure.js';
export { assessFrame, motionBetween, DEFAULT_THRESHOLDS } from './quality.js';
export type { FrameQuality, QualityThresholds } from './quality.js';
export { measureSilhouette, runEdges, levelAnchors, rowOfLevel, estimatePxPerMeter } from './girth.js';
export type { SilhouetteWidths } from './girth.js';
export { robustLocation, fuse, mad, MAD_TO_SIGMA } from './robust.js';
export { girthPrior, predictGirth, GIRTH_COEF, RESIDUAL_SIGMA, PRIOR_BMI } from './anthropometry.js';
export * as calibration from './calibration.js';
