import { PoseSmoother, createPoseRetargeter } from '@fitroom/pose';
import {
  type CameraIntrinsics,
  type PoseFrame,
  type PoseToSkeleton,
  type RestSkeleton,
  type SkeletonPose,
} from '@fitroom/shared';
import type { TrackingState } from '../contracts';
import { LightEstimator, NEUTRAL_LIGHT, type LightEstimate } from './lightEstimator';
import { PosePredictor } from './posePredictor';
import type { FeedEvent, PoseFeed } from './poseFeed';
import { TrackingMachine, type TrackingConfig } from './trackingMachine';

/** Lo que consume el render en cada fotograma. El objeto se REUTILIZA: no conservarlo. */
export interface RuntimeSample {
  /** Pose a mostrar ahora (interpolada/predicha). null si nunca hubo detección. */
  pose: SkeletonPose | null;
  /** 0..1 — opacidad global de las prendas (fundido suave al perder/recuperar el seguimiento). */
  visibility: number;
  state: TrackingState;
  light: LightEstimate;
  /** Última detección suavizada (para superposiciones y máscara de segmentación). */
  frame: PoseFrame | null;
  /** Sube cada vez que la pose "salta" (re-adquisición): el solver de tela debe reiniciarse. */
  teleportCount: number;
}

export interface PoseRuntimeStats {
  /** Coste medio por detección: proveedor + suavizado + retargeting (ms). */
  poseMs: number;
  /** Intervalo actual entre detecciones (ms). */
  detectIntervalMs: number;
  detections: number;
}

export interface PoseRuntimeDeps {
  readonly feed: PoseFeed;
  /** Esqueleto de reposo del cuerpo actual (null mientras no esté construido). */
  readonly getRest: () => RestSkeleton | null;
  /** Intrínsecos asumidos de la cámara (FOV vertical ajustable). */
  readonly getIntrinsics: () => CameraIntrinsics;
  /** Origen de imagen para estimar la luz (vídeo o canvas); opcional. */
  readonly getLightSource?: () => (CanvasImageSource & { videoWidth?: number; videoHeight?: number }) | null;
  /** Retargeting alternativo (tests). Por defecto, el retargeter CON memoria de @fitroom/pose. */
  readonly retarget?: PoseToSkeleton;
  readonly createSmoother?: () => { smooth(f: PoseFrame | null): PoseFrame | null; reset(): void };
  readonly now?: () => number;
  /** Umbrales de la máquina de seguimiento (equipos lentos / pruebas con render software). */
  readonly trackingConfig?: Partial<TrackingConfig>;
  /** Intervalo (ms) entre muestreos de luz. Por defecto 250. */
  readonly lightEveryMs?: number;
}

/**
 * Tubería de pose en tiempo real: feed (≤30 Hz) → suavizado de landmarks → retargeting al esqueleto
 * canónico → predictor (60 Hz) + máquina de seguimiento + estimación de luz.
 * `sample(now)` se llama una vez por fotograma de render.
 */
export class PoseRuntime {
  readonly tracking: TrackingMachine;
  readonly predictor = new PosePredictor();
  readonly light = new LightEstimator();
  private readonly deps: PoseRuntimeDeps;
  private readonly smoother: { smooth(f: PoseFrame | null): PoseFrame | null; reset(): void };
  private readonly retargetOverride: PoseToSkeleton | undefined;
  private retargeter: { update(f: PoseFrame): SkeletonPose | null; reset(): void } | null = null;
  private retargeterKey: { rest: RestSkeleton; fov: number; aspect: number } | null = null;
  private readonly now: () => number;
  private unsubscribe: (() => void) | null = null;
  private unsubState: (() => void) | null = null;
  private lastLightT = -Infinity;
  private lastFrame: PoseFrame | null = null;
  private poseMsEma = 0;
  private detections = 0;
  private teleports = 0;
  private lastStateForTeleport: TrackingState = 'initializing';
  private restRef: RestSkeleton | null = null;
  private readonly out: RuntimeSample;
  private readonly changeListeners = new Set<(s: TrackingState) => void>();
  private disposed = false;

  constructor(deps: PoseRuntimeDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => performance.now());
    this.retargetOverride = deps.retarget;
    this.smoother = deps.createSmoother?.() ?? new PoseSmoother();
    this.tracking = new TrackingMachine(deps.trackingConfig);
    this.out = {
      pose: null,
      visibility: 0,
      state: 'initializing',
      light: NEUTRAL_LIGHT,
      frame: null,
      teleportCount: 0,
    };
    this.tracking.onChange((s) => {
      if (s === 'tracking' && this.lastStateForTeleport !== 'tracking') {
        // al (re)adquirir la persona la pose salta: la tela debe reiniciarse y el predictor no deslizar
        this.predictor.snap();
        this.teleports++;
      }
      this.lastStateForTeleport = s;
      for (const l of [...this.changeListeners]) l(s);
    });
    this.unsubscribe = deps.feed.subscribe((e) => this.onFeed(e));
    this.unsubState = deps.feed.onState((s) => {
      if (s === 'running') this.tracking.markReady(this.now());
    });
    if (deps.feed.state === 'running') this.tracking.markReady(this.now());
  }

  /** Cambios de estado de seguimiento (para `onTrackingChange`). */
  onTrackingChange(cb: (s: TrackingState) => void): () => void {
    this.changeListeners.add(cb);
    return () => {
      this.changeListeners.delete(cb);
    };
  }

  get stats(): PoseRuntimeStats {
    return {
      poseMs: this.poseMsEma,
      detectIntervalMs: this.deps.feed.detectionIntervalMs,
      detections: this.detections,
    };
  }

  /** Cuerpo nuevo (otra talla/medidas): la próxima pose no debe deslizar desde la antigua. */
  notifyBodyChanged(): void {
    this.predictor.snap();
    this.teleports++;
  }

  private onFeed(e: FeedEvent): void {
    if (this.disposed) return;
    const now = e.timestampMs;
    if (this.tracking.state === 'initializing') this.tracking.markReady(now);
    this.detections++;
    const frame = e.frame;
    if (!frame || frame.personCount < 1) {
      this.tracking.observe(now, { present: false, confidence: 0 });
      this.recordCost(e.detectMs);
      return;
    }
    const t0 = this.now();
    const smoothed = this.smoother.smooth(frame);
    const rest = this.deps.getRest();
    if (rest !== this.restRef) {
      this.restRef = rest;
      this.notifyBodyChanged();
    }
    if (!smoothed || !rest) {
      // hay persona pero aún no podemos retargetear (cuerpo sin construir): cuenta como presente
      this.tracking.observe(now, {
        present: !!smoothed,
        confidence: meanVisibility(smoothed),
        personCount: frame.personCount,
      });
      this.lastFrame = smoothed;
      this.recordCost(e.detectMs);
      return;
    }
    let skel: SkeletonPose | null = null;
    try {
      skel = this.retargetFrame(smoothed, rest);
    } catch (err) {
      console.warn('[mirror] retargeting fallido', err);
    }
    const retargetMs = this.now() - t0;
    this.lastFrame = smoothed;
    if (!skel) {
      this.tracking.observe(now, { present: false, confidence: 0, personCount: frame.personCount });
    } else {
      this.predictor.push(skel, now, e.detectMs + retargetMs);
      this.tracking.observe(now, {
        present: true,
        confidence: skel.confidence,
        personCount: frame.personCount,
      });
    }
    this.recordCost(e.detectMs + retargetMs);
    this.maybeSampleLight(now);
  }

  /** Retargeting con estado (última rotación buena): se recrea sólo si cambian cuerpo o intrínsecos. */
  private retargetFrame(frame: PoseFrame, rest: RestSkeleton): SkeletonPose | null {
    const cam = this.deps.getIntrinsics();
    if (this.retargetOverride) return this.retargetOverride(frame, rest, cam);
    const k = this.retargeterKey;
    if (
      !this.retargeter ||
      !k ||
      k.rest !== rest ||
      Math.abs(k.fov - cam.verticalFovDeg) > 1e-6 ||
      Math.abs(k.aspect - cam.aspect) > 1e-3
    ) {
      this.retargeter = createPoseRetargeter(rest, cam);
      this.retargeterKey = { rest, fov: cam.verticalFovDeg, aspect: cam.aspect };
    }
    return this.retargeter.update(frame);
  }

  private recordCost(ms: number): void {
    this.poseMsEma = this.detections <= 1 ? ms : this.poseMsEma * 0.9 + ms * 0.1;
  }

  private maybeSampleLight(now: number): void {
    const src = this.deps.getLightSource?.();
    if (!src) return;
    if (now - this.lastLightT < (this.deps.lightEveryMs ?? 250)) return;
    this.lastLightT = now;
    this.light.sampleSource(src, now);
  }

  /** Una vez por fotograma de render. Devuelve un objeto reutilizado. */
  sample(nowMs: number): RuntimeSample {
    const o = this.out;
    o.state = this.tracking.tick(nowMs);
    o.visibility = this.tracking.visibility;
    o.pose = this.predictor.sample(nowMs);
    o.light = this.light.estimate;
    o.frame = this.lastFrame;
    o.teleportCount = this.teleports;
    return o;
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubState?.();
    this.unsubscribe = null;
    this.unsubState = null;
    this.changeListeners.clear();
  }
}

function meanVisibility(f: PoseFrame | null): number {
  if (!f || f.world.length === 0) return 0;
  let s = 0;
  for (const l of f.world) s += Number.isFinite(l.visibility) ? l.visibility : 0;
  return s / f.world.length;
}
