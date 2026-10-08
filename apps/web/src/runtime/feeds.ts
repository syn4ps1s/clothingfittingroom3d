import {
  createMediaPipePoseProvider,
  createSyntheticPoseProvider,
  type SyntheticPoseName,
} from '@fitroom/pose';
import type { Measurements, PoseFrame, PoseProvider } from '@fitroom/shared';
import { timerLoopHost, type LoopHost } from './detectionLoop';
import { PoseFeed } from './poseFeed';
import { SyntheticVideo, type SyntheticVideoOptions } from './syntheticVideo';

// ------------------------------------------------------------------ cámara real (MediaPipe)

const BASE = (): string => {
  const b = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return b.endsWith('/') ? b : `${b}/`;
};

/** Modelos por orden de preferencia: lite (rápido) y, si falla su carga, full. Todo del mismo origen. */
export const CAMERA_MODELS = ['pose_landmarker_lite.task', 'pose_landmarker_full.task'] as const;

export async function createCameraProvider(
  create: typeof createMediaPipePoseProvider = createMediaPipePoseProvider,
  models: readonly string[] = CAMERA_MODELS,
): Promise<PoseProvider> {
  let lastErr: unknown = null;
  for (const model of models) {
    let provider: PoseProvider | null = null;
    try {
      provider = create({
        modelUrl: `${BASE()}models/${model}`,
        wasmBaseUrl: `${BASE()}wasm`,
        runningMode: 'VIDEO',
        outputSegmentationMask: false,
      });
      await provider.init();
      return provider;
    } catch (err) {
      lastErr = err;
      provider?.dispose();
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('No se pudo cargar ningún modelo de pose');
}

export interface CameraFeedHandle {
  readonly feed: PoseFeed;
  /** El <video> de la cámara (null mientras no esté lista). Cualquiera de los consumidores puede fijarlo. */
  setVideo(video: HTMLVideoElement | null): void;
  release(): void;
}

interface SharedCamera {
  feed: PoseFeed;
  video: HTMLVideoElement | null;
  refs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

let shared: SharedCamera | null = null;
const RELEASE_DELAY_MS = 1500;

/**
 * Feed compartido de la cámara: un solo proveedor MediaPipe y un solo bucle de detección aunque haya
 * varios consumidores (espejo + escaneo). Se libera un instante después del último `release()` para
 * sobrevivir a remontajes (StrictMode, cambios de pantalla) sin recargar el modelo.
 */
export function acquireCameraFeed(
  factory: () => Promise<PoseProvider> = () => createCameraProvider(),
): CameraFeedHandle {
  if (!shared) {
    const s: SharedCamera = {
      feed: null as unknown as PoseFeed,
      video: null,
      refs: 0,
      timer: null,
    };
    s.feed = new PoseFeed({
      createProvider: factory,
      getSource: () => s.video,
      getFrameSource: () => s.video,
      onError: (e) => console.warn('[mirror] detección de pose:', e),
    });
    shared = s;
    void s.feed.start();
  }
  const s = shared;
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  s.refs++;
  let released = false;
  return {
    feed: s.feed,
    setVideo: (v) => {
      s.video = v;
    },
    release: () => {
      if (released) return;
      released = true;
      s.refs--;
      if (s.refs <= 0) {
        s.timer = setTimeout(() => {
          if (shared === s && s.refs <= 0) {
            s.feed.stop();
            shared = null;
          }
        }, RELEASE_DELAY_MS);
      }
    },
  };
}

/** Sólo para tests: descarta el feed compartido. */
export function resetCameraFeedForTests(): void {
  if (shared) {
    if (shared.timer) clearTimeout(shared.timer);
    shared.feed.stop();
    shared = null;
  }
}

// ------------------------------------------------------------------ feed sintético (e2e / demo sin cámara)

export type ScriptStep = { readonly pose: SyntheticPoseName | 'wave' | 'lean' | 'squat' | 'reach' | 'twist'; readonly durationMs: number };

/** Guion de demostración: A-pose → brazos arriba → giro → sentado → saludo, en bucle. */
export const TOUR_SCRIPT: readonly ScriptStep[] = [
  { pose: 'a-pose', durationMs: 3000 },
  { pose: 'arms-up', durationMs: 3000 },
  { pose: 'turn', durationMs: 5000 },
  { pose: 'sit', durationMs: 4000 },
  { pose: 'wave', durationMs: 3000 },
];

export interface SyntheticFeedOptions {
  readonly measurements?: Measurements;
  readonly heightCm: number;
  readonly fovDeg: number;
  readonly script?: readonly ScriptStep[];
  readonly seed?: number;
  readonly noiseSigmaM?: number;
  readonly mask?: boolean;
  readonly video?: SyntheticVideoOptions;
  readonly host?: LoopHost;
}

export interface SyntheticFeed {
  readonly feed: PoseFeed;
  readonly video: SyntheticVideo;
  /** Fija el instante del guion (ms) en vez de seguir el reloj; `null` vuelve al reloj. */
  seek(scriptMs: number | null): void;
  /** Instante actual del guion (ms). */
  scriptTime(): number;
  /** Verdad de terreno del esqueleto en el instante dado del guion. */
  groundTruth(scriptMs: number): import('@fitroom/shared').SkeletonPose;
  readonly rest: import('@fitroom/shared').RestSkeleton;
  readonly durationMs: number;
  dispose(): void;
}

const SYNTH_W = 1280;
const SYNTH_H = 720;

export function createSyntheticFeed(opts: SyntheticFeedOptions): SyntheticFeed {
  const host = opts.host ?? timerLoopHost();
  const video = new SyntheticVideo({ width: SYNTH_W, height: SYNTH_H, ...opts.video });
  const inner = createSyntheticPoseProvider({
    heightCm: opts.heightCm,
    ...(opts.measurements ? { measurements: opts.measurements } : {}),
    script: opts.script ?? TOUR_SCRIPT,
    seed: opts.seed ?? 7,
    noiseSigmaM: opts.noiseSigmaM ?? 0.004,
    camera: { verticalFovDeg: opts.fovDeg, aspect: SYNTH_W / SYNTH_H },
    imageSize: { width: SYNTH_W, height: SYNTH_H },
    endBehavior: 'loop',
    landmarkBias: 'mediapipe-like',
    ...(opts.mask ? { mask: true } : {}),
  });

  let t0: number | null = null;
  let seekMs: number | null = null;
  let lastScript = 0;
  const provider: PoseProvider = {
    name: 'synthetic',
    init: () => Promise.resolve(),
    detect(_source, ts) {
      t0 ??= ts;
      lastScript = seekMs ?? ts - t0;
      const f = inner.frameAt(lastScript);
      return f ? ({ ...f, timestampMs: ts } satisfies PoseFrame) : null;
    },
    dispose: () => inner.dispose(),
  };

  const feed = new PoseFeed({
    createProvider: () => Promise.resolve(provider),
    getSource: () => video.canvas,
    getFrameSource: () => null,
    afterDetect: (frame) => video.draw(frame),
    host,
  });

  return {
    feed,
    video,
    seek: (ms) => {
      seekMs = ms;
    },
    scriptTime: () => lastScript,
    groundTruth: (ms) => inner.groundTruth(ms),
    rest: inner.rest,
    durationMs: inner.durationMs,
    dispose: () => feed.stop(),
  };
}

// ------------------------------------------------------------------ feed sintético compartido

export type SyntheticKind = 'tour' | 'scan';

/** Guion del escaneo: A-pose sostenida (el sintético añade un leve ruido de detección). */
export const SCAN_SCRIPT: readonly ScriptStep[] = [{ pose: 'a-pose', durationMs: 120_000 }];

interface SharedSynthetic {
  readonly key: string;
  readonly synth: SyntheticFeed;
  refs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const syntheticShared = new Map<string, SharedSynthetic>();

export interface SyntheticHandle {
  readonly synth: SyntheticFeed;
  release(): void;
}

/**
 * Feed sintético compartido por clave (tipo de guion + cuerpo + FOV): el espejo en modo escaneo y
 * `useBodyScan('synthetic')` ven EXACTAMENTE la misma persona. Arranca al adquirirlo.
 */
export function acquireSyntheticFeed(
  kind: SyntheticKind,
  opts: Omit<SyntheticFeedOptions, 'script'> & { readonly script?: readonly ScriptStep[] },
  keyExtra = '',
): SyntheticHandle {
  const key = `${kind}|${opts.heightCm}|${opts.fovDeg}|${opts.measurements ? JSON.stringify(opts.measurements) : ''}|${keyExtra}`;
  let entry = syntheticShared.get(key);
  if (!entry) {
    const script = opts.script ?? (kind === 'scan' ? SCAN_SCRIPT : TOUR_SCRIPT);
    const synth = createSyntheticFeed({ ...opts, script });
    entry = { key, synth, refs: 0, timer: null };
    syntheticShared.set(key, entry);
    void synth.feed.start();
  }
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  entry.refs++;
  const e = entry;
  let released = false;
  return {
    synth: e.synth,
    release: () => {
      if (released) return;
      released = true;
      e.refs--;
      if (e.refs <= 0) {
        e.timer = setTimeout(() => {
          if (syntheticShared.get(key) === e && e.refs <= 0) {
            e.synth.dispose();
            syntheticShared.delete(key);
          }
        }, RELEASE_DELAY_MS);
      }
    },
  };
}

/** Sólo para tests/arnés. */
export function resetSyntheticFeedsForTests(): void {
  for (const e of syntheticShared.values()) {
    if (e.timer) clearTimeout(e.timer);
    e.synth.dispose();
  }
  syntheticShared.clear();
}
