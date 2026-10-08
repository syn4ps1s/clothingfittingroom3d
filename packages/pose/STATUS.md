# @fitroom/pose — estado

READY v1: createSyntheticPoseProvider, poseToSkeleton, OneEuroFilter, PoseSmoother, createPoseRetargeter, synthesizeFrame, skeletonFromState, samplePlausiblePose, rasterizeMeshMask, renderCapsuleMask

NO listos todavía (siguen siendo stubs que lanzan `NotImplementedError`): `createMediaPipePoseProvider`, `createScanSession`, `estimateMeasurementsFromFrame`.

## Cómo integrar (MIRROR)

```ts
import { buildRestSkeleton, forwardKinematics } from '@fitroom/shared';
import { createSyntheticPoseProvider, PoseSmoother, createPoseRetargeter } from '@fitroom/pose';

const provider = createSyntheticPoseProvider({
  heightCm: 178,
  script: [
    { pose: 'a-pose', durationMs: 2000 },
    { pose: 'walk', durationMs: 4000 },
    { pose: 'turn', durationMs: 4000 },
  ],
  seed: 1,
  startAtFirstDetect: true, // el guion arranca en la primera llamada a detect()
  endBehavior: 'loop',
  noiseSigmaM: 0.004, // ruido gaussiano con semilla (m)
});
await provider.init();
const smoother = new PoseSmoother();
const retargeter = createPoseRetargeter(rest, { verticalFovDeg: 55, aspect: 4 / 3 }); // con memoria (última pose buena)
// por fotograma:
const frame = smoother.smooth(provider.detect(video, performance.now()));
const skeletonPose = frame && retargeter.update(frame); // SkeletonPose | null
```

- `poseToSkeleton(frame, rest, camera)` es la versión SIN estado (cada llamada parte del reposo).
- `createPoseRetargeter(rest, camera)` mantiene la última rotación buena por articulación (sin parpadeos al perder un landmark).
- `provider.groundTruth(t)` da el esqueleto exacto del guion en el instante `t` (útil para asserts).
- Opciones adversariales: `faults: { dropouts, dropoutRate, occlusions, extraPeople, walkOuts, teleports }`, `baseYawDeg: 180` (de espaldas), `distanceM`, `camera`, `mask: true` (silueta sintética).
- Convención: la imagen NO está espejada; `rootPosition` es la pelvis en espacio cámara (cámara en el origen mirando a −Z).

Métricas v1 (round-trip esqueleto → landmarks sintéticos → `poseToSkeleton` → FK): error máximo < 0,5 cm en extremidades y < 1,5 cm en todas las articulaciones para los guiones estándar (a-pose, t-pose, arms-up, walk, turn, sit). Detalle en los tests (`src/retarget.test.ts`).
