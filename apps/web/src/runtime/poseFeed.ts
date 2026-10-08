import type { PoseFrame, PoseProvider } from '@fitroom/shared';
import { DetectionLoop, browserLoopHost, type LoopHost, type VideoFrameSource } from './detectionLoop';

/** Una detección (o ausencia de ella) entregada a los consumidores. */
export interface FeedEvent {
  /** `null` si no hay persona. */
  readonly frame: PoseFrame | null;
  /** Instante (ms, reloj del host) en que terminó la detección. */
  readonly timestampMs: number;
  /** Coste de `provider.detect` (ms). */
  readonly detectMs: number;
}

export type FeedState = 'idle' | 'initializing' | 'running' | 'failed';

export interface PoseFeedDeps {
  /** Crea (e inicializa) el proveedor. Puede lanzar: el feed pasa a 'failed'. */
  readonly createProvider: () => Promise<PoseProvider>;
  /** Imagen sobre la que detectar en este instante (vídeo o canvas); `null` si aún no hay. */
  readonly getSource: () => object | null;
  /** Fuente de fotogramas para planificar con rVFC (el <video>), o null para usar rAF. */
  readonly getFrameSource?: () => VideoFrameSource | null;
  /** Gancho previo a cada detección (p. ej. dibujar el vídeo sintético). */
  readonly beforeDetect?: (nowMs: number) => void;
  /** Gancho posterior a cada detección con su resultado (p. ej. dibujar el cuerpo sintético). */
  readonly afterDetect?: (frame: PoseFrame | null, nowMs: number) => void;
  /** Convierte `host.now()` en el timestamp que recibe el proveedor (monótono). Por defecto, identidad. */
  readonly timestampOf?: (nowMs: number) => number;
  readonly minIntervalMs?: number;
  readonly host?: LoopHost;
  readonly onError?: (err: unknown) => void;
}

/**
 * Fuente única de detecciones de pose: gestiona el ciclo de vida del proveedor y el bucle (≤30 Hz) y
 * reparte cada resultado a N consumidores (espejo, escaneo...) para no detectar dos veces.
 */
export class PoseFeed {
  private _state: FeedState = 'idle';
  private _error: unknown = null;
  private provider: PoseProvider | null = null;
  private loop: DetectionLoop | null = null;
  private readonly listeners = new Set<(e: FeedEvent) => void>();
  private readonly stateListeners = new Set<(s: FeedState) => void>();
  private startToken = 0;
  private lastTs = -Infinity;
  private consecutiveErrors = 0;
  private lastEvent: FeedEvent | null = null;
  private readonly host: LoopHost;

  constructor(private readonly deps: PoseFeedDeps) {
    this.host = deps.host ?? browserLoopHost();
  }

  get state(): FeedState {
    return this._state;
  }
  get error(): unknown {
    return this._error;
  }
  get last(): FeedEvent | null {
    return this.lastEvent;
  }
  get detectionIntervalMs(): number {
    return this.loop?.intervalMs ?? 0;
  }
  get providerName(): string {
    return this.provider?.name ?? '';
  }

  subscribe(listener: (e: FeedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onState(listener: (s: FeedState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /** Inicializa el proveedor y arranca el bucle. Idempotente. Nunca rechaza (ver `state`/`error`). */
  async start(): Promise<void> {
    if (this._state === 'initializing' || this._state === 'running') return;
    const token = ++this.startToken;
    this.setState('initializing');
    let provider: PoseProvider;
    try {
      provider = await this.deps.createProvider();
    } catch (err) {
      if (token !== this.startToken) return;
      this._error = err;
      this.setState('failed');
      this.deps.onError?.(err);
      return;
    }
    if (token !== this.startToken) {
      provider.dispose(); // stop() ocurrió durante la inicialización
      return;
    }
    this.provider = provider;
    this.loop = new DetectionLoop({
      source: () => this.deps.getFrameSource?.() ?? null,
      onTick: (now) => this.tick(now),
      minIntervalMs: this.deps.minIntervalMs ?? 1000 / 30,
      host: this.host,
      onError: (e) => this.deps.onError?.(e),
    });
    this.setState('running');
    this.loop.start();
  }

  stop(): void {
    this.startToken++;
    this.loop?.stop();
    this.loop = null;
    if (this.provider) {
      this.provider.dispose();
      this.provider = null;
    }
    this.lastEvent = null;
    if (this._state !== 'idle') this.setState('idle');
  }

  private tick(nowMs: number): void {
    const provider = this.provider;
    if (!provider) return;
    const source = this.deps.getSource();
    if (!source) return; // aún no hay vídeo: nada que detectar
    this.deps.beforeDetect?.(nowMs);
    const rawTs = this.deps.timestampOf ? this.deps.timestampOf(nowMs) : nowMs;
    const ts = rawTs > this.lastTs ? rawTs : this.lastTs + 1;
    this.lastTs = ts;
    let frame: PoseFrame | null = null;
    const t0 = this.host.now();
    try {
      frame = provider.detect(source, ts);
      this.consecutiveErrors = 0;
    } catch (err) {
      // MediaPipe lanza si el vídeo aún no tiene fotograma; se trata como "sin persona" y se avisa una vez.
      if (this.consecutiveErrors === 0) this.deps.onError?.(err);
      this.consecutiveErrors++;
      frame = null;
    }
    const t1 = this.host.now();
    this.deps.afterDetect?.(frame, nowMs);
    const ev: FeedEvent = { frame, timestampMs: t1, detectMs: t1 - t0 };
    this.lastEvent = ev;
    for (const l of [...this.listeners]) l(ev);
  }

  private setState(s: FeedState): void {
    this._state = s;
    for (const l of [...this.stateListeners]) l(s);
  }
}
