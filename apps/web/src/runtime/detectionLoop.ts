/** Lo mínimo que necesitamos de un <video> para planificar por fotograma de vídeo. */
export interface VideoFrameSource {
  requestVideoFrameCallback?(
    cb: (now: number, metadata: { mediaTime?: number }) => void,
  ): number;
  cancelVideoFrameCallback?(handle: number): void;
  readonly currentTime?: number;
}

/** Reloj y planificador inyectables (producción: `performance` + rAF; tests: dobles deterministas). */
export interface LoopHost {
  raf(cb: (t: number) => void): number;
  caf(handle: number): void;
  now(): number;
  isHidden(): boolean;
}

export function browserLoopHost(): LoopHost {
  return {
    raf: (cb) => requestAnimationFrame(cb),
    caf: (h) => cancelAnimationFrame(h),
    now: () => performance.now(),
    isHidden: () => typeof document !== 'undefined' && document.hidden,
  };
}

/**
 * Host por temporizador (≈60 Hz) para fuentes que no dependen de la pantalla (el vídeo sintético):
 * la detección sigue su cadencia aunque el render (p. ej. SwiftShader en pruebas) vaya a 1–2 fps.
 */
export function timerLoopHost(): LoopHost {
  return {
    raf: (cb) => window.setTimeout(() => cb(performance.now()), 1000 / 60),
    caf: (h) => window.clearTimeout(h),
    now: () => performance.now(),
    isHidden: () => false,
  };
}

export interface DetectionLoopOptions {
  /** Fuente de fotogramas: <video> (usa requestVideoFrameCallback si existe) o null (sólo rAF, p. ej. canvas). */
  readonly source: () => VideoFrameSource | null;
  /** Se invoca como máximo a `1000/minIntervalMs` Hz. Recibe el instante (ms, `host.now()`). */
  readonly onTick: (nowMs: number) => void;
  /** Intervalo mínimo entre detecciones (ms). Por defecto 1000/30. */
  readonly minIntervalMs?: number;
  /** Si true, ensancha el intervalo cuando la detección es cara (≥ ~1.7× su coste). */
  readonly adaptive?: boolean;
  /** Tope del intervalo adaptativo (ms). */
  readonly maxIntervalMs?: number;
  readonly host?: LoopHost;
  readonly onError?: (err: unknown) => void;
}

/**
 * Bucle de detección a ≤30 Hz, independiente del render a 60 Hz.
 * Usa `requestVideoFrameCallback` (un callback por fotograma NUEVO del vídeo) con fallback a rAF
 * (deduplicando por `currentTime`). Tolerante a jitter: acepta fotogramas a ≥85 % del intervalo
 * objetivo, para que una cámara de 30 fps no acabe a 15 Hz por redondeos.
 */
export class DetectionLoop {
  private readonly opts: DetectionLoopOptions;
  private readonly host: LoopHost;
  private running = false;
  private lastRun = -Infinity;
  private lastMediaTime = -1;
  private handle: { kind: 'vfc'; id: number; src: VideoFrameSource } | { kind: 'raf'; id: number } | null =
    null;
  private costEma = 0;
  private _interval: number;
  private errorReported = false;
  /** nº de ejecuciones de `onTick` (diagnóstico). */
  ticks = 0;

  constructor(opts: DetectionLoopOptions) {
    this.opts = opts;
    this.host = opts.host ?? browserLoopHost();
    this._interval = opts.minIntervalMs ?? 1000 / 30;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Intervalo actual (ms) tras la adaptación. */
  get intervalMs(): number {
    return this._interval;
  }

  /** Coste medio (ms) de `onTick`. */
  get costMs(): number {
    return this.costEma;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastRun = -Infinity;
    this.lastMediaTime = -1;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    const h = this.handle;
    this.handle = null;
    if (!h) return;
    if (h.kind === 'vfc') h.src.cancelVideoFrameCallback?.(h.id);
    else this.host.caf(h.id);
  }

  private schedule(): void {
    if (!this.running) return;
    const src = this.opts.source();
    if (src && typeof src.requestVideoFrameCallback === 'function') {
      const id = src.requestVideoFrameCallback((now, meta) => this.step(now, meta?.mediaTime));
      this.handle = { kind: 'vfc', id, src };
    } else {
      const id = this.host.raf((t) => this.step(t, src?.currentTime));
      this.handle = { kind: 'raf', id };
    }
  }

  private step(frameNow: number, mediaTime: number | undefined): void {
    if (!this.running) return;
    this.handle = null;
    const host = this.host;
    const minInterval = this.opts.minIntervalMs ?? 1000 / 30;
    const sinceLast = frameNow - this.lastRun;
    const fresh = mediaTime === undefined || mediaTime !== this.lastMediaTime;
    if (fresh && !host.isHidden() && sinceLast >= this._interval * 0.85) {
      this.lastRun = frameNow;
      if (mediaTime !== undefined) this.lastMediaTime = mediaTime;
      const t0 = host.now();
      try {
        this.opts.onTick(t0);
      } catch (err) {
        this.reportError(err);
      }
      const cost = host.now() - t0;
      this.ticks++;
      this.costEma = this.ticks === 1 ? cost : this.costEma * 0.8 + cost * 0.2;
      if (this.opts.adaptive !== false) {
        const max = this.opts.maxIntervalMs ?? 100;
        this._interval = Math.min(max, Math.max(minInterval, this.costEma * 1.7));
      } else {
        this._interval = minInterval;
      }
    }
    this.schedule();
  }

  private reportError(err: unknown): void {
    if (this.opts.onError) this.opts.onError(err);
    else if (!this.errorReported) {
      this.errorReported = true;
      console.error('[mirror] error en el bucle de detección', err);
    }
  }
}
