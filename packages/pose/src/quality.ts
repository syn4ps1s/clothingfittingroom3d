import {
  LM,
  clamp,
  type PoseFrame,
  type ScanHint,
  type Vec3,
  v3,
} from '@fitroom/shared';
import { cleanVis } from './geom.js';

/**
 * Evaluación de la calidad de un fotograma para el escaneo de talla: devuelve UNA pista (clave i18n) por
 * orden de prioridad y las métricas que la motivan. Pura: el historial de movimiento lo lleva el llamante.
 */

export interface QualityThresholds {
  /** luma media mínima (0..255) */
  readonly minLuma: number;
  /** visibilidad mínima de un landmark para contarlo */
  readonly minVis: number;
  /** fracción de la altura de imagen que debe ocupar el cuerpo: [min, max] */
  readonly bodyFraction: readonly [number, number];
  /** margen mínimo (fracción de imagen) arriba y abajo */
  readonly margin: number;
  /** x de la cadera permitida: [min, max] */
  readonly centerRange: readonly [number, number];
  /** coseno mínimo del giro del torso respecto a la cámara */
  readonly minFacing: number;
  /** ángulo mínimo (rad) del brazo respecto a la vertical para considerar que no tapa el torso (A-pose) */
  readonly armAngle: readonly [number];
  /** desplazamiento máximo (fracción de la estatura aparente) dentro de la ventana de quietud */
  readonly maxMotion: number;
  /** razón mínima cadera→tobillo / (muslo + pantorrilla): descarta sentado o en cuclillas */
  readonly minLegStraightness: number;
}

export const DEFAULT_THRESHOLDS: QualityThresholds = {
  minLuma: 45,
  minVis: 0.5,
  bodyFraction: [0.5, 0.92],
  margin: 0.03,
  centerRange: [0.3, 0.7],
  minFacing: 0.85,
  armAngle: [(18 * Math.PI) / 180],
  maxMotion: 0.035,
  minLegStraightness: 0.9,
};

export interface FrameQuality {
  readonly hint: ScanHint;
  /** estatura aparente en fracción del alto de imagen (0 si no se puede estimar) */
  readonly bodyFraction: number;
  /** coseno del giro del torso (1 = de frente) */
  readonly facing: number;
  /** ángulo mínimo de los brazos respecto a la vertical (rad) */
  readonly armAngle: number;
  /** puntos de seguimiento (imagen normalizada) para la ventana de quietud */
  readonly track: readonly [number, number, number, number, number, number, number, number] | null;
}

const CORE = [
  LM.nose,
  LM.l_shoulder,
  LM.r_shoulder,
  LM.l_hip,
  LM.r_hip,
  LM.l_knee,
  LM.r_knee,
  LM.l_ankle,
  LM.r_ankle,
] as const;

const finite3 = (p: { x: number; y: number; z: number } | undefined): boolean =>
  !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

/** Pista para el fotograma (sin tener en cuenta la quietud; ver `motionOf`). */
export function assessFrame(
  frame: PoseFrame | null,
  lumaMean: number | undefined,
  th: QualityThresholds = DEFAULT_THRESHOLDS,
): FrameQuality {
  const none = (hint: ScanHint): FrameQuality => ({
    hint,
    bodyFraction: 0,
    facing: 0,
    armAngle: 0,
    track: null,
  });
  if (!frame || frame.personCount < 1) return none('no-person');
  if (frame.personCount > 1) return none('multiple-people');
  if (
    frame.image.length < 33 ||
    frame.world.length < 33 ||
    !Number.isFinite(frame.imageSize.width) ||
    !Number.isFinite(frame.imageSize.height)
  ) {
    return none('no-person');
  }
  if (lumaMean !== undefined && Number.isFinite(lumaMean) && lumaMean < th.minLuma) {
    return none('too-dark');
  }

  const im = frame.image;
  const w = frame.world;
  const vis = (i: number): number => cleanVis(Math.min(im[i]?.visibility ?? 0, w[i]?.visibility ?? 0));
  const visOk = (i: number): boolean => vis(i) >= th.minVis && finite3(im[i]) && finite3(w[i]);
  const corePresent = CORE.filter(visOk).length;
  // sin torso apenas hay persona
  if (!visOk(LM.l_shoulder) && !visOk(LM.r_shoulder) && !visOk(LM.l_hip) && !visOk(LM.r_hip)) {
    return none('no-person');
  }

  // ---- encuadre y tamaño --------------------------------------------------------------------------
  const feet = [LM.l_heel, LM.r_heel, LM.l_foot_index, LM.r_foot_index, LM.l_ankle, LM.r_ankle];
  const finiteY = (i: number): boolean => Number.isFinite(im[i]?.y) && Number.isFinite(im[i]?.x);
  // landmarks de pie incluso con poca visibilidad (extrapolados): sirven para saber si «se sale» del cuadro
  const feetY = feet.filter(finiteY).map((i) => im[i]!.y);
  const floorY = feetY.length ? Math.max(...feetY) : NaN;
  const noseY = finiteY(LM.nose) ? im[LM.nose]!.y : NaN;
  const hn = Number.isFinite(floorY) && Number.isFinite(noseY) ? (floorY - noseY) / 0.907 : 0;
  const topY = Number.isFinite(noseY) ? noseY - 0.085 * hn : NaN;
  const bodyFraction = clamp(hn, 0, 3);

  const headOk = visOk(LM.nose) || (visOk(LM.l_ear) && visOk(LM.r_ear));
  const feetOk = (visOk(LM.l_ankle) && visOk(LM.r_ankle)) || (visOk(LM.l_heel) && visOk(LM.r_heel));
  const cutBottom = Number.isFinite(floorY) && floorY > 1 - th.margin;
  const cutTop = Number.isFinite(topY) && topY < th.margin;
  const hipMidX = (im[LM.l_hip]!.x + im[LM.r_hip]!.x) / 2;
  const outSide = [...CORE].some((i) => finiteY(i) && vis(i) >= 0.3 && (im[i]!.x < 0.01 || im[i]!.x > 0.99));

  if (corePresent < CORE.length || !headOk || !feetOk) {
    if (cutBottom || cutTop || hn > th.bodyFraction[1]) return { ...none('step-back'), bodyFraction };
    if (outSide) return { ...none('move-to-center'), bodyFraction };
    return { ...none('show-full-body'), bodyFraction };
  }
  if (cutBottom || cutTop || hn > th.bodyFraction[1]) return { ...none('step-back'), bodyFraction };
  if (hn < th.bodyFraction[0]) return { ...none('step-closer'), bodyFraction };
  if (
    !Number.isFinite(hipMidX) ||
    hipMidX < th.centerRange[0] ||
    hipMidX > th.centerRange[1] ||
    outSide
  ) {
    return { ...none('move-to-center'), bodyFraction };
  }

  // ---- orientación del torso respecto a la cámara -------------------------------------------------
  const P = (i: number): Vec3 => [w[i]!.x, w[i]!.y, w[i]!.z];
  const xAxis = v3.sub(P(LM.l_shoulder), P(LM.r_shoulder));
  const shMid = v3.lerp(P(LM.l_shoulder), P(LM.r_shoulder), 0.5);
  const hipMid = v3.lerp(P(LM.l_hip), P(LM.r_hip), 0.5);
  const up = v3.sub(shMid, hipMid);
  const fwd = v3.normalize(v3.cross(xAxis, up), [0, 0, 0]);
  const facing = fwd[2];
  if (!(facing >= th.minFacing) || !visOk(LM.nose)) {
    return { hint: 'face-camera', bodyFraction, facing, armAngle: 0, track: null };
  }

  // ---- de pie con las piernas extendidas (no sentado ni en cuclillas) ----------------------------------
  for (const [h, k, a] of [
    [LM.l_hip, LM.l_knee, LM.l_ankle],
    [LM.r_hip, LM.r_knee, LM.r_ankle],
  ] as const) {
    const chain = v3.distance(P(h), P(k)) + v3.distance(P(k), P(a));
    if (chain > 1e-6 && v3.distance(P(h), P(a)) / chain < th.minLegStraightness) {
      return { ...none('show-full-body'), bodyFraction, facing };
    }
  }

  // ---- brazos separados del tronco (A-pose) -------------------------------------------------------
  let armAngle = Infinity;
  let armsVisible = true;
  for (const [s, e, wr] of [
    [LM.l_shoulder, LM.l_elbow, LM.l_wrist],
    [LM.r_shoulder, LM.r_elbow, LM.r_wrist],
  ] as const) {
    if (!visOk(e) || !visOk(wr)) {
      armsVisible = false;
      continue;
    }
    const upper = v3.sub(P(e), P(s));
    const ang = Math.acos(clamp(-upper[1] / (v3.length(upper) || 1), -1, 1));
    armAngle = Math.min(armAngle, ang);
  }
  if (!armsVisible) return { ...none('show-full-body'), bodyFraction, facing };
  if (armAngle < th.armAngle[0]) {
    return { hint: 'raise-arms-a-pose', bodyFraction, facing, armAngle, track: null };
  }

  const track = [
    hipMidX,
    (im[LM.l_hip]!.y + im[LM.r_hip]!.y) / 2,
    (im[LM.l_shoulder]!.x + im[LM.r_shoulder]!.x) / 2,
    (im[LM.l_shoulder]!.y + im[LM.r_shoulder]!.y) / 2,
    im[LM.nose]!.x,
    im[LM.nose]!.y,
    hn,
    1,
  ] as const;
  return { hint: 'ok', bodyFraction, facing, armAngle, track };
}

/**
 * Movimiento (fracción de la estatura aparente) entre dos puntos de seguimiento: el mayor
 * desplazamiento de cadera, hombros y cabeza.
 */
export function motionBetween(
  a: NonNullable<FrameQuality['track']>,
  b: NonNullable<FrameQuality['track']>,
): number {
  const hn = Math.max(0.05, (a[6] + b[6]) / 2);
  const d = (i: number): number => Math.hypot(a[i]! - b[i]!, a[i + 1]! - b[i + 1]!);
  return Math.max(d(0), d(2), d(4)) / hn;
}
