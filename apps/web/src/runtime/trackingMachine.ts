import type { TrackingState } from '../contracts';

export interface TrackingConfig {
  /** Detecciones válidas consecutivas para pasar searching → tracking. */
  readonly enterFrames: number;
  /** Detecciones válidas consecutivas para recuperar el seguimiento tras `lost` (histéresis más corta). */
  readonly reacquireFrames: number;
  /** Sin detección durante este tiempo (ms) → lost. */
  readonly lostAfterMs: number;
  /** Tiempo (ms) en lost tras el cual se vuelve a searching. */
  readonly giveUpAfterMs: number;
  /** Duración (ms) del desvanecimiento de las prendas al perder el seguimiento. */
  readonly fadeOutMs: number;
  /** Duración (ms) de la aparición al (re)adquirir. */
  readonly fadeInMs: number;
  /** Confianza mínima de una detección para considerarla válida. */
  readonly minConfidence: number;
}

export const DEFAULT_TRACKING_CONFIG: TrackingConfig = {
  enterFrames: 3,
  reacquireFrames: 2,
  lostAfterMs: 500,
  giveUpAfterMs: 5000,
  fadeOutMs: 400,
  fadeInMs: 250,
  minConfidence: 0.3,
};

export interface Observation {
  /** ¿Hay una persona utilizable en este fotograma? */
  readonly present: boolean;
  /** 0..1 */
  readonly confidence: number;
  readonly personCount?: number;
}

/**
 * Máquina de estados del seguimiento con histéresis.
 *
 *   initializing ──markReady──▶ searching ──(N detecciones)──▶ tracking
 *        tracking ──(>lostAfterMs sin detección)──▶ lost ──(M detecciones)──▶ tracking
 *        lost ──(>giveUpAfterMs)──▶ searching
 *
 * `visibility` (0..1) es la opacidad global de las prendas: baja con suavidad cuando se pierde el
 * seguimiento y sube con suavidad al recuperarlo, SIN saltos aunque la recuperación llegue a medio
 * desvanecimiento. Es puro: el tiempo lo aporta quien llama (`nowMs`), nada de relojes ocultos.
 */
export class TrackingMachine {
  private readonly cfg: TrackingConfig;
  private _state: TrackingState = 'initializing';
  private good = 0;
  private lastGoodMs = -Infinity;
  private lostSinceMs = 0;
  private level = 0; // 0..1 lineal; la salida es smoothstep(level)
  private lastTickMs: number | null = null;
  private _multiplePeople = false;
  private readonly listeners = new Set<(s: TrackingState, prev: TrackingState) => void>();

  constructor(config: Partial<TrackingConfig> = {}) {
    this.cfg = { ...DEFAULT_TRACKING_CONFIG, ...config };
  }

  get state(): TrackingState {
    return this._state;
  }

  get multiplePeople(): boolean {
    return this._multiplePeople;
  }

  /** Visibilidad suavizada 0..1 para modular la opacidad de las prendas. */
  get visibility(): number {
    const t = this.level;
    return t * t * (3 - 2 * t);
  }

  onChange(cb: (s: TrackingState, prev: TrackingState) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** El proveedor de pose terminó de cargar: initializing → searching. */
  markReady(nowMs: number): void {
    if (this._state === 'initializing') {
      this.lastTickMs = nowMs;
      this.set('searching');
    }
  }

  /** Vuelve al estado inicial (p. ej. al cambiar de fuente de pose). */
  reset(): void {
    this.good = 0;
    this.lastGoodMs = -Infinity;
    this.level = 0;
    this.lastTickMs = null;
    this._multiplePeople = false;
    this.set('initializing');
  }

  /** Registra el resultado de una detección. */
  observe(nowMs: number, obs: Observation): void {
    if (this._state === 'initializing') {
      this.advance(nowMs);
      return;
    }
    const valid =
      obs.present && Number.isFinite(obs.confidence) && obs.confidence >= this.cfg.minConfidence;
    // la racha se actualiza ANTES de avanzar el reloj: así el fundido se congela ya con la 1.ª detección
    if (valid) this.good++;
    else this.good = 0;
    this.advance(nowMs);
    this._multiplePeople = (obs.personCount ?? 1) > 1;
    if (valid) {
      this.lastGoodMs = nowMs;
      if (this._state === 'searching' && this.good >= this.cfg.enterFrames) this.set('tracking');
      else if (this._state === 'lost' && this.good >= this.cfg.reacquireFrames) this.set('tracking');
    }
    this.updateTarget(nowMs);
  }

  /** Avanza el reloj (llamar en cada fotograma de render). Devuelve el estado actual. */
  tick(nowMs: number): TrackingState {
    this.advance(nowMs);
    this.updateTarget(nowMs);
    return this._state;
  }

  private updateTarget(nowMs: number): void {
    const cfg = this.cfg;
    if (this._state === 'tracking' && nowMs - this.lastGoodMs > cfg.lostAfterMs) {
      this.lostSinceMs = nowMs;
      this.good = 0;
      this.set('lost');
    } else if (this._state === 'lost' && nowMs - this.lostSinceMs > cfg.giveUpAfterMs) {
      this.good = 0;
      this.set('searching');
    }
  }

  /** Integra la envolvente de visibilidad con velocidad constante hacia el objetivo. */
  private advance(nowMs: number): void {
    const last = this.lastTickMs;
    this.lastTickMs = nowMs;
    if (last === null) return;
    const dt = Math.max(0, Math.min(250, nowMs - last));
    if (dt === 0) return;
    // En `lost`, mientras se confirma una re-adquisición el fundido se congela (evita el parpadeo).
    const holding = this._state === 'lost' && this.good > 0;
    const goal = this._state === 'tracking' ? 1 : holding ? this.level : 0;
    if (goal > this.level) this.level = Math.min(goal, this.level + dt / this.cfg.fadeInMs);
    else this.level = Math.max(goal, this.level - dt / this.cfg.fadeOutMs);
  }

  private set(next: TrackingState): void {
    if (next === this._state) return;
    const prev = this._state;
    this._state = next;
    for (const l of [...this.listeners]) l(next, prev);
  }
}
