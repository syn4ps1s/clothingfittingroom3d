import {
  J,
  LM,
  MEASUREMENT_LIMITS,
  POSE_LANDMARK_COUNT,
  REST_BONE_DIRECTIONS,
  buildRestSkeleton,
  clamp,
  v3,
  type Measurements,
  type RestSkeleton,
  type Vec3,
} from '@fitroom/shared';

/**
 * «Rig» de landmarks: relación entre los 33 landmarks de MediaPipe y el esqueleto canónico.
 *
 * - 12 landmarks de las extremidades COINCIDEN con una articulación (hombro = `*_upper_arm`, codo =
 *   `*_forearm`, muñeca = `*_hand`, cadera = `*_thigh`, rodilla = `*_calf`, tobillo = `*_foot`).
 * - El resto (cara, dedos, talón, punta del pie) se define como un desplazamiento fijo, expresado en
 *   fracciones de la estatura H y en el marco de REPOSO (todas las rotaciones de reposo son identidad),
 *   anclado a una articulación. Se rota con la articulación al generar landmarks sintéticos y se usa
 *   en reposo como vector de referencia en el retargeting (así «sin movimiento» ⇒ rotación identidad).
 */

/** Landmark → articulación del esqueleto cuando coinciden exactamente. */
export const LM_JOINT: Readonly<Partial<Record<number, number>>> = {
  [LM.l_shoulder]: J.l_upper_arm,
  [LM.r_shoulder]: J.r_upper_arm,
  [LM.l_elbow]: J.l_forearm,
  [LM.r_elbow]: J.r_forearm,
  [LM.l_wrist]: J.l_hand,
  [LM.r_wrist]: J.r_hand,
  [LM.l_hip]: J.l_thigh,
  [LM.r_hip]: J.r_thigh,
  [LM.l_knee]: J.l_calf,
  [LM.r_knee]: J.r_calf,
  [LM.l_ankle]: J.l_foot,
  [LM.r_ankle]: J.r_foot,
};

export interface RigOffset {
  /** Articulación a la que va anclado. */
  readonly joint: number;
  /** Desplazamiento en el marco de reposo, en fracciones de la estatura H. */
  readonly offset: Vec3;
}

const mirrorX = (v: Vec3): Vec3 => [-v[0], v[1], v[2]];

/** Dirección de reposo de la mano (izquierda/derecha) para colocar los dedos. */
const handDir = (side: 1 | -1): Vec3 => REST_BONE_DIRECTIONS[side === 1 ? J.l_hand : J.r_hand]!;

function handOffsets(side: 1 | -1): Record<'pinky' | 'index' | 'thumb', Vec3> {
  const d = handDir(side);
  return {
    pinky: v3.add(v3.scale(d, 0.066), [0, 0, -0.012]),
    index: v3.add(v3.scale(d, 0.075), [0, 0, 0.01]),
    thumb: v3.add(v3.scale(d, 0.042), [0, 0, 0.028]),
  };
}

const NOSE: Vec3 = [0, 0.04, 0.06];
const EYE_IN: Vec3 = [0.01, 0.062, 0.05];
const EYE: Vec3 = [0.017, 0.062, 0.048];
const EYE_OUT: Vec3 = [0.026, 0.062, 0.042];
const EAR: Vec3 = [0.042, 0.052, -0.005];
const MOUTH: Vec3 = [0.012, 0.02, 0.05];
const HEEL: Vec3 = [0, -0.039, -0.032];
const TOE_TIP: Vec3 = [0, 0, 0.05];

/** Desplazamientos del rig por índice de landmark (sólo los que NO coinciden con una articulación). */
export const LM_OFFSETS: Readonly<Partial<Record<number, RigOffset>>> = (() => {
  const hl = handOffsets(1);
  const hr = handOffsets(-1);
  return {
    [LM.nose]: { joint: J.head, offset: NOSE },
    [LM.l_eye_inner]: { joint: J.head, offset: EYE_IN },
    [LM.l_eye]: { joint: J.head, offset: EYE },
    [LM.l_eye_outer]: { joint: J.head, offset: EYE_OUT },
    [LM.r_eye_inner]: { joint: J.head, offset: mirrorX(EYE_IN) },
    [LM.r_eye]: { joint: J.head, offset: mirrorX(EYE) },
    [LM.r_eye_outer]: { joint: J.head, offset: mirrorX(EYE_OUT) },
    [LM.l_ear]: { joint: J.head, offset: EAR },
    [LM.r_ear]: { joint: J.head, offset: mirrorX(EAR) },
    [LM.mouth_l]: { joint: J.head, offset: MOUTH },
    [LM.mouth_r]: { joint: J.head, offset: mirrorX(MOUTH) },
    [LM.l_pinky]: { joint: J.l_hand, offset: hl.pinky },
    [LM.l_index]: { joint: J.l_hand, offset: hl.index },
    [LM.l_thumb]: { joint: J.l_hand, offset: hl.thumb },
    [LM.r_pinky]: { joint: J.r_hand, offset: hr.pinky },
    [LM.r_index]: { joint: J.r_hand, offset: hr.index },
    [LM.r_thumb]: { joint: J.r_hand, offset: hr.thumb },
    [LM.l_heel]: { joint: J.l_foot, offset: HEEL },
    [LM.r_heel]: { joint: J.r_foot, offset: HEEL },
    [LM.l_foot_index]: { joint: J.l_toes, offset: TOE_TIP },
    [LM.r_foot_index]: { joint: J.r_toes, offset: TOE_TIP },
  };
})();

/** Articulación a la que va anclado cada landmark (propia o por rig). */
export function anchorJoint(lm: number): number {
  return LM_JOINT[lm] ?? LM_OFFSETS[lm]?.joint ?? J.pelvis;
}

/**
 * Posición de cada landmark de un esqueleto en reposo (m, en el marco de reposo del esqueleto).
 * Es la referencia para las direcciones «de reposo» que usa el retargeting.
 */
export function restLandmarks(rest: RestSkeleton): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
    const j = LM_JOINT[i];
    if (j !== undefined) {
      out.push(rest.joints[j]!.position);
      continue;
    }
    const o = LM_OFFSETS[i];
    if (o) out.push(v3.add(rest.joints[o.joint]!.position, v3.scale(o.offset, rest.height)));
    else out.push(rest.joints[J.pelvis]!.position);
  }
  return out;
}

/**
 * Medidas completas «razonables» para una estatura (proporciones medias de adulto, IMC 23).
 * Sólo para el proveedor sintético y valores por defecto internos: NO sustituye a
 * `completeMeasurements` de @fitroom/body (el paquete pose no depende de body).
 */
export function defaultMeasurementsForHeight(
  heightCm: number,
  bodyBase: Measurements['bodyBase'] = 'neutral',
): Measurements {
  const H = clamp(
    Number.isFinite(heightCm) ? heightCm : 170,
    MEASUREMENT_LIMITS.heightCm.min,
    MEASUREMENT_LIMITS.heightCm.max,
  );
  const lim = (k: keyof typeof MEASUREMENT_LIMITS, v: number): number =>
    clamp(v, MEASUREMENT_LIMITS[k].min, MEASUREMENT_LIMITS[k].max);
  const hm = H / 100;
  return {
    heightCm: H,
    weightKg: lim('weightKg', 23 * hm * hm),
    chestCm: lim('chestCm', 0.54 * H),
    waistCm: lim('waistCm', 0.45 * H),
    hipCm: lim('hipCm', 0.56 * H),
    shoulderWidthCm: lim('shoulderWidthCm', 0.255 * H),
    armLengthCm: lim('armLengthCm', 0.338 * H),
    inseamCm: lim('inseamCm', 0.455 * H),
    neckCm: lim('neckCm', 0.205 * H),
    thighCm: lim('thighCm', 0.315 * H),
    bodyBase,
  };
}

/** Esqueleto de reposo por defecto para una estatura. */
export const defaultRestForHeight = (heightCm: number): RestSkeleton =>
  buildRestSkeleton(defaultMeasurementsForHeight(heightCm));
