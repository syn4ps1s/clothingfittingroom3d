import {
  JOINT_COUNT,
  forwardKinematics,
  q,
  v3,
  type CameraIntrinsics,
  type PoseFrame,
  type RestSkeleton,
  type SkeletonPose,
} from '@fitroom/shared';
import { cameraScales, sanitizeCamera } from './camera.js';
import { poseToSkeleton } from './retarget.js';
import { skeletonFromState, synthesizeFrame } from './synthetic.js';
import type { PoseState } from './poses.js';

/** Utilidades de prueba reutilizables (round-trip esqueleto → landmarks → esqueleto). */

/** Error de posición (m) de cada articulación entre dos poses, por cinemática directa. */
export function jointPositionErrors(
  rest: RestSkeleton,
  truth: SkeletonPose,
  estimate: SkeletonPose,
): number[] {
  const a = forwardKinematics(rest, truth).positions;
  const b = forwardKinematics(rest, estimate).positions;
  const out: number[] = [];
  for (let i = 0; i < JOINT_COUNT; i++) out.push(v3.distance(a[i]!, b[i]!));
  return out;
}

export interface RoundTripOptions {
  readonly camera?: CameraIntrinsics;
  readonly distanceM?: number;
  readonly cameraHeightM?: number;
  readonly noiseSigmaM?: number;
  readonly seed?: number;
  readonly baseYawDeg?: number;
  readonly landmarkBias?: 'none' | 'mediapipe-like';
}

export interface RoundTripResult {
  readonly truth: SkeletonPose;
  readonly frame: PoseFrame;
  readonly estimate: SkeletonPose | null;
  /** error de posición por articulación (m); vacío si no hubo estimación */
  readonly errors: number[];
}

/** Esqueleto en un estado de pose → landmarks sintéticos → `poseToSkeleton` → errores de FK. */
export function roundTrip(
  rest: RestSkeleton,
  state: PoseState,
  o: RoundTripOptions = {},
): RoundTripResult {
  const camera = sanitizeCamera(o.camera ?? { verticalFovDeg: 55, aspect: 4 / 3 });
  const s = cameraScales(camera);
  const distanceM = o.distanceM ?? rest.height / (0.66 * 2 * s.tanY);
  const cameraHeightM = o.cameraHeightM ?? 0.52 * rest.height;
  const truth = skeletonFromState(rest, state, {
    distanceM,
    cameraHeightM,
    baseYawRad: ((o.baseYawDeg ?? 0) * Math.PI) / 180,
  });
  const frame = synthesizeFrame(rest, truth, 0, {
    camera,
    imageSize: { width: Math.round(720 * camera.aspect), height: 720 },
    noiseSigmaM: o.noiseSigmaM ?? 0,
    seed: o.seed ?? 1,
    landmarkBias: o.landmarkBias ?? 'none',
  });
  const estimate = poseToSkeleton(frame, rest, camera);
  return {
    truth,
    frame,
    estimate,
    errors: estimate ? jointPositionErrors(rest, truth, estimate) : [],
  };
}

/** ¿Todos los números de la pose son finitos y los cuaterniones unitarios? */
export function poseIsSane(p: SkeletonPose): boolean {
  if (!v3.isFinite(p.rootPosition) || !Number.isFinite(p.confidence)) return false;
  if (p.rotations.length !== JOINT_COUNT || p.jointConfidence.length !== JOINT_COUNT) return false;
  for (const r of p.rotations) {
    if (!q.isFinite(r)) return false;
    if (Math.abs(Math.hypot(r[0], r[1], r[2], r[3]) - 1) > 1e-6) return false;
  }
  return p.jointConfidence.every((c) => Number.isFinite(c) && c >= 0 && c <= 1);
}
