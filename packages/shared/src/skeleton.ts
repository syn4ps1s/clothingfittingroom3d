import { q, v3, degToRad, cmToM, type Quat, type Vec3, QUAT_IDENTITY } from './math.js';
import type { Measurements } from './measurements.js';

/**
 * Esqueleto canónico de 21 articulaciones, común a cuerpo, prendas, pose y runtime.
 * El orden garantiza que el PADRE siempre precede al HIJO (recorrido lineal para FK).
 *
 * Pose de reposo = "A-pose" (brazos ~38° bajo la horizontal… ver REST_BONE_DIRECTIONS), todas las
 * rotaciones de reposo son identidad en espacio mundo; por tanto una rotación local `r[i]`
 * es un DELTA respecto al reposo expresado en el marco ya rotado del padre.
 */
export const JOINT_NAMES = [
  'pelvis', // 0  raíz (traslación absoluta)
  'spine', // 1  cintura
  'chest', // 2  tórax
  'neck', // 3
  'head', // 4
  'l_clavicle', // 5
  'l_upper_arm', // 6  hombro
  'l_forearm', // 7  codo
  'l_hand', // 8  muñeca
  'r_clavicle', // 9
  'r_upper_arm', // 10
  'r_forearm', // 11
  'r_hand', // 12
  'l_thigh', // 13 cadera
  'l_calf', // 14 rodilla
  'l_foot', // 15 tobillo
  'l_toes', // 16
  'r_thigh', // 17
  'r_calf', // 18
  'r_foot', // 19
  'r_toes', // 20
] as const;
export type JointName = (typeof JOINT_NAMES)[number];
export const JOINT_COUNT = JOINT_NAMES.length;

/** Índice numérico por nombre: `J.l_upper_arm === 6`. */
export const J = Object.fromEntries(JOINT_NAMES.map((n, i) => [n, i])) as {
  readonly [K in JointName]: number;
};

/** Índice del padre (-1 = raíz). */
export const JOINT_PARENT: readonly number[] = [
  -1, 0, 1, 2, 3, 2, 5, 6, 7, 2, 9, 10, 11, 0, 13, 14, 15, 0, 17, 18, 19,
];

const sinA = Math.sin(degToRad(38));
const cosA = Math.cos(degToRad(38));
const legX = Math.sin(degToRad(4.5));
const legY = -Math.cos(degToRad(4.5));
const footDir = v3.normalize([0, -0.32, 0.947]);

/**
 * Dirección unitaria del hueso que sale de cada articulación hacia su hijo "principal" en reposo.
 * Las puntas (head, hands, toes) usan la dirección del hueso padre prolongada.
 * +X = izquierda de la persona.
 */
const RAW_REST_BONE_DIRECTIONS: readonly Vec3[] = [
  [0, 1, 0], // pelvis -> spine
  [0, 1, 0], // spine -> chest
  [0, 1, 0], // chest -> neck
  [0, 1, 0], // neck -> head
  [0, 1, 0], // head -> (punta)
  [1, 0.08, 0], // l_clavicle -> l_upper_arm
  [sinA, -cosA, 0], // l_upper_arm -> l_forearm
  [sinA, -cosA, 0], // l_forearm -> l_hand
  [sinA, -cosA, 0], // l_hand -> (punta)
  [-1, 0.08, 0], // r_clavicle
  [-sinA, -cosA, 0], // r_upper_arm
  [-sinA, -cosA, 0], // r_forearm
  [-sinA, -cosA, 0], // r_hand
  [legX, legY, 0], // l_thigh -> l_calf
  [legX * 0.4, legY, 0], // l_calf -> l_foot
  [footDir[0], footDir[1], footDir[2]], // l_foot -> l_toes
  [0, 0, 1], // l_toes -> (punta)
  [-legX, legY, 0], // r_thigh
  [-legX * 0.4, legY, 0], // r_calf
  [footDir[0], footDir[1], footDir[2]], // r_foot
  [0, 0, 1], // r_toes
];
export const REST_BONE_DIRECTIONS: readonly Vec3[] = RAW_REST_BONE_DIRECTIONS.map((d) =>
  v3.normalize(d),
);

export interface RestJoint {
  readonly name: JointName;
  readonly index: number;
  readonly parent: number;
  /** Posición mundial en reposo (m). */
  readonly position: Vec3;
  /** Offset respecto al padre en reposo (m). */
  readonly localOffset: Vec3;
  /** Longitud del hueso hacia su hijo principal / punta (m). */
  readonly boneLength: number;
}

export interface RestSkeleton {
  readonly joints: readonly RestJoint[];
  /** Estatura usada (m) */
  readonly height: number;
}

/** Proporciones antropométricas (fracciones de la estatura H) — Drillis & Contini / NASA-STD-3000. */
const P = {
  ankleHeight: 0.039,
  shoulderHeight: 0.818,
  neckHeight: 0.835,
  hipJointAboveInseam: 0.075,
  pelvisAboveHip: 0.02,
  spineAbovePelvis: 0.075,
  chestAboveSpine: 0.135,
  headAboveNeck: 0.04,
  headTop: 1.0,
  hipHalfWidth: 0.052,
  clavicleHalf: 0.02,
  handLength: 0.108,
  footBall: 0.09,
  toeLength: 0.05,
};

/**
 * Construye el esqueleto de reposo a partir de medidas COMPLETAS.
 * Función pura y determinista: misma entrada => misma salida.
 */
export function buildRestSkeleton(m: Measurements): RestSkeleton {
  const H = cmToM(m.heightCm);
  const ankleY = P.ankleHeight * H;
  const hipJointY = cmToM(m.inseamCm) + P.hipJointAboveInseam * H;
  const legSpan = Math.max(hipJointY - ankleY, 0.3 * H);
  const thighLen = legSpan * 0.4985;
  const calfLen = legSpan - thighLen;
  const armLen = cmToM(m.armLengthCm);
  const upperLen = armLen * 0.55;
  const foreLen = armLen * 0.45;
  const halfShoulder = cmToM(m.shoulderWidthCm) / 2;

  const pos: Vec3[] = new Array<Vec3>(JOINT_COUNT);
  const lengths: number[] = new Array<number>(JOINT_COUNT).fill(0);

  pos[J.pelvis] = [0, hipJointY + P.pelvisAboveHip * H, 0];
  pos[J.spine] = v3.add(pos[J.pelvis]!, [0, P.spineAbovePelvis * H, 0]);
  pos[J.chest] = v3.add(pos[J.spine]!, [0, P.chestAboveSpine * H, 0]);
  pos[J.neck] = [0, P.neckHeight * H, 0];
  pos[J.head] = v3.add(pos[J.neck]!, [0, P.headAboveNeck * H, 0]);
  lengths[J.pelvis] = v3.distance(pos[J.pelvis]!, pos[J.spine]!);
  lengths[J.spine] = v3.distance(pos[J.spine]!, pos[J.chest]!);
  lengths[J.chest] = v3.distance(pos[J.chest]!, pos[J.neck]!);
  lengths[J.neck] = v3.distance(pos[J.neck]!, pos[J.head]!);
  lengths[J.head] = Math.max(P.headTop * H - pos[J.head]![1], 0.05);

  for (const side of [1, -1] as const) {
    const [cl, ua, fa, ha] =
      side === 1
        ? [J.l_clavicle, J.l_upper_arm, J.l_forearm, J.l_hand]
        : [J.r_clavicle, J.r_upper_arm, J.r_forearm, J.r_hand];
    pos[cl] = [side * P.clavicleHalf * H, P.shoulderHeight * H - 0.01 * H, 0];
    pos[ua] = [side * halfShoulder, P.shoulderHeight * H, 0];
    pos[fa] = v3.add(pos[ua]!, v3.scale(REST_BONE_DIRECTIONS[ua]!, upperLen));
    pos[ha] = v3.add(pos[fa]!, v3.scale(REST_BONE_DIRECTIONS[fa]!, foreLen));
    lengths[cl] = v3.distance(pos[cl]!, pos[ua]!);
    lengths[ua] = upperLen;
    lengths[fa] = foreLen;
    lengths[ha] = P.handLength * H;
  }

  for (const side of [1, -1] as const) {
    const [th, ca, ft, to] =
      side === 1
        ? [J.l_thigh, J.l_calf, J.l_foot, J.l_toes]
        : [J.r_thigh, J.r_calf, J.r_foot, J.r_toes];
    pos[th] = [side * P.hipHalfWidth * H, hipJointY, 0];
    pos[ca] = v3.add(pos[th]!, v3.scale(REST_BONE_DIRECTIONS[th]!, thighLen));
    pos[ft] = v3.add(pos[ca]!, v3.scale(REST_BONE_DIRECTIONS[ca]!, calfLen));
    pos[to] = v3.add(pos[ft]!, v3.scale(REST_BONE_DIRECTIONS[ft]!, P.footBall * H));
    lengths[th] = thighLen;
    lengths[ca] = calfLen;
    lengths[ft] = P.footBall * H;
    lengths[to] = P.toeLength * H;
  }

  const joints = JOINT_NAMES.map((name, i): RestJoint => {
    const parent = JOINT_PARENT[i]!;
    return {
      name,
      index: i,
      parent,
      position: pos[i]!,
      localOffset: parent < 0 ? pos[i]! : v3.sub(pos[i]!, pos[parent]!),
      boneLength: lengths[i]!,
    };
  });
  return { joints, height: H };
}

/**
 * Pose animada del esqueleto en un instante.
 * `rotations[i]` = rotación LOCAL del joint i como delta sobre el reposo (ver doc arriba).
 * `rootPosition` = posición mundial de la pelvis (m) en el espacio de la cámara virtual
 * (cámara en el origen mirando hacia -Z; +Y arriba).
 */
export interface SkeletonPose {
  readonly timestampMs: number;
  readonly rootPosition: Vec3;
  readonly rotations: readonly Quat[];
  /** Confianza global 0..1 */
  readonly confidence: number;
  /** Confianza por articulación 0..1 */
  readonly jointConfidence: readonly number[];
}

export function restPose(rest: RestSkeleton, timestampMs = 0): SkeletonPose {
  return {
    timestampMs,
    rootPosition: rest.joints[J.pelvis]!.position,
    rotations: rest.joints.map(() => QUAT_IDENTITY),
    confidence: 1,
    jointConfidence: rest.joints.map(() => 1),
  };
}

/**
 * Cinemática directa: devuelve, para cada joint, la rotación y posición mundiales.
 */
export function forwardKinematics(
  rest: RestSkeleton,
  pose: SkeletonPose,
): { rotations: Quat[]; positions: Vec3[] } {
  const n = rest.joints.length;
  const rotations: Quat[] = new Array<Quat>(n);
  const positions: Vec3[] = new Array<Vec3>(n);
  for (let i = 0; i < n; i++) {
    const joint = rest.joints[i]!;
    const local = pose.rotations[i] ?? QUAT_IDENTITY;
    if (joint.parent < 0) {
      rotations[i] = q.normalize(local);
      positions[i] = pose.rootPosition;
    } else {
      const pr = rotations[joint.parent]!;
      rotations[i] = q.normalize(q.multiply(pr, local));
      positions[i] = v3.add(positions[joint.parent]!, q.rotate(pr, joint.localOffset));
    }
  }
  return { rotations, positions };
}

/**
 * Matrices de skinning column-major 4x4 (como three.js): M_i · v_rest = Wp_i + Wr_i·(v_rest − restPos_i).
 * `out` opcional (Float32Array de 16·JOINT_COUNT) para evitar asignaciones por fotograma.
 */
export function computeSkinMatrices(
  rest: RestSkeleton,
  pose: SkeletonPose,
  out: Float32Array = new Float32Array(16 * rest.joints.length),
): Float32Array {
  const { rotations, positions } = forwardKinematics(rest, pose);
  for (let i = 0; i < rest.joints.length; i++) {
    const [x, y, z, w] = rotations[i]!;
    const xx = x * x,
      yy = y * y,
      zz = z * z;
    const xy = x * y,
      xz = x * z,
      yz = y * z,
      wx = w * x,
      wy = w * y,
      wz = w * z;
    const r00 = 1 - 2 * (yy + zz),
      r01 = 2 * (xy - wz),
      r02 = 2 * (xz + wy);
    const r10 = 2 * (xy + wz),
      r11 = 1 - 2 * (xx + zz),
      r12 = 2 * (yz - wx);
    const r20 = 2 * (xz - wy),
      r21 = 2 * (yz + wx),
      r22 = 1 - 2 * (xx + yy);
    const rp = rest.joints[i]!.position;
    const wp = positions[i]!;
    // t = Wp - R·restPos
    const tx = wp[0] - (r00 * rp[0] + r01 * rp[1] + r02 * rp[2]);
    const ty = wp[1] - (r10 * rp[0] + r11 * rp[1] + r12 * rp[2]);
    const tz = wp[2] - (r20 * rp[0] + r21 * rp[1] + r22 * rp[2]);
    const o = i * 16;
    out[o] = r00;
    out[o + 1] = r10;
    out[o + 2] = r20;
    out[o + 3] = 0;
    out[o + 4] = r01;
    out[o + 5] = r11;
    out[o + 6] = r21;
    out[o + 7] = 0;
    out[o + 8] = r02;
    out[o + 9] = r12;
    out[o + 10] = r22;
    out[o + 11] = 0;
    out[o + 12] = tx;
    out[o + 13] = ty;
    out[o + 14] = tz;
    out[o + 15] = 1;
  }
  return out;
}
