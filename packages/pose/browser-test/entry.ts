// Punto de entrada del bundle para el test de integración en navegador (no forma parte del paquete).
import {
  createMediaPipePoseProvider,
  PoseProviderError,
  convertPoseResult,
} from '../src/mediapipe.js';
import { poseToSkeleton } from '../src/retarget.js';

(window as unknown as Record<string, unknown>)['__pose'] = {
  createMediaPipePoseProvider,
  PoseProviderError,
  convertPoseResult,
  poseToSkeleton,
};
