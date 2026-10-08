import {
  SCAN_HINTS,
  clamp,
  type CameraIntrinsics,
  type MeasurementEstimate,
  type BodyBase,
  type PoseFrame,
  type ScanHint,
  type ScanPhase,
  type ScanProgress,
  type ScanSession,
} from '@fitroom/shared';
import { estimateMeasurements, type MeasureDetails } from './measure.js';
import {
  DEFAULT_THRESHOLDS,
  assessFrame,
  motionBetween,
  type FrameQuality,
  type QualityThresholds,
} from './quality.js';

/**
 * Sesión guiada de escaneo de talla (máquina de estados de `ScanSession`).
 *
 *   idle ─► searching ─► adjusting ─► hold ─► capturing ─► complete
 *                 ▲           │  ▲       │        │
 *                 └───────────┴──┴───────┴────────┘   (se pierde a la persona / se mueve)       failed (tiempo agotado)
 *
 * Exige persona única, cuerpo completo con margen, de frente, a distancia razonable, quieta, con luz
 * suficiente y brazos separados del tronco. Acumula `targetFrames` fotogramas VÁLIDOS (≈ 45 ≈ 1.5 s a
 * 30 fps) y estima con mediana + rechazo MAD (ver `estimateMeasurements`). Las pistas son claves i18n.
 */

export interface ScanSessionOptions {
  readonly heightCm: number;
  readonly camera: CameraIntrinsics;
  /** Peso declarado (kg): mejora mucho las circunferencias. */
  readonly weightKg?: number;
  readonly bodyBase?: BodyBase;
  /** Fotogramas válidos a acumular. Por defecto 45. */
  readonly targetFrames?: number;
  /** Tiempo con pista `ok` antes de pasar a `hold` (ms). Por defecto 400. */
  readonly settleMs?: number;
  /** Cuenta atrás en `hold` antes de capturar (ms). Por defecto 500. */
  readonly holdMs?: number;
  /** Tolerancia a fotogramas no válidos antes de volver a `adjusting` (ms). Por defecto 700. */
  readonly graceMs?: number;
  /** Sin persona durante este tiempo ⇒ vuelve a `searching` (ms). Por defecto 1500. */
  readonly lostMs?: number;
  /** Tiempo máximo desde el primer fotograma hasta `complete` (ms); si no, `failed`. Por defecto 60000. */
  readonly timeoutMs?: number;
  /** Ventana de quietud (ms). Por defecto 400. */
  readonly stillWindowMs?: number;
  readonly thresholds?: Partial<QualityThresholds>;
}

export interface ScanDiagnostics {
  readonly details: MeasureDetails;
  /** fotogramas aceptados y descartados durante la captura */
  readonly accepted: number;
  readonly skipped: number;
  /** ms desde el primer fotograma hasta completar */
  readonly durationMs: number;
}

export interface ScanSessionExt extends ScanSession {
  /** Detalles del último escaneo completado (escala, IMC, longitud del torso…), o `null`. */
  diagnostics(): ScanDiagnostics | null;
  /** Opciones normalizadas con las que corre la sesión. */
  readonly options: Readonly<Required<Pick<ScanSessionOptions, 'heightCm' | 'targetFrames'>>>;
}

export function createScanSession(opts: ScanSessionOptions): ScanSessionExt {
  if (!Number.isFinite(opts.heightCm) || opts.heightCm < 100 || opts.heightCm > 260) {
    throw new RangeError('createScanSession: heightCm fuera de rango (100–260)');
  }
  const targetFrames = Math.max(5, Math.floor(opts.targetFrames ?? 45));
  const settleMs = opts.settleMs ?? 400;
  const holdMs = opts.holdMs ?? 500;
  const graceMs = opts.graceMs ?? 700;
  const lostMs = opts.lostMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const stillWindowMs = opts.stillWindowMs ?? 400;
  const th: QualityThresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };

  let phase: ScanPhase = 'idle';
  let hint: ScanHint = 'no-person';
  let frames: PoseFrame[] = [];
  let skipped = 0;
  let result: MeasurementEstimate | null = null;
  let diag: ScanDiagnostics | null = null;
  let startMs: number | null = null;
  let lastNow = -Infinity;
  let okSince: number | null = null; // desde cuándo la pista es `ok` de forma continua
  let badSince: number | null = null; // desde cuándo NO es `ok` de forma continua
  let lostSince: number | null = null;
  let history: { t: number; track: NonNullable<FrameQuality['track']> }[] = [];

  const progress = (): ScanProgress => {
    let p = 0;
    if (phase === 'hold') {
      const dt = okSince === null ? 0 : lastNow - okSince - settleMs;
      p = 0.1 * clamp(dt / holdMs, 0, 1);
    } else if (phase === 'capturing') p = 0.1 + 0.9 * (frames.length / targetFrames);
    else if (phase === 'complete') p = 1;
    return { phase, hint, progress: clamp(p, 0, 1), framesUsed: frames.length };
  };

  const restart = (to: ScanPhase): void => {
    phase = to;
    frames = [];
    okSince = null;
    history = [];
  };

  function finish(now: number): void {
    try {
      const { estimate, details } = estimateMeasurements(frames, opts.heightCm, {
        mode: 'video',
        ...(opts.weightKg !== undefined ? { weightKg: opts.weightKg } : {}),
        ...(opts.bodyBase !== undefined ? { bodyBase: opts.bodyBase } : {}),
      });
      result = estimate;
      diag = {
        details,
        accepted: frames.length,
        skipped,
        durationMs: startMs === null ? 0 : now - startMs,
      };
      phase = 'complete';
      hint = 'ok';
    } catch (e) {
      console.error('pose: la estimación de medidas falló', e);
      phase = 'failed';
    }
  }

  function push(frame: PoseFrame | null, nowMs: number, lumaMean?: number): ScanProgress {
    if (phase === 'complete' || phase === 'failed') return progress();
    if (!Number.isFinite(nowMs) || nowMs <= lastNow) return progress(); // repetido o hacia atrás
    lastNow = nowMs;
    if (startMs === null) {
      startMs = nowMs;
      phase = 'searching';
    }
    if (nowMs - startMs > timeoutMs) {
      phase = 'failed';
      return progress();
    }

    const q = assessFrame(frame, lumaMean, th);
    let h: ScanHint = q.hint;
    // quietud: ventana de los últimos `stillWindowMs`
    if (h === 'ok' && q.track) {
      history.push({ t: nowMs, track: q.track });
      while (history.length > 1 && nowMs - history[0]!.t > stillWindowMs) history.shift();
      const oldest = history[0]!;
      if (history.length >= 3 && nowMs - oldest.t >= stillWindowMs * 0.5) {
        if (motionBetween(oldest.track, q.track) > th.maxMotion) h = 'hold-still';
      }
    } else {
      history = [];
    }
    hint = h;

    // ---- persona perdida ------------------------------------------------------------------------
    if (q.hint === 'no-person') {
      lostSince ??= nowMs;
      okSince = null;
      badSince ??= nowMs;
      if (nowMs - lostSince > lostMs) {
        restart('searching');
        return progress();
      }
      if (phase === 'capturing' || phase === 'hold') {
        if (nowMs - badSince > graceMs) restart('adjusting');
      } else if (phase !== 'searching') {
        phase = 'searching';
      }
      return progress();
    }
    lostSince = null;
    if (phase === 'searching' || phase === 'idle') phase = 'adjusting';

    // ---- pista válida / no válida ---------------------------------------------------------------
    if (h === 'ok') {
      badSince = null;
      okSince ??= nowMs;
      if (phase === 'adjusting' && nowMs - okSince >= settleMs) phase = 'hold';
      if (phase === 'hold' && nowMs - okSince >= settleMs + holdMs) phase = 'capturing';
      if (phase === 'capturing') {
        frames.push(frame!);
        if (frames.length >= targetFrames) finish(nowMs);
      }
    } else {
      okSince = null;
      badSince ??= nowMs;
      if (phase === 'capturing') skipped++;
      if ((phase === 'capturing' || phase === 'hold') && nowMs - badSince > graceMs) {
        restart('adjusting');
      } else if (phase === 'hold') {
        // una pista mala breve pausa la cuenta atrás
        okSince = null;
      }
    }
    return progress();
  }

  return {
    push,
    result: () => (phase === 'complete' ? result : null),
    diagnostics: () => (phase === 'complete' ? diag : null),
    reset(): void {
      phase = 'idle';
      hint = 'no-person';
      frames = [];
      skipped = 0;
      result = null;
      diag = null;
      startMs = null;
      lastNow = -Infinity;
      okSince = null;
      badSince = null;
      lostSince = null;
      history = [];
    },
    options: { heightCm: opts.heightCm, targetFrames },
  };
}

/** Todas las pistas posibles (útil para tests y para tablas i18n completas). */
export const ALL_SCAN_HINTS: readonly ScanHint[] = SCAN_HINTS;
