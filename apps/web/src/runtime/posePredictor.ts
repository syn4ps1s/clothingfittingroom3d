import { JOINT_COUNT, type SkeletonPose } from '@fitroom/shared';
import { angleBetweenAt, setQuatNormalized, slerpInto } from './quatMath';

export interface PredictorConfig {
  /** Horizonte máximo de extrapolación (ms). Más allá, la pose se "congela" suavemente. */
  readonly extrapolationMs: number;
  /** 0..1 — fracción de la velocidad estimada que se aplica (amortigua el ruido de la velocidad). */
  readonly velocityGain: number;
  /** Constante de tiempo (ms) del seguidor que absorbe los saltos entre predicción y detección. */
  readonly followTauMs: number;
  /** Velocidad máxima plausible de la raíz (m/s) para acotar extrapolaciones espurias. */
  readonly maxRootSpeed: number;
  /** Salto de raíz (m) a partir del cual se "teletransporta" en vez de deslizar. */
  readonly snapDistanceM: number;
  /** Hueco temporal (ms) entre detecciones que se considera nueva adquisición (sin velocidad). */
  readonly reacquireGapMs: number;
  /** Giro máximo (rad) de extrapolación por articulación. */
  readonly maxExtrapolatedAngle: number;
}

export const DEFAULT_PREDICTOR_CONFIG: PredictorConfig = {
  extrapolationMs: 90,
  velocityGain: 0.95,
  followTauMs: 22,
  maxRootSpeed: 4,
  snapDistanceM: 0.6,
  reacquireGapMs: 600,
  maxExtrapolatedAngle: 0.5,
};

type Q4 = [number, number, number, number];

interface MutablePose {
  timestampMs: number;
  rootPosition: [number, number, number];
  rotations: Q4[];
  confidence: number;
  jointConfidence: number[];
}

/**
 * Predicción/interpolación de pose entre detecciones (~30 Hz) para renderizar a 60 Hz sin judder.
 *
 *  - `push(pose, t)` registra cada detección (ya suavizada y retargeteada).
 *  - `sample(now)` devuelve la pose a mostrar AHORA: extrapola linealmente (velocidad angular por slerp
 *    con t>1 y velocidad lineal de la raíz) hasta un horizonte corto, compensando la latencia de
 *    detección, y la pasa por un seguidor exponencial que absorbe los errores de predicción al llegar
 *    una detección nueva (así no hay saltos visibles).
 *
 * El objeto devuelto por `sample` es el MISMO en cada llamada (se muta en sitio): no hay asignaciones
 * por fotograma. Quien lo consuma no debe conservarlo entre fotogramas.
 */
export class PosePredictor {
  private readonly n: number;
  private readonly cfg: PredictorConfig;
  private readonly q0: Float64Array;
  private readonly q1: Float64Array;
  private readonly qf: Float64Array;
  private readonly qt: Float64Array;
  private readonly r0 = new Float64Array(3);
  private readonly r1 = new Float64Array(3);
  private readonly rf = new Float64Array(3);
  private t0 = 0;
  private t1 = 0;
  private hasPrev = false;
  private hasPose = false;
  private lastSampleT = -1;
  private snapPending = true;
  private readonly out: MutablePose;

  constructor(jointCount: number = JOINT_COUNT, config: Partial<PredictorConfig> = {}) {
    this.n = jointCount;
    this.cfg = { ...DEFAULT_PREDICTOR_CONFIG, ...config };
    this.q0 = new Float64Array(4 * jointCount);
    this.q1 = new Float64Array(4 * jointCount);
    this.qf = new Float64Array(4 * jointCount);
    this.qt = new Float64Array(4 * jointCount);
    this.out = {
      timestampMs: 0,
      rootPosition: [0, 0, 0],
      rotations: Array.from({ length: jointCount }, (): Q4 => [0, 0, 0, 1]),
      confidence: 0,
      jointConfidence: new Array<number>(jointCount).fill(0),
    };
  }

  get ready(): boolean {
    return this.hasPose;
  }

  /** Olvida el historial (p. ej. al perder el seguimiento o cambiar de cuerpo). */
  reset(): void {
    this.hasPrev = false;
    this.hasPose = false;
    this.snapPending = true;
    this.lastSampleT = -1;
  }

  /** Fuerza que la próxima muestra salte a la pose actual sin deslizar (re-adquisición). */
  snap(): void {
    this.snapPending = true;
  }

  /**
   * @param tMs instante de llegada de la detección (reloj del host)
   * @param latencyMs retardo entre el fotograma analizado y `tMs` (coste de detección + retargeting):
   *   la pose describe el mundo en `tMs − latencyMs`, y `sample` extrapola desde ahí hasta el fotograma de
   *   vídeo que se está mostrando (que es más nuevo que el analizado).
   */
  push(pose: SkeletonPose, tMs: number, latencyMs = 0): void {
    tMs -= Number.isFinite(latencyMs) ? Math.max(0, Math.min(150, latencyMs)) : 0;
    const n = this.n;
    const root = pose.rootPosition;
    if (
      !Number.isFinite(tMs) ||
      !Number.isFinite(root[0]) ||
      !Number.isFinite(root[1]) ||
      !Number.isFinite(root[2])
    ) {
      return; // detección corrupta: se ignora (nunca contamina el estado)
    }
    const gap = tMs - this.t1;
    if (this.hasPose && gap <= 0) return; // detección fuera de orden: se descarta
    const reacquire = !this.hasPose || gap > this.cfg.reacquireGapMs;

    if (reacquire) {
      this.hasPrev = false;
      for (let i = 0; i < n; i++) setQuatNormalized(this.q1, i * 4, pose.rotations[i] ?? IDENT, 0);
      this.r1[0] = root[0];
      this.r1[1] = root[1];
      this.r1[2] = root[2];
      this.q0.set(this.q1);
      this.r0.set(this.r1);
      this.t0 = tMs;
      this.t1 = tMs;
      if (this.hasPose && gap > this.cfg.reacquireGapMs) this.snapPending = true;
      if (!this.hasPose) this.snapPending = true;
    } else {
      this.q0.set(this.q1);
      this.r0.set(this.r1);
      this.t0 = this.t1;
      this.t1 = tMs;
      this.hasPrev = true;
      for (let i = 0; i < n; i++) setQuatNormalized(this.q1, i * 4, pose.rotations[i] ?? IDENT, 0);
      this.r1[0] = root[0];
      this.r1[1] = root[1];
      this.r1[2] = root[2];
      // salto de raíz grande → no deslizar
      const dx = this.r1[0]! - this.rf[0]!;
      const dy = this.r1[1]! - this.rf[1]!;
      const dz = this.r1[2]! - this.rf[2]!;
      if (Math.hypot(dx, dy, dz) > this.cfg.snapDistanceM) this.snapPending = true;
    }
    this.hasPose = true;
    this.out.confidence = pose.confidence;
    for (let i = 0; i < n; i++) this.out.jointConfidence[i] = pose.jointConfidence[i] ?? 0;
  }

  /** Pose a mostrar en `nowMs` (objeto reutilizado). `null` si nunca hubo detección. */
  sample(nowMs: number): SkeletonPose | null {
    if (!this.hasPose) return null;
    const cfg = this.cfg;
    const n = this.n;

    // --- objetivo extrapolado ---
    const ahead = Math.max(0, nowMs - this.t1);
    // horizonte lineal hasta `extrapolationMs` (extrapolación exacta para movimiento uniforme, sin tirones
    // al llegar cada detección) y, más allá, saturación suave hacia 1,5× (la pose se detiene sin tirón)
    const eff = softHorizon(ahead, cfg.extrapolationMs);
    let k = 0;
    let vx = 0,
      vy = 0,
      vz = 0;
    if (this.hasPrev) {
      const dtDet = Math.min(200, Math.max(8, this.t1 - this.t0));
      k = (eff / dtDet) * cfg.velocityGain;
      let sx = (this.r1[0]! - this.r0[0]!) / dtDet;
      let sy = (this.r1[1]! - this.r0[1]!) / dtDet;
      let sz = (this.r1[2]! - this.r0[2]!) / dtDet; // m/ms
      const speed = Math.hypot(sx, sy, sz) * 1000;
      if (speed > cfg.maxRootSpeed) {
        const s = cfg.maxRootSpeed / speed;
        sx *= s;
        sy *= s;
        sz *= s;
      }
      vx = sx * eff * cfg.velocityGain;
      vy = sy * eff * cfg.velocityGain;
      vz = sz * eff * cfg.velocityGain;
    }

    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (k > 0) {
        // giro 0→1 entre q0 y q1; extrapolar s = 1 + k, acotando el ángulo total de extrapolación
        const step = angleBetweenAt(this.q0, o, this.q1, o);
        let kk = k;
        if (step > 1e-6) {
          const maxK = cfg.maxExtrapolatedAngle / step;
          if (kk > maxK) kk = maxK;
        }
        slerpInto(this.qt, o, this.q0, o, this.q1, o, 1 + kk);
      } else {
        this.qt[o] = this.q1[o]!;
        this.qt[o + 1] = this.q1[o + 1]!;
        this.qt[o + 2] = this.q1[o + 2]!;
        this.qt[o + 3] = this.q1[o + 3]!;
      }
    }
    const tx = this.r1[0]! + vx;
    const ty = this.r1[1]! + vy;
    const tz = this.r1[2]! + vz;

    // --- seguidor exponencial hacia el objetivo ---
    let alpha = 1;
    if (!this.snapPending && this.lastSampleT >= 0) {
      const dt = Math.min(100, Math.max(0, nowMs - this.lastSampleT));
      alpha = 1 - Math.exp(-dt / cfg.followTauMs);
    }
    this.snapPending = false;
    this.lastSampleT = nowMs;

    if (alpha >= 1) {
      this.qf.set(this.qt);
      this.rf[0] = tx;
      this.rf[1] = ty;
      this.rf[2] = tz;
    } else {
      for (let i = 0; i < n; i++) slerpInto(this.qf, i * 4, this.qf, i * 4, this.qt, i * 4, alpha);
      this.rf[0] = this.rf[0]! + (tx - this.rf[0]!) * alpha;
      this.rf[1] = this.rf[1]! + (ty - this.rf[1]!) * alpha;
      this.rf[2] = this.rf[2]! + (tz - this.rf[2]!) * alpha;
    }

    // --- salida (objeto reutilizado) ---
    const out = this.out;
    out.timestampMs = nowMs;
    out.rootPosition[0] = this.rf[0]!;
    out.rootPosition[1] = this.rf[1]!;
    out.rootPosition[2] = this.rf[2]!;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const r = out.rotations[i]!;
      r[0] = this.qf[o]!;
      r[1] = this.qf[o + 1]!;
      r[2] = this.qf[o + 2]!;
      r[3] = this.qf[o + 3]!;
    }
    return out;
  }
}

const IDENT: readonly [number, number, number, number] = [0, 0, 0, 1];

/** x si x ≤ h; después sube suavemente y se aplana en 1,5·h (derivada continua en h). */
function softHorizon(x: number, h: number): number {
  if (x <= h) return x;
  const room = 0.5 * h;
  return h + room * Math.tanh((x - h) / room);
}
