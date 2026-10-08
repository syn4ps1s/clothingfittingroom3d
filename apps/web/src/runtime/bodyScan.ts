import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createScanSession } from '@fitroom/pose';
import type {
  CameraIntrinsics,
  MeasurementEstimate,
  ScanProgress,
  ScanSession,
} from '@fitroom/shared';
import type { BodyScanApi, CameraController, PoseSourceKind } from '../contracts';
import { acquireCameraFeed, acquireSyntheticFeed, type SyntheticHandle } from './feeds';
import { getVerticalFov, intrinsicsFor } from './intrinsics';
import { LightEstimator } from './lightEstimator';
import type { FeedEvent, PoseFeed } from './poseFeed';

export const IDLE_PROGRESS: ScanProgress = {
  phase: 'idle',
  hint: 'no-person',
  progress: 0,
  framesUsed: 0,
};

/** Un feed de detecciones y cómo soltarlo (cámara compartida o sintético compartido). */
export interface ScanFeedHandle {
  readonly feed: PoseFeed;
  /** Origen de imagen para medir la luz y los intrínsecos (vídeo/canvas). */
  readonly source: () => (CanvasImageSource & { videoWidth?: number; videoHeight?: number }) | null;
  setVideo?(v: HTMLVideoElement | null): void;
  release(): void;
}

export interface ScanControllerDeps {
  readonly createFeed: (heightCm: number) => ScanFeedHandle;
  readonly createSession?: (o: {
    heightCm: number;
    camera: CameraIntrinsics;
  }) => ScanSession;
  readonly fovDeg?: () => number;
  /** Se invoca con cada cambio relevante del progreso (ya limitado en frecuencia). */
  readonly onProgress: (p: ScanProgress) => void;
  readonly onEstimate: (e: MeasurementEstimate | null) => void;
  readonly lightEveryMs?: number;
  readonly progressEveryMs?: number;
}

/**
 * Controla un escaneo guiado: comparte el MISMO feed de detecciones que el espejo (jamás abre una 2.ª
 * cámara), alimenta `createScanSession` con cada detección y con la luminosidad media, y limpia todo al
 * completar, cancelar o desmontar.
 */
export class ScanController {
  private session: ScanSession | null = null;
  private handle: ScanFeedHandle | null = null;
  private unsubscribe: (() => void) | null = null;
  private lastEmit = -Infinity;
  private lastKey = '';
  private lastLightT = -Infinity;
  private readonly light = new LightEstimator({ smoothingMs: 400 });
  private video: HTMLVideoElement | null = null;
  private disposed = false;

  constructor(private readonly deps: ScanControllerDeps) {}

  get active(): boolean {
    return this.session !== null;
  }

  /** Sincroniza el <video> de la cámara (null si no está lista). */
  setVideo(v: HTMLVideoElement | null): void {
    this.video = v;
    this.handle?.setVideo?.(v);
  }

  start(heightCm: number): void {
    if (this.disposed) return;
    this.teardown();
    this.deps.onEstimate(null);
    if (!Number.isFinite(heightCm)) {
      this.emit({ phase: 'failed', hint: 'no-person', progress: 0, framesUsed: 0 }, true);
      return;
    }
    const handle = this.deps.createFeed(heightCm);
    this.handle = handle;
    handle.setVideo?.(this.video);
    const src = handle.source();
    const intrinsics = intrinsicsFor(src, this.deps.fovDeg?.() ?? getVerticalFov());
    try {
      this.session = (this.deps.createSession ?? createScanSession)({ heightCm, camera: intrinsics });
    } catch (err) {
      this.teardown();
      console.warn('[mirror] no se pudo iniciar la sesión de escaneo', err);
      this.emit({ phase: 'failed', hint: 'no-person', progress: 0, framesUsed: 0 }, true);
      return;
    }
    this.light.reset();
    this.emit({ phase: 'searching', hint: 'no-person', progress: 0, framesUsed: 0 }, true);
    this.unsubscribe = handle.feed.subscribe((e) => this.onFeed(e));
  }

  cancel(): void {
    const had = this.active;
    this.teardown();
    this.deps.onEstimate(null);
    if (had || this.lastKey !== '') this.emit(IDLE_PROGRESS, true);
  }

  dispose(): void {
    this.disposed = true;
    this.teardown();
  }

  private onFeed(e: FeedEvent): void {
    const session = this.session;
    const handle = this.handle;
    if (!session || !handle) return;
    // luminosidad media (cada ~300 ms; un drawImage a 32×18)
    const src = handle.source();
    if (src && e.timestampMs - this.lastLightT >= (this.deps.lightEveryMs ?? 300)) {
      this.lastLightT = e.timestampMs;
      this.light.sampleSource(src, e.timestampMs);
    }
    const luma = this.light.hasEstimate ? this.light.estimate.luma255 : undefined;
    let p: ScanProgress;
    try {
      p = session.push(e.frame, e.timestampMs, luma);
    } catch (err) {
      console.warn('[mirror] fallo en la sesión de escaneo', err);
      this.teardown();
      this.emit({ phase: 'failed', hint: 'no-person', progress: 0, framesUsed: 0 }, true);
      return;
    }
    const terminal = p.phase === 'complete' || p.phase === 'failed';
    this.emit(p, terminal);
    if (p.phase === 'complete') {
      const est = session.result();
      this.deps.onEstimate(est);
      this.teardown();
    } else if (p.phase === 'failed') {
      this.teardown();
    }
  }

  /** Emite sólo si cambió algo relevante y no más de ~10 Hz (salvo cambios de fase / forzado). */
  private emit(p: ScanProgress, force = false): void {
    const key = `${p.phase}|${p.hint}`;
    const t = performance.now();
    const phaseChanged = key !== this.lastKey;
    if (!force && !phaseChanged && t - this.lastEmit < (this.deps.progressEveryMs ?? 100)) return;
    this.lastKey = key;
    this.lastEmit = t;
    this.deps.onProgress(p);
  }

  private teardown(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.handle?.release();
    this.handle = null;
    this.session?.reset();
    this.session = null;
  }
}

// ------------------------------------------------------------------ hook

/**
 * Escaneo guiado de talla. Comparte el stream de la cámara (jamás un segundo `getUserMedia`) y el feed
 * de detecciones con el espejo. `start(heightCm)` puede llamarse antes de que la cámara esté lista: el
 * escaneo queda en «buscando» hasta que haya imagen.
 */
export function useBodyScan(camera: CameraController, source: PoseSourceKind): BodyScanApi {
  const [progress, setProgress] = useState<ScanProgress>(IDLE_PROGRESS);
  const [estimate, setEstimate] = useState<MeasurementEstimate | null>(null);
  const controllerRef = useRef<ScanController | null>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;

  useEffect(() => {
    const c = new ScanController({
      createFeed: (heightCm) => createFeedFor(sourceRef.current, heightCm),
      onProgress: setProgress,
      onEstimate: setEstimate,
    });
    controllerRef.current = c;
    return () => {
      c.dispose();
      if (controllerRef.current === c) controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.setVideo(camera.video);
  }, [camera.video]);

  const start = useCallback((heightCm: number) => controllerRef.current?.start(heightCm), []);
  const cancel = useCallback(() => controllerRef.current?.cancel(), []);

  return useMemo(() => ({ progress, estimate, start, cancel }), [progress, estimate, start, cancel]);
}

function createFeedFor(kind: PoseSourceKind, heightCm: number): ScanFeedHandle {
  if (kind === 'synthetic') {
    const h: SyntheticHandle = acquireSyntheticFeed('scan', {
      heightCm,
      fovDeg: getVerticalFov(),
    });
    return {
      feed: h.synth.feed,
      source: () => h.synth.video.canvas,
      release: () => h.release(),
    };
  }
  const h = acquireCameraFeed();
  let video: HTMLVideoElement | null = null;
  return {
    feed: h.feed,
    source: () => video,
    setVideo: (v) => {
      video = v;
      h.setVideo(v);
    },
    release: () => h.release(),
  };
}
