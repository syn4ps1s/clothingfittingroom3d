import { J, JOINT_COUNT, degToRad, q, v3, type Quat, type Vec3 } from '@fitroom/shared';
import { AXIS_Z, clampAngle, quatAngle, qScale } from './geom.js';

/**
 * Límites articulares anatómicos (rotación LOCAL respecto al reposo, en el marco del padre).
 * Cada rotación se descompone en swing·twist respecto al eje del hueso de reposo:
 *  - swing: cono máximo entre la dirección de reposo y la dirección actual del hueso;
 *  - twist: giro máximo alrededor del propio hueso.
 * Las bisagras (codo, rodilla) además limitan la hiperextensión (doblar «hacia atrás»).
 */
export interface JointLimit {
  /** Ángulo máximo del cono de swing (rad). */
  readonly swingMax: number;
  /** Torsión máxima alrededor del hueso (rad). */
  readonly twistMax: number;
  /** Bisagra: signo de la flexión a lo largo de +Z local (+1 codo: hacia delante; −1 rodilla: hacia atrás). */
  readonly hinge?: {
    readonly flexSign: 1 | -1;
    readonly flexMax: number;
    readonly hyperMax: number;
  };
}

const d = degToRad;

/** Por debajo de este ángulo de flexión no se aplica la restricción de hiperextensión. */
const HINGE_DECIDABLE = degToRad(20);

export const JOINT_LIMITS: readonly (JointLimit | null)[] = (() => {
  const t: (JointLimit | null)[] = new Array<JointLimit | null>(JOINT_COUNT).fill(null);
  t[J.spine] = { swingMax: d(40), twistMax: d(35) };
  t[J.chest] = { swingMax: d(40), twistMax: d(35) };
  t[J.neck] = { swingMax: d(40), twistMax: d(45) };
  t[J.head] = { swingMax: d(50), twistMax: d(60) };
  for (const [cl, ua, fa, ha, th, ca, ft, to] of [
    [J.l_clavicle, J.l_upper_arm, J.l_forearm, J.l_hand, J.l_thigh, J.l_calf, J.l_foot, J.l_toes],
    [J.r_clavicle, J.r_upper_arm, J.r_forearm, J.r_hand, J.r_thigh, J.r_calf, J.r_foot, J.r_toes],
  ] as const) {
    t[cl] = { swingMax: d(30), twistMax: d(20) };
    t[ua] = { swingMax: d(178), twistMax: d(120) };
    t[fa] = {
      swingMax: d(160),
      twistMax: d(100),
      hinge: { flexSign: 1, flexMax: d(155), hyperMax: d(8) },
    };
    t[ha] = { swingMax: d(85), twistMax: d(70) };
    t[th] = { swingMax: d(125), twistMax: d(60) };
    t[ca] = {
      swingMax: d(160),
      twistMax: d(25),
      hinge: { flexSign: -1, flexMax: d(155), hyperMax: d(6) },
    };
    t[ft] = { swingMax: d(55), twistMax: d(30) };
    t[to] = { swingMax: d(50), twistMax: d(10) };
  }
  return t;
})();

/**
 * Aplica el límite del joint `j` a la rotación local `rot`.
 * `restDir` es la dirección unitaria de reposo del hueso (eje de swing/twist).
 * Devuelve la misma rotación si ya cumple el límite.
 */
export function applyJointLimit(j: number, rot: Quat, restDir: Vec3): Quat {
  const lim = JOINT_LIMITS[j];
  if (!lim) return rot;
  // twist alrededor de restDir: proyección de la parte vectorial sobre el eje
  const proj = rot[0] * restDir[0] + rot[1] * restDir[1] + rot[2] * restDir[2];
  let twist: Quat = q.normalize([restDir[0] * proj, restDir[1] * proj, restDir[2] * proj, rot[3]]);
  // q = swing · twist
  let swing: Quat = q.normalize(q.multiply(rot, q.conjugate(twist)));
  if (swing[3] < 0) swing = [-swing[0], -swing[1], -swing[2], -swing[3]];
  if (twist[3] < 0) twist = [-twist[0], -twist[1], -twist[2], -twist[3]];

  let changed = false;
  if (quatAngle(twist) > lim.twistMax) {
    twist = clampAngle(twist, lim.twistMax);
    changed = true;
  }
  let swingMax = lim.swingMax;
  const sAng = quatAngle(swing);
  // La hiperextensión sólo es decidible cuando el plano de la bisagra está bien definido (flexión
  // apreciable); con flexiones pequeñas el signo del componente en Z es ruido.
  if (lim.hinge && sAng > HINGE_DECIDABLE) {
    const dir = q.rotate(swing, restDir);
    const flex = v3.dot(dir, AXIS_Z) * lim.hinge.flexSign;
    swingMax = Math.min(swingMax, flex >= 0 ? lim.hinge.flexMax : lim.hinge.hyperMax);
  } else if (lim.hinge) {
    swingMax = Math.min(swingMax, lim.hinge.flexMax);
  }
  if (sAng > swingMax) {
    swing = qScale(swing, swingMax / sAng);
    changed = true;
  }
  return changed ? q.normalize(q.multiply(swing, twist)) : rot;
}
