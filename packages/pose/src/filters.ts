import {
  POSE_LANDMARK_COUNT,
  clamp,
  type ImageLandmark,
  type PoseFrame,
  type WorldLandmark,
} from '@fitroom/shared';
import { cleanVis } from './geom.js';

/**
 * Filtro One-Euro (Casiez, Roussel, Vogel; CHI 2012): paso bajo adaptativo. La frecuencia de corte
 * sube con la velocidad de la señal: quieto ⇒ mucho suavizado (sin temblor); en movimiento ⇒ poco
 * retardo.
 *
 *   dx̂  = lowpass(dCutoff)( (x − x̂_prev) / dt )
 *   fc  = minCutoff + beta · |dx̂|
 *   x̂   = lowpass(fc)( x )          con  α = 1 / (1 + τ/dt),  τ = 1/(2π·fc)
 *
 * Robustez añadida respecto al original:
 *  - dt irregular (se usa el dt real, acotado a [1 ms, ∞));
 *  - huecos (dt > `maxGapMs`) y saltos (|x − x̂| > `jumpThreshold`) reinician el estado en el valor
 *    nuevo en lugar de arrastrar una estela larga;
 *  - entradas no finitas se ignoran (se devuelve la última salida), nunca contaminan el estado;
 *  - marcas de tiempo repetidas o hacia atrás no actualizan el estado.
 */
export interface OneEuroOptions {
  /** Frecuencia de corte mínima (Hz). Menor ⇒ más suave y más retardo en reposo. Por defecto 1. */
  readonly minCutoff?: number;
  /** Coeficiente de velocidad (Hz por unidad/s). Mayor ⇒ menos retardo al moverse. Por defecto 0. */
  readonly beta?: number;
  /** Corte del filtro de la derivada (Hz). Por defecto 1. */
  readonly dCutoff?: number;
  /** Un hueco mayor que esto (ms) reinicia el filtro. Por defecto 500. */
  readonly maxGapMs?: number;
  /** Un salto mayor que esto (en unidades de la señal) reinicia el filtro. Por defecto ∞. */
  readonly jumpThreshold?: number;
}

const TWO_PI = 2 * Math.PI;
/** Magnitud máxima admitida (absurdos como 1e300 se tratan como entrada inválida). */
const MAX_ABS = 1e9;

function alphaFor(dtSec: number, cutoffHz: number): number {
  const tau = 1 / (TWO_PI * Math.max(cutoffHz, 1e-6));
  return 1 / (1 + tau / dtSec);
}

export class OneEuroFilter {
  readonly minCutoff: number;
  readonly beta: number;
  readonly dCutoff: number;
  readonly maxGapMs: number;
  readonly jumpThreshold: number;

  private has = false;
  private xHat = 0;
  private dxHat = 0;
  private tPrev = 0;

  constructor(opts: OneEuroOptions = {}) {
    this.minCutoff = opts.minCutoff ?? 1;
    this.beta = opts.beta ?? 0;
    this.dCutoff = opts.dCutoff ?? 1;
    this.maxGapMs = opts.maxGapMs ?? 500;
    this.jumpThreshold = opts.jumpThreshold ?? Infinity;
    if (!(this.minCutoff > 0) || !(this.dCutoff > 0) || !(this.beta >= 0)) {
      throw new RangeError('OneEuroFilter: minCutoff>0, dCutoff>0, beta>=0');
    }
  }

  /** Última salida (0 si aún no hay datos). */
  get value(): number {
    return this.xHat;
  }

  /** ¿Ha recibido ya algún dato válido? */
  get primed(): boolean {
    return this.has;
  }

  /** Estimación de la velocidad filtrada (unidades/s). */
  get velocity(): number {
    return this.dxHat;
  }

  reset(): void {
    this.has = false;
    this.xHat = 0;
    this.dxHat = 0;
    this.tPrev = 0;
  }

  /**
   * Filtra la muestra `x` tomada en `tMs`. Devuelve siempre un número finito: ante una entrada no
   * finita devuelve la última salida (o 0 si no hay ninguna).
   */
  filter(x: number, tMs: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(tMs) || Math.abs(x) > MAX_ABS) return this.xHat;
    if (!this.has) return this.prime(x, tMs);
    const dtMs = tMs - this.tPrev;
    if (dtMs < 0 && dtMs < -1000) return this.prime(x, tMs); // el reloj se reinició
    if (dtMs <= 0) return this.xHat; // repetida o ligeramente hacia atrás: se ignora
    if (dtMs > this.maxGapMs || Math.abs(x - this.xHat) > this.jumpThreshold) {
      return this.prime(x, tMs);
    }
    const dt = Math.max(dtMs, 1) / 1000;
    const dx = (x - this.xHat) / dt;
    if (!Number.isFinite(dx)) return this.prime(x, tMs);
    this.dxHat += alphaFor(dt, this.dCutoff) * (dx - this.dxHat);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxHat);
    this.xHat += alphaFor(dt, cutoff) * (x - this.xHat);
    this.tPrev = tMs;
    return this.xHat;
  }

  private prime(x: number, tMs: number): number {
    this.has = true;
    this.xHat = x;
    this.dxHat = 0;
    this.tPrev = tMs;
    return x;
  }
}

// ---------------------------------------------------------------------------------------------

export interface PoseSmootherOptions {
  /** Parámetros del filtro para coordenadas de imagen normalizadas (0..1). */
  readonly image?: OneEuroOptions;
  /** Parámetros del filtro para coordenadas world (m). */
  readonly world?: OneEuroOptions;
  /** Constante de tiempo (ms) del suavizado al SUBIR la visibilidad (al bajar sigue casi sin retardo). */
  readonly visibilityTauMs?: number;
  /** Hueco (ms) sin fotogramas tras el cual se reinicia todo el estado. Por defecto 400. */
  readonly maxGapMs?: number;
  /** Salto de imagen (normalizado) que reinicia un landmark. Por defecto 0.25. */
  readonly jumpImage?: number;
  /** Salto world (m) que reinicia un landmark. Por defecto 0.5. */
  readonly jumpWorld?: number;
  /** Si al menos esta fracción de landmarks salta, se reinician todos (cambio de persona). Por defecto 0.4. */
  readonly resetFraction?: number;
}

/** Valores por defecto: ≈ 25–30 fps, jitter de MediaPipe ≈ 3–8 mm en world, 0.2–0.5 % en imagen. */
export const DEFAULT_IMAGE_FILTER: OneEuroOptions = { minCutoff: 1.5, beta: 25, dCutoff: 1 };
export const DEFAULT_WORLD_FILTER: OneEuroOptions = { minCutoff: 1.2, beta: 8, dCutoff: 1 };

/**
 * Suavizado de landmarks por fotograma: un One-Euro por coordenada (x, y, z) de cada uno de los 33
 * landmarks, en imagen y en world. La visibilidad se suaviza con ataque rápido y subida lenta (una
 * oclusión se refleja de inmediato; una reaparición no hace parpadear).
 */
export class PoseSmoother {
  private readonly imgF: OneEuroFilter[][];
  private readonly wldF: OneEuroFilter[][];
  private readonly vis = new Float64Array(POSE_LANDMARK_COUNT);
  private visPrimed = false;
  private lastT = -Infinity;
  private last: PoseFrame | null = null;
  private readonly maxGapMs: number;
  private readonly jumpImage: number;
  private readonly jumpWorld: number;
  private readonly resetFraction: number;
  private readonly visTau: number;

  constructor(opts: PoseSmootherOptions = {}) {
    const mk = (base: OneEuroOptions): OneEuroFilter[][] =>
      Array.from({ length: POSE_LANDMARK_COUNT }, () =>
        Array.from(
          { length: 3 },
          // huecos y saltos los gestiona el PoseSmoother (a nivel de landmark y de fotograma)
          () => new OneEuroFilter({ ...base, maxGapMs: Infinity, jumpThreshold: Infinity }),
        ),
      );
    this.maxGapMs = opts.maxGapMs ?? 400;
    this.jumpImage = opts.jumpImage ?? 0.25;
    this.jumpWorld = opts.jumpWorld ?? 0.5;
    this.resetFraction = opts.resetFraction ?? 0.4;
    this.visTau = opts.visibilityTauMs ?? 120;
    this.imgF = mk({ ...DEFAULT_IMAGE_FILTER, ...opts.image });
    this.wldF = mk({ ...DEFAULT_WORLD_FILTER, ...opts.world });
  }

  reset(): void {
    for (const row of this.imgF) for (const f of row) f.reset();
    for (const row of this.wldF) for (const f of row) f.reset();
    this.vis.fill(0);
    this.visPrimed = false;
    this.lastT = -Infinity;
    this.last = null;
  }

  /**
   * Suaviza un fotograma. `null` (sin persona) se devuelve tal cual; si el hueco supera `maxGapMs`
   * el siguiente fotograma reinicia los filtros. Marcas de tiempo repetidas devuelven el último
   * resultado. Los landmarks no finitos se sustituyen por la última salida con visibilidad 0.
   */
  smooth(frame: PoseFrame | null): PoseFrame | null {
    if (!frame) return null;
    const t = frame.timestampMs;
    if (!Number.isFinite(t)) return this.last;
    if (t === this.lastT && this.last) return this.last;
    if (t < this.lastT - 1000 || t - this.lastT > this.maxGapMs) this.reset();
    if (t < this.lastT && this.last) return this.last; // ligeramente hacia atrás: se ignora
    const dt = Number.isFinite(this.lastT) ? t - this.lastT : 0;

    // ¿Saltó la mayoría de landmarks (otra persona / reencuadre)? ⇒ reinicio global
    if (this.last) {
      let jumped = 0;
      let counted = 0;
      for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
        const lm = frame.world[i];
        const fx = this.wldF[i]![0]!;
        if (!lm || !Number.isFinite(lm.x) || !fx.primed) continue;
        counted++;
        if (
          Math.hypot(
            lm.x - fx.value,
            lm.y - this.wldF[i]![1]!.value,
            lm.z - this.wldF[i]![2]!.value,
          ) > this.jumpWorld
        )
          jumped++;
      }
      if (counted > 0 && jumped / counted >= this.resetFraction) this.reset();
    }

    const image: ImageLandmark[] = new Array<ImageLandmark>(POSE_LANDMARK_COUNT);
    const world: WorldLandmark[] = new Array<WorldLandmark>(POSE_LANDMARK_COUNT);
    const aUp = dt > 0 ? 1 / (1 + this.visTau / dt) : 1;
    for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
      const im = frame.image[i];
      const wl = frame.world[i];
      const rawVis = cleanVis(wl?.visibility ?? im?.visibility);
      const imOk = !!im && Number.isFinite(im.x) && Number.isFinite(im.y) && Number.isFinite(im.z);
      const wlOk = !!wl && Number.isFinite(wl.x) && Number.isFinite(wl.y) && Number.isFinite(wl.z);
      const fi = this.imgF[i]!;
      const fw = this.wldF[i]!;
      // saltos individuales ⇒ reinicio de ese landmark
      if (
        imOk &&
        fi[0]!.primed &&
        Math.hypot(im.x - fi[0]!.value, im.y - fi[1]!.value) > this.jumpImage
      ) {
        for (const f of fi) f.reset();
      }
      if (
        wlOk &&
        fw[0]!.primed &&
        Math.hypot(wl.x - fw[0]!.value, wl.y - fw[1]!.value, wl.z - fw[2]!.value) > this.jumpWorld
      ) {
        for (const f of fw) f.reset();
      }
      // visibilidad: baja rápido, sube despacio
      let v: number;
      const bad = !imOk || !wlOk;
      const target = bad ? 0 : rawVis;
      if (!this.visPrimed) v = target;
      else {
        const prev = this.vis[i]!;
        v = target < prev ? prev + 0.7 * (target - prev) : prev + aUp * (target - prev);
      }
      this.vis[i] = v;
      v = clamp(v, 0, 1);
      image[i] = {
        x: fi[0]!.filter(imOk ? im.x : NaN, t),
        y: fi[1]!.filter(imOk ? im.y : NaN, t),
        z: fi[2]!.filter(imOk ? im.z : NaN, t),
        visibility: v,
      };
      world[i] = {
        x: fw[0]!.filter(wlOk ? wl.x : NaN, t),
        y: fw[1]!.filter(wlOk ? wl.y : NaN, t),
        z: fw[2]!.filter(wlOk ? wl.z : NaN, t),
        visibility: v,
      };
    }
    this.visPrimed = true;
    this.lastT = t;
    const out: PoseFrame = {
      timestampMs: t,
      imageSize: frame.imageSize,
      image,
      world,
      ...(frame.mask ? { mask: frame.mask } : {}),
      personCount: frame.personCount,
    };
    this.last = out;
    return out;
  }
}
