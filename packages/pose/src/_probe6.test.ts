import { describe, it } from 'vitest';
import { REFERENCE_MEASUREMENTS, computeSkinMatrices, skinPositions, type Measurements } from '@fitroom/shared';
import { buildBody } from '@fitroom/body';
import { createSyntheticPoseProvider } from './synthetic.js';
import { rasterizeMeshMask } from './silhouette.js';
import { estimateMeasurements } from './measure.js';

describe('probe6', () => {
  it('estimator vs body meshes', () => {
    for (const [name, m] of Object.entries(REFERENCE_MEASUREMENTS) as [string, Measurements][]) {
      const body = buildBody(m);
      const prov = createSyntheticPoseProvider({
        heightCm: m.heightCm, measurements: m, rest: body.skeleton, landmarkBias: 'mediapipe-like',
        script: [{ pose: 'a-pose', durationMs: 3000 }], seed: 4, noiseSigmaM: 0.006,
      });
      const frames = [];
      for (let t = 500; frames.length < 45; t += 33) {
        const f = prov.frameAt(t)!;
        const pose = prov.groundTruth(t);
        const mats = computeSkinMatrices(body.skeleton, pose);
        const verts = skinPositions(body.mesh.positions, body.mesh.skinIndices, body.mesh.skinWeights, mats);
        const mask = rasterizeMeshMask({ positions: verts, indices: body.mesh.indices, camera: prov.camera, width: 256, height: Math.round(256 / prov.camera.aspect) });
        frames.push({ ...f, mask });
      }
      const withWeight = estimateMeasurements(frames, m.heightCm, { weightKg: m.weightKg, bodyBase: m.bodyBase });
      const noWeight = estimateMeasurements(frames, m.heightCm, {});
      const keys = ['shoulderWidthCm', 'armLengthCm', 'inseamCm', 'chestCm', 'waistCm', 'hipCm', 'neckCm', 'thighCm'] as const;
      console.warn(name, JSON.stringify(withWeight.details, (k, v) => (typeof v === 'number' ? +v.toFixed(3) : v)));
      for (const k of keys) {
        const a = withWeight.estimate[k]!, b = noWeight.estimate[k]!;
        console.warn(`  ${k.padEnd(16)} truth ${m[k]!.toFixed(1)}  w/weight ${a.value.toFixed(1)} ±${a.sigma.toFixed(1)} (${(a.value - m[k]!).toFixed(1)})  no-weight ${b.value.toFixed(1)} ±${b.sigma.toFixed(1)} (${(b.value - m[k]!).toFixed(1)}) [${a.source}]`);
      }
    }
  });
});
