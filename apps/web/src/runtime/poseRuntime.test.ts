import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  J,
  REFERENCE_MEASUREMENTS,
  buildRestSkeleton,
  forwardKinematics,
  type SkeletonPose,
} from '@fitroom/shared';
import { installFakeCanvas } from '../test-utils/fakeCanvas';
import type { LoopHost } from './detectionLoop';
import { createSyntheticFeed, type SyntheticFeed } from './feeds';
import { PoseRuntime } from './poseRuntime';

class FakeHost implements LoopHost {
  t = 1000;
  private id = 1;
  private cbs = new Map<number, (t: number) => void>();
  raf(cb: (t: number) => void) {
    const i = this.id++;
    this.cbs.set(i, cb);
    return i;
  }
  caf(i: number) {
    this.cbs.delete(i);
  }
  now() {
    return this.t;
  }
  isHidden() {
    return false;
  }
  frame(dt: number) {
    this.t += dt;
    const cbs = [...this.cbs.values()];
    this.cbs.clear();
    cbs.forEach((c) => c(this.t));
  }
}

const M = REFERENCE_MEASUREMENTS.adultA;
const rest = buildRestSkeleton(M);

function jointError(a: SkeletonPose, b: SkeletonPose, joints: readonly number[]): number {
  const fa = forwardKinematics(rest, a).positions;
  const fb = forwardKinematics(rest, b).positions;
  let worst = 0;
  for (const j of joints) {
    const pa = fa[j]!,
      pb = fb[j]!;
    worst = Math.max(worst, Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]));
  }
  return worst;
}

describe('PoseRuntime con el proveedor sintético real (@fitroom/pose)', () => {
  let canvas: ReturnType<typeof installFakeCanvas>;
  let host: FakeHost;
  let synth: SyntheticFeed;
  let runtime: PoseRuntime;

  beforeEach(async () => {
    canvas = installFakeCanvas();
    host = new FakeHost();
    synth = createSyntheticFeed({
      heightCm: M.heightCm,
      measurements: M,
      fovDeg: 55,
      script: [
        { pose: 'a-pose', durationMs: 2000 },
        { pose: 'arms-up', durationMs: 2000 },
      ],
      noiseSigmaM: 0.003,
      host,
    });
    runtime = new PoseRuntime({
      feed: synth.feed,
      getRest: () => rest,
      getIntrinsics: () => ({ verticalFovDeg: 55, aspect: 1280 / 720 }),
      now: () => host.t,
    });
    await synth.feed.start();
  });

  afterEach(() => {
    runtime.dispose();
    synth.dispose();
    canvas.restore();
  });

  it('pasa initializing → searching → tracking y las prendas aparecen con suavidad', () => {
    expect(runtime.tracking.state).toBe('searching');
    const states: string[] = [];
    runtime.onTrackingChange((s) => states.push(s));
    const vis: number[] = [];
    for (let i = 0; i < 90; i++) {
      host.frame(1000 / 60);
      vis.push(runtime.sample(host.t).visibility);
    }
    expect(states).toEqual(['tracking']);
    expect(vis[vis.length - 1]).toBe(1);
    for (let i = 1; i < vis.length; i++) expect(vis[i]! - vis[i - 1]!).toBeLessThan(0.15);
  });

  it('la pose mostrada sigue a la verdad de terreno (articulaciones a < 6 cm en A-pose)', () => {
    for (let i = 0; i < 100; i++) host.frame(1000 / 60);
    const s = runtime.sample(host.t);
    expect(s.pose).not.toBeNull();
    const truth = synth.groundTruth(synth.scriptTime());
    const err = jointError(s.pose!, truth, [
      J.pelvis,
      J.chest,
      J.l_upper_arm,
      J.r_upper_arm,
      J.l_forearm,
      J.r_forearm,
      J.l_thigh,
      J.l_calf,
    ]);
    expect(err).toBeLessThan(0.06);
  });

  it('movimiento (A-pose → brazos arriba): sin NaN y sin saltos entre fotogramas de render', () => {
    let prev: SkeletonPose | null = null;
    let prevPos: number[] | null = null;
    let maxStep = 0;
    // 3,6 s: un solo ciclo del guion (el salto de fin a inicio del bucle es de la propia verdad de terreno)
    for (let i = 0; i < 216; i++) {
      host.frame(1000 / 60);
      const s = runtime.sample(host.t);
      if (!s.pose) continue;
      const fk = forwardKinematics(rest, s.pose).positions;
      const flat = fk.flatMap((p) => [p[0], p[1], p[2]]);
      expect(flat.every(Number.isFinite)).toBe(true);
      if (prevPos && s.visibility > 0.99) {
        for (let k = 0; k < flat.length; k++) maxStep = Math.max(maxStep, Math.abs(flat[k]! - prevPos[k]!));
      }
      prevPos = flat;
      prev = s.pose;
    }
    void prev;
    // brazos subiendo ~2 m/s en la punta ⇒ ≈ 3 cm por fotograma; un salto de 12+ cm sería judder
    expect(maxStep).toBeLessThan(0.12);
  });

  it('ráfaga de pérdida de detección: lost → fundido a 0 → recuperación sin parpadeo', () => {
    for (let i = 0; i < 90; i++) {
      host.frame(1000 / 60);
      runtime.sample(host.t);
    }
    expect(runtime.tracking.state).toBe('tracking');
    // la persona sale del cuadro: sin fotograma de vídeo a analizar (null)
    synth.seek(null);
    const inner = (synth.feed as unknown as { deps: { getSource: () => object | null } }).deps;
    const origGet = inner.getSource;
    inner.getSource = () => null; // el feed no entrega eventos (como una cámara congelada)
    let sawLost = false;
    let minVis = 1;
    for (let i = 0; i < 120; i++) {
      host.frame(1000 / 60);
      const s = runtime.sample(host.t);
      if (s.state === 'lost') sawLost = true;
      minVis = Math.min(minVis, s.visibility);
    }
    expect(sawLost).toBe(true);
    expect(minVis).toBeLessThan(0.2);
    inner.getSource = origGet;
    const visBack: number[] = [];
    for (let i = 0; i < 60; i++) {
      host.frame(1000 / 60);
      visBack.push(runtime.sample(host.t).visibility);
    }
    expect(runtime.tracking.state).toBe('tracking');
    // sube de forma monótona (sin parpadeo)
    for (let i = 1; i < visBack.length; i++) expect(visBack[i]!).toBeGreaterThanOrEqual(visBack[i - 1]! - 1e-9);
    expect(visBack[visBack.length - 1]).toBe(1);
  });

  it('mide el coste de pose y el intervalo de detección (≈33 ms)', () => {
    for (let i = 0; i < 120; i++) host.frame(1000 / 60);
    const st = runtime.stats;
    expect(st.detections).toBeGreaterThan(30);
    expect(st.detectIntervalMs).toBeGreaterThan(30);
    expect(st.detectIntervalMs).toBeLessThan(40);
    expect(Number.isFinite(st.poseMs)).toBe(true);
  });

  it('la imagen sintética se dibuja desde la misma detección (versión del vídeo avanza)', () => {
    const v0 = synth.video.version;
    for (let i = 0; i < 30; i++) host.frame(1000 / 60);
    expect(synth.video.version).toBeGreaterThan(v0 + 5);
    expect(canvas.ctx.calls.length).toBeGreaterThan(10);
  });
});
