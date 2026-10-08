import {
  J,
  JOINT_COUNT,
  QUAT_IDENTITY,
  REST_BONE_DIRECTIONS,
  clamp,
  degToRad,
  lerp,
  q,
  smoothstep,
  v3,
  type Quat,
  type Vec3,
} from '@fitroom/shared';
import { AXIS_X, AXIS_Y, AXIS_Z } from './geom.js';

/**
 * Poses canónicas del proveedor sintético, como conjuntos de rotaciones LOCALES sobre la A-pose de
 * reposo (todas las rotaciones de reposo son identidad en mundo ⇒ un giro del padre alrededor de un
 * eje mundo equivale al mismo giro local mientras los ancestros estén en identidad).
 */

export type SyntheticPoseName =
  'a-pose' | 't-pose' | 'arms-up' | 'walk' | 'turn' | 'sit' | 'jitter';

/** Poses adicionales (sólo para pruebas de asimetría y casos extremos). */
export type ExtendedPoseName = 'wave' | 'lean' | 'squat' | 'reach' | 'twist';

export type AnyPoseName = SyntheticPoseName | ExtendedPoseName;

export const ALL_POSE_NAMES: readonly AnyPoseName[] = [
  'a-pose',
  't-pose',
  'arms-up',
  'walk',
  'turn',
  'sit',
  'jitter',
  'wave',
  'lean',
  'squat',
  'reach',
  'twist',
];

/** Estado de una pose en un instante: rotaciones locales + movimiento global de la raíz. */
export interface PoseState {
  readonly rot: readonly Quat[];
  /** Giro adicional del cuerpo alrededor de +Y (rad). */
  readonly yaw: number;
  /** Desplazamiento lateral (+X) de la pelvis respecto a su sitio base (m). */
  readonly dx: number;
  /** Desplazamiento en profundidad (+Z = hacia la cámara) (m). */
  readonly dz: number;
  /** Ruido extra de landmarks (m) para la pose `jitter`. */
  readonly extraNoiseM: number;
}

const d = degToRad;
const ID = (): Quat[] => new Array<Quat>(JOINT_COUNT).fill(QUAT_IDENTITY);
const rotAbout = (axis: Vec3, deg: number): Quat => q.fromAxisAngle(axis, d(deg));
const mul = (...qs: Quat[]): Quat => qs.reduce((a, b) => q.normalize(q.multiply(a, b)));

/** Giro del hueso `j` que lo lleva hacia +Z (flexión «hacia delante») `deg` grados. */
const flexFwd = (j: number, deg: number): Quat =>
  q.fromAxisAngle(v3.cross(REST_BONE_DIRECTIONS[j]!, AXIS_Z), d(deg));
/** Flexión hacia atrás (rodilla). */
const flexBack = (j: number, deg: number): Quat =>
  q.fromAxisAngle(v3.cross(AXIS_Z, REST_BONE_DIRECTIONS[j]!), d(deg));

const L = 1; // lado izquierdo
const R = -1;

/** Abducción del brazo: giro alrededor de Z (a partir de los −52° de reposo). */
const armAbduct = (side: 1 | -1, deg: number): Quat => rotAbout(AXIS_Z, side * deg);

const A_ARM = 52; // grados de elevación de reposo bajo la horizontal

function setArms(r: Quat[], leftAbduct: number, rightAbduct: number): void {
  r[J.l_upper_arm] = armAbduct(L, leftAbduct);
  r[J.r_upper_arm] = armAbduct(R, rightAbduct);
}

export const POSE_DURATION_HINT_MS = 2000;

/** Evalúa la pose `name` en el instante local `tMs` (desde el inicio de su tramo). */
export function evalPose(name: AnyPoseName, tMs: number, durationMs: number): PoseState {
  const r = ID();
  let yaw = 0;
  let dx = 0;
  let dz = 0;
  let extraNoiseM = 0;
  const t = tMs / 1000;
  switch (name) {
    case 'a-pose':
      break;
    case 'jitter':
      extraNoiseM = 0.012;
      break;
    case 't-pose':
      setArms(r, A_ARM, A_ARM);
      break;
    case 'arms-up': {
      // pasa de A-pose a brazos arriba en V durante el primer 25 % del tramo
      const k = smoothstep(0, Math.max(1, durationMs * 0.25), tMs);
      setArms(r, lerp(0, 132, k), lerp(0, 132, k));
      r[J.l_clavicle] = rotAbout(AXIS_Z, 10 * k);
      r[J.r_clavicle] = rotAbout(AXIS_Z, -10 * k);
      r[J.l_forearm] = flexFwd(J.l_forearm, 6 * k);
      r[J.r_forearm] = flexFwd(J.r_forearm, 6 * k);
      break;
    }
    case 'walk': {
      const f = 0.95; // Hz (un paso por semiciclo)
      const ph = 2 * Math.PI * f * t;
      const s = Math.sin(ph);
      const hipAmp = 24;
      const kneeAmp = 48;
      const armAmp = 20;
      // muslos: adelante positivo (giro hacia +Z)
      r[J.l_thigh] = flexFwd(J.l_thigh, hipAmp * s);
      r[J.r_thigh] = flexFwd(J.r_thigh, -hipAmp * s);
      // rodilla: se flexiona durante el balanceo (cuando la cadera avanza)
      r[J.l_calf] = flexBack(J.l_calf, kneeAmp * Math.max(0, Math.cos(ph)) + 4);
      r[J.r_calf] = flexBack(J.r_calf, kneeAmp * Math.max(0, -Math.cos(ph)) + 4);
      // brazos: contrafase de las piernas
      r[J.l_upper_arm] = mul(rotAbout(AXIS_X, armAmp * s), armAbduct(L, 0));
      r[J.r_upper_arm] = mul(rotAbout(AXIS_X, -armAmp * s), armAbduct(R, 0));
      r[J.l_forearm] = flexFwd(J.l_forearm, 22 + 8 * Math.max(0, -s));
      r[J.r_forearm] = flexFwd(J.r_forearm, 22 + 8 * Math.max(0, s));
      // pelvis/tórax en contragiro
      yaw = d(5) * s;
      r[J.chest] = rotAbout(AXIS_Y, -9 * s);
      dx = 0.015 * Math.sin(ph);
      break;
    }
    case 'turn': {
      const T = Math.max(1, durationMs);
      const k = 0.5 - 0.5 * Math.cos((2 * Math.PI * clamp(tMs, 0, T)) / T);
      yaw = d(90) * k;
      break;
    }
    case 'sit': {
      const k = smoothstep(0, Math.max(1, durationMs * 0.3), tMs);
      r[J.l_thigh] = flexFwd(J.l_thigh, 85 * k);
      r[J.r_thigh] = flexFwd(J.r_thigh, 85 * k);
      r[J.l_calf] = flexBack(J.l_calf, 88 * k);
      r[J.r_calf] = flexBack(J.r_calf, 88 * k);
      r[J.l_upper_arm] = rotAbout(AXIS_X, -28 * k);
      r[J.r_upper_arm] = rotAbout(AXIS_X, -28 * k);
      r[J.l_forearm] = flexFwd(J.l_forearm, 45 * k);
      r[J.r_forearm] = flexFwd(J.r_forearm, 45 * k);
      r[J.spine] = rotAbout(AXIS_X, -4 * k);
      break;
    }
    case 'wave': {
      // brazo izquierdo arriba saludando; derecho en reposo
      const k = smoothstep(0, Math.max(1, durationMs * 0.2), tMs);
      r[J.l_upper_arm] = armAbduct(L, 100 * k);
      r[J.l_clavicle] = rotAbout(AXIS_Z, 6 * k);
      r[J.l_forearm] = flexFwd(J.l_forearm, (70 + 20 * Math.sin(2 * Math.PI * 1.6 * t)) * k);
      break;
    }
    case 'lean': {
      const k = smoothstep(0, Math.max(1, durationMs * 0.4), tMs);
      r[J.pelvis] = rotAbout(AXIS_X, 8 * k);
      r[J.spine] = rotAbout(AXIS_X, 8 * k);
      r[J.chest] = rotAbout(AXIS_X, 6 * k);
      r[J.neck] = rotAbout(AXIS_X, -6 * k);
      break;
    }
    case 'squat': {
      const k = smoothstep(0, Math.max(1, durationMs * 0.4), tMs);
      r[J.l_thigh] = mul(flexFwd(J.l_thigh, 70 * k), rotAbout(AXIS_Z, 8 * k));
      r[J.r_thigh] = mul(flexFwd(J.r_thigh, 70 * k), rotAbout(AXIS_Z, -8 * k));
      r[J.l_calf] = flexBack(J.l_calf, 105 * k);
      r[J.r_calf] = flexBack(J.r_calf, 105 * k);
      r[J.pelvis] = rotAbout(AXIS_X, 10 * k);
      r[J.l_upper_arm] = rotAbout(AXIS_X, -60 * k);
      r[J.r_upper_arm] = rotAbout(AXIS_X, -60 * k);
      break;
    }
    case 'reach': {
      // brazo derecho al frente y arriba, tronco girado a la izquierda
      const k = smoothstep(0, Math.max(1, durationMs * 0.3), tMs);
      r[J.r_upper_arm] = mul(rotAbout(AXIS_X, -95 * k), armAbduct(R, 20 * k));
      r[J.r_forearm] = flexFwd(J.r_forearm, 25 * k);
      r[J.chest] = rotAbout(AXIS_Y, 18 * k);
      r[J.spine] = rotAbout(AXIS_Y, 10 * k);
      break;
    }
    case 'twist': {
      const k = Math.sin((2 * Math.PI * t) / Math.max(0.5, durationMs / 1000));
      r[J.spine] = rotAbout(AXIS_Y, 14 * k);
      r[J.chest] = rotAbout(AXIS_Y, 18 * k);
      r[J.head] = rotAbout(AXIS_Y, 20 * k);
      r[J.neck] = rotAbout(AXIS_Y, 10 * k);
      setArms(r, A_ARM * 0.6, A_ARM * 0.6);
      break;
    }
  }
  return { rot: r, yaw, dx, dz, extraNoiseM };
}

/** Mezcla dos estados de pose (slerp de rotaciones, lerp del resto). */
export function blendPoseStates(a: PoseState, b: PoseState, t: number): PoseState {
  const k = clamp(t, 0, 1);
  return {
    rot: a.rot.map((qa, i) => q.slerp(qa, b.rot[i]!, k)),
    yaw: lerp(a.yaw, b.yaw, k),
    dx: lerp(a.dx, b.dx, k),
    dz: lerp(a.dz, b.dz, k),
    extraNoiseM: lerp(a.extraNoiseM, b.extraNoiseM, k),
  };
}

// ---------------------------------------------------------------------------------------------
// Poses aleatorias plausibles (para pruebas de propiedades y fuzz)
// ---------------------------------------------------------------------------------------------

/**
 * Pose aleatoria plausible: todas las articulaciones dentro del 80 % de sus límites anatómicos y con
 * la flexión de tronco acotada (≈ ±9° de flexión total repartida en pelvis/columna/tórax: la
 * curvatura de la columna NO es observable con 33 landmarks y limita el error de las articulaciones
 * inferidas, ver ACCURACY.md). Parámetro `trunkScale` > 1 ensancha esos rangos. `rand` devuelve uniformes en [0,1).
 */
export function samplePlausiblePose(rand: () => number, trunkScale = 1): PoseState {
  const u = (a: number, b: number): number => a + (b - a) * rand();
  const ut = (a: number, b: number): number => u(a * trunkScale, b * trunkScale);
  const r = ID();
  const yaw = d(u(-50, 50));
  r[J.pelvis] = mul(rotAbout(AXIS_X, ut(-3, 3)), rotAbout(AXIS_Z, ut(-2, 2)));
  r[J.spine] = mul(
    rotAbout(AXIS_X, ut(-3, 3)),
    rotAbout(AXIS_Y, u(-12, 12)),
    rotAbout(AXIS_Z, ut(-2, 2)),
  );
  r[J.chest] = mul(
    rotAbout(AXIS_X, ut(-3, 3)),
    rotAbout(AXIS_Y, u(-14, 14)),
    rotAbout(AXIS_Z, ut(-2, 2)),
  );
  r[J.neck] = mul(rotAbout(AXIS_X, u(-8, 8)), rotAbout(AXIS_Y, u(-20, 20)));
  r[J.head] = mul(
    rotAbout(AXIS_X, u(-12, 12)),
    rotAbout(AXIS_Y, u(-25, 25)),
    rotAbout(AXIS_Z, u(-8, 8)),
  );
  for (const side of [L, R] as const) {
    const cl = side === L ? J.l_clavicle : J.r_clavicle;
    const ua = side === L ? J.l_upper_arm : J.r_upper_arm;
    const fa = side === L ? J.l_forearm : J.r_forearm;
    const hd = side === L ? J.l_hand : J.r_hand;
    const th = side === L ? J.l_thigh : J.r_thigh;
    const ca = side === L ? J.l_calf : J.r_calf;
    const ft = side === L ? J.l_foot : J.r_foot;
    // ritmo escapulohumeral: la clavícula se eleva ≈ 8 % de la elevación del brazo
    const abd = u(-8, 150);
    r[cl] = mul(rotAbout(AXIS_Z, side * (0.08 * abd + u(-2, 2))), rotAbout(AXIS_Y, u(-4, 4)));
    // brazo: abducción −8..150°, flexión ∓70°, torsión ±40° alrededor de su eje
    r[ua] = mul(
      rotAbout(AXIS_X, u(-70, 70)),
      armAbduct(side, abd),
      q.fromAxisAngle(REST_BONE_DIRECTIONS[ua]!, d(u(-40, 40))),
    );
    r[fa] = flexFwd(fa, u(0, 140));
    r[hd] = mul(rotAbout(AXIS_X, u(-25, 25)), rotAbout(AXIS_Z, u(-25, 25)));
    // pierna: flexión de cadera −20..90°, abducción −8..30°, torsión ±20°
    r[th] = mul(
      flexFwd(th, u(-20, 90)),
      rotAbout(AXIS_Z, side * u(-8, 30)),
      q.fromAxisAngle(REST_BONE_DIRECTIONS[th]!, d(u(-20, 20))),
    );
    r[ca] = flexBack(ca, u(0, 130));
    r[ft] = mul(rotAbout(AXIS_X, u(-20, 20)), rotAbout(AXIS_Y, u(-15, 15)));
  }
  return { rot: r, yaw, dx: 0, dz: 0, extraNoiseM: 0 };
}
