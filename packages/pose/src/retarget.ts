import {
  J,
  JOINT_COUNT,
  LM,
  POSE_LANDMARK_COUNT,
  QUAT_IDENTITY,
  REST_BONE_DIRECTIONS,
  clamp,
  degToRad,
  q,
  v3,
  type CameraIntrinsics,
  type PoseFrame,
  type PoseToSkeleton,
  type Quat,
  type RestSkeleton,
  type SkeletonPose,
  type Vec3,
} from '@fitroom/shared';
import { cameraScales, rayFromNormalized, sanitizeCamera } from './camera.js';
import {
  AXIS_X,
  AXIS_Y,
  AXIS_Z,
  cleanVis,
  frameFromXUp,
  frameFromYX,
  frameFromZX,
  qRelative,
  sanitizeQuat,
  sstep,
} from './geom.js';
import { applyJointLimit } from './limits.js';
import { restLandmarks } from './rig.js';

/**
 * Retargeting landmarks → esqueleto canónico.
 *
 * Método (jerárquico, de la raíz a las puntas):
 *  1. Marcos del tronco: pelvis (línea de caderas + cuerda cadera→hombros) y tórax (línea de hombros +
 *     misma cuerda). La columna interpola ambos. La cabeza usa un marco TRIAD con orejas+nariz, referido
 *     al mismo marco calculado sobre el reposo (así «sin movimiento» ⇒ rotación identidad).
 *  2. Extremidades: rotación SWING mínima que lleva la dirección de reposo del hueso a la dirección
 *     medida (landmark→landmark) EXPRESADA EN EL MARCO LOCAL DEL PADRE ya colocado. Por eso las posiciones
 *     FK de las articulaciones coinciden con los landmarks salvo diferencias de longitud de hueso.
 *     La torsión de brazo/muslo se obtiene de alinear el plano de la bisagra (codo/rodilla).
 *  3. Límites articulares (cono + torsión + hiperextensión) y mezcla por visibilidad con la última
 *     rotación buena (o el reposo) para evitar parpadeos cuando un landmark se pierde.
 *  4. Raíz: la posición de la pelvis en espacio cámara se obtiene por mínimos cuadrados ponderados
 *     (rayos pinhole de los landmarks de imagen ↔ posiciones FK con la escala métrica del esqueleto).
 */

export interface RetargetOptions {
  /** Confianza global mínima para devolver pose (si no, `null`). Por defecto 0.2. */
  readonly minConfidence?: number;
  /** Visibilidad a partir de la cual un landmark empieza a contar. Por defecto 0.15. */
  readonly visLow?: number;
  /** Visibilidad a partir de la cual un landmark se considera fiable. Por defecto 0.45. */
  readonly visHigh?: number;
  /** Tiempo (ms) que se mantiene la última rotación buena antes de volver al reposo. Por defecto 400. */
  readonly holdMs?: number;
  /** Distancia por defecto a la cámara (m) si no se puede resolver. Por defecto 2.5. */
  readonly defaultDepthM?: number;
}

export interface PoseRetargeter {
  /** Procesa un fotograma; `null` si la confianza global es insuficiente. */
  update(frame: PoseFrame): SkeletonPose | null;
  /** Olvida la memoria temporal (última rotación buena, profundidad). */
  reset(): void;
}

// ---------------------------------------------------------------------------------------------
// Caché inmutable derivada del esqueleto de reposo
// ---------------------------------------------------------------------------------------------

interface RestCache {
  /** Dirección unitaria de reposo del hueso de cada joint (hacia su hijo principal o la punta). */
  readonly restDir: readonly Vec3[];
  /** Posiciones de reposo de los 33 landmarks. */
  readonly lm: readonly Vec3[];
  readonly offsets: readonly Vec3[];
  /** Distancia cadera-medio → hombro-medio en reposo (m). */
  readonly torsoLen: number;
  /** Eje de bisagra de reposo de los joints cuyo hijo es una bisagra (hombro→codo, cadera→rodilla). */
  readonly hingeAxis: readonly (Vec3 | null)[];
  /** Vector de reposo tobillo→punta del pie y muñeca→dedos (referencias del swing). */
  readonly footRef: readonly [Vec3, Vec3];
  readonly handRef: readonly [Vec3, Vec3];
  readonly pelvisFromHip: Vec3;
}

const MAIN_CHILD: readonly number[] = (() => {
  const c = new Array<number>(JOINT_COUNT).fill(-1);
  c[J.pelvis] = J.spine;
  c[J.spine] = J.chest;
  c[J.chest] = J.neck;
  c[J.neck] = J.head;
  c[J.l_clavicle] = J.l_upper_arm;
  c[J.l_upper_arm] = J.l_forearm;
  c[J.l_forearm] = J.l_hand;
  c[J.r_clavicle] = J.r_upper_arm;
  c[J.r_upper_arm] = J.r_forearm;
  c[J.r_forearm] = J.r_hand;
  c[J.l_thigh] = J.l_calf;
  c[J.l_calf] = J.l_foot;
  c[J.l_foot] = J.l_toes;
  c[J.r_thigh] = J.r_calf;
  c[J.r_calf] = J.r_foot;
  c[J.r_foot] = J.r_toes;
  return c;
})();

const cacheByRest = new WeakMap<RestSkeleton, RestCache>();

function getRestCache(rest: RestSkeleton): RestCache {
  const hit = cacheByRest.get(rest);
  if (hit) return hit;
  const restDir: Vec3[] = [];
  for (let j = 0; j < JOINT_COUNT; j++) {
    const c = MAIN_CHILD[j]!;
    restDir.push(
      c >= 0
        ? v3.normalize(rest.joints[c]!.localOffset, REST_BONE_DIRECTIONS[j]!)
        : REST_BONE_DIRECTIONS[j]!,
    );
  }
  const hingeAxis: (Vec3 | null)[] = [];
  for (let j = 0; j < JOINT_COUNT; j++) {
    const hingeRoot =
      j === J.l_upper_arm || j === J.r_upper_arm || j === J.l_thigh || j === J.r_thigh;
    hingeAxis.push(hingeRoot ? v3.normalize(v3.cross(restDir[j]!, AXIS_Z), AXIS_X) : null);
  }
  const lm = restLandmarks(rest);
  const hipMid = v3.lerp(lm[LM.l_hip]!, lm[LM.r_hip]!, 0.5);
  const shMid = v3.lerp(lm[LM.l_shoulder]!, lm[LM.r_shoulder]!, 0.5);
  const fingers = (side: 'l' | 'r'): Vec3 =>
    v3.lerp(
      lm[side === 'l' ? LM.l_index : LM.r_index]!,
      lm[side === 'l' ? LM.l_pinky : LM.r_pinky]!,
      0.5,
    );
  const hipRestMid = v3.lerp(
    rest.joints[J.l_thigh]!.position,
    rest.joints[J.r_thigh]!.position,
    0.5,
  );
  const cache: RestCache = {
    restDir,
    lm,
    offsets: rest.joints.map((jt) => jt.localOffset),
    torsoLen: v3.distance(hipMid, shMid),
    hingeAxis,
    footRef: [
      v3.normalize(v3.sub(lm[LM.l_foot_index]!, lm[LM.l_ankle]!), restDir[J.l_foot]!),
      v3.normalize(v3.sub(lm[LM.r_foot_index]!, lm[LM.r_ankle]!), restDir[J.r_foot]!),
    ],
    handRef: [
      v3.normalize(v3.sub(fingers('l'), lm[LM.l_wrist]!), restDir[J.l_hand]!),
      v3.normalize(v3.sub(fingers('r'), lm[LM.r_wrist]!), restDir[J.r_hand]!),
    ],
    pelvisFromHip: v3.sub(rest.joints[J.pelvis]!.position, hipRestMid),
  };
  cacheByRest.set(rest, cache);
  return cache;
}

// ---------------------------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------------------------

/** Landmarks de extremidades usados para la raíz y su joint del esqueleto (mismo orden). */
const ROOT_FIT_LANDMARKS = [
  LM.l_shoulder,
  LM.r_shoulder,
  LM.l_elbow,
  LM.r_elbow,
  LM.l_wrist,
  LM.r_wrist,
  LM.l_hip,
  LM.r_hip,
  LM.l_knee,
  LM.r_knee,
  LM.l_ankle,
  LM.r_ankle,
] as const;

/** Pares de landmarks cuya longitud se compara con la del esqueleto para estimar la escala. */
const SCALE_SEGMENTS: readonly (readonly [number, number])[] = [
  [LM.l_shoulder, LM.l_elbow],
  [LM.r_shoulder, LM.r_elbow],
  [LM.l_elbow, LM.l_wrist],
  [LM.r_elbow, LM.r_wrist],
  [LM.l_hip, LM.l_knee],
  [LM.r_hip, LM.r_knee],
  [LM.l_knee, LM.l_ankle],
  [LM.r_knee, LM.r_ankle],
  [LM.l_shoulder, LM.r_shoulder],
  [LM.l_hip, LM.r_hip],
];

/**
 * Escala avatar/landmarks: mediana ponderada de (longitud del hueso del esqueleto / longitud medida).
 * Los landmarks «world» de MediaPipe son métricos sólo de forma aproximada; esta razón los lleva a la
 * escala métrica del esqueleto (que sale de la estatura declarada) antes de resolver la profundidad.
 */
function estimateAvatarScale(
  P: readonly Vec3[],
  V: readonly number[],
  restLm: readonly Vec3[],
  wOf: (v: number) => number,
): number {
  const ratios: { r: number; w: number }[] = [];
  for (const [a, b] of SCALE_SEGMENTS) {
    const measured = v3.distance(P[a]!, P[b]!);
    const ref = v3.distance(restLm[a]!, restLm[b]!);
    const w = wOf(Math.min(V[a]!, V[b]!));
    if (w > 0.05 && measured > 0.04 && ref > 0.04) ratios.push({ r: ref / measured, w });
  }
  if (ratios.length === 0) return 1;
  ratios.sort((x, y) => x.r - y.r);
  const total = ratios.reduce((acc, e) => acc + e.w, 0);
  let acc = 0;
  for (const e of ratios) {
    acc += e.w;
    if (acc >= total / 2) return clamp(e.r, 0.5, 2);
  }
  return 1;
}

const MIN_SEGMENT = 1e-4;

/** Dirección unitaria de a→b o null si son (casi) coincidentes / no finitas. */
function dirBetween(a: Vec3, b: Vec3): Vec3 | null {
  const d = v3.sub(b, a);
  const l = v3.length(d);
  return l > MIN_SEGMENT && Number.isFinite(l) ? v3.scale(d, 1 / l) : null;
}

const TWIST_BEND_LO = degToRad(6);
const TWIST_BEND_HI = degToRad(20);

// ---------------------------------------------------------------------------------------------
// Retargeter con estado
// ---------------------------------------------------------------------------------------------

export function createPoseRetargeter(
  rest: RestSkeleton,
  cameraIn: CameraIntrinsics,
  opts: RetargetOptions = {},
): PoseRetargeter {
  const cache = getRestCache(rest);
  const camera = sanitizeCamera(cameraIn);
  const scales = cameraScales(camera);
  const minConfidence = opts.minConfidence ?? 0.2;
  const visLow = opts.visLow ?? 0.15;
  const visHigh = opts.visHigh ?? 0.45;
  const holdMs = opts.holdMs ?? 400;
  const defaultDepth = opts.defaultDepthM ?? 2.5;

  // Estado temporal
  const lastLocal: Quat[] = new Array<Quat>(JOINT_COUNT).fill(QUAT_IDENTITY);
  const lastTime: number[] = new Array<number>(JOINT_COUNT).fill(-Infinity);
  let lastRoot: Vec3 | null = null;
  let lastUp: Vec3 = AXIS_Y;

  const wOf = (v: number): number => sstep(visLow, visHigh, v);

  function update(frame: PoseFrame): SkeletonPose | null {
    // ---- 1. Lectura y saneado de landmarks ------------------------------------------------
    const P: Vec3[] = new Array<Vec3>(POSE_LANDMARK_COUNT);
    const V: number[] = new Array<number>(POSE_LANDMARK_COUNT);
    const world = frame.world;
    for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
      const lm = world?.[i];
      if (lm && Number.isFinite(lm.x) && Number.isFinite(lm.y) && Number.isFinite(lm.z)) {
        P[i] = [lm.x, lm.y, lm.z];
        V[i] = cleanVis(lm.visibility);
      } else {
        P[i] = [0, 0, 0];
        V[i] = 0;
      }
    }
    const t = Number.isFinite(frame.timestampMs) ? frame.timestampMs : 0;

    // Pares geométricamente degenerados (landmarks coincidentes) no sirven para fijar ejes
    const hipsSep = v3.distance(P[LM.l_hip]!, P[LM.r_hip]!);
    const shSep = v3.distance(P[LM.l_shoulder]!, P[LM.r_shoulder]!);
    const vHip = hipsSep > 0.03 ? Math.min(V[LM.l_hip]!, V[LM.r_hip]!) : 0;
    const vSh = shSep > 0.05 ? Math.min(V[LM.l_shoulder]!, V[LM.r_shoulder]!) : 0;
    const wHip = wOf(vHip);
    const wSh = wOf(vSh);
    if (wHip < 0.01 && wSh < 0.01) return null;

    // ---- 2. Marcos del tronco -----------------------------------------------------------------
    const hipMidRaw = v3.lerp(P[LM.l_hip]!, P[LM.r_hip]!, 0.5);
    const shMidRaw = v3.lerp(P[LM.l_shoulder]!, P[LM.r_shoulder]!, 0.5);
    let up: Vec3;
    let hipMid = hipMidRaw;
    let shMid = shMidRaw;
    if (wHip >= 0.01 && wSh >= 0.01) {
      const chord = dirBetween(hipMidRaw, shMidRaw) ?? lastUp;
      // con poca confianza en un extremo, la cuerda tiende a la vertical previa
      up = v3.normalize(v3.lerp(lastUp, chord, Math.min(wHip, wSh)), chord);
    } else {
      up = lastUp;
      if (wSh < 0.01) shMid = v3.add(hipMidRaw, v3.scale(up, cache.torsoLen));
      else hipMid = v3.sub(shMidRaw, v3.scale(up, cache.torsoLen));
    }
    lastUp = up;

    const xHip = wHip >= 0.01 ? v3.sub(P[LM.l_hip]!, P[LM.r_hip]!) : null;
    const xSh = wSh >= 0.01 ? v3.sub(P[LM.l_shoulder]!, P[LM.r_shoulder]!) : null;
    const fpRaw = frameFromXUp(xHip ?? xSh ?? AXIS_X, up);
    // tórax: eje Y = cuerda cadera→hombros; la inclinación de la línea de hombros la absorben las clavículas
    const fcRaw = frameFromYX(up, xSh ?? xHip ?? AXIS_X);
    // si falta un extremo, su marco sigue al otro
    const Fp = wHip >= 0.99 || !xSh ? fpRaw : q.slerp(fcRaw, fpRaw, wHip);
    const Fc = wSh >= 0.99 || !xHip ? fcRaw : q.slerp(fpRaw, fcRaw, wSh);

    // ---- 3. Pasada jerárquica -----------------------------------------------------------------
    const Rw: Quat[] = new Array<Quat>(JOINT_COUNT).fill(QUAT_IDENTITY);
    const Rl: Quat[] = new Array<Quat>(JOINT_COUNT).fill(QUAT_IDENTITY);
    const pos: Vec3[] = new Array<Vec3>(JOINT_COUNT).fill([0, 0, 0]);
    const conf: number[] = new Array<number>(JOINT_COUNT).fill(0);

    const fallbackFor = (j: number): Quat => {
      const age = Math.max(0, t - lastTime[j]!);
      if (age <= holdMs) return lastLocal[j]!;
      const k = sstep(holdMs, holdMs + 1500, age);
      return k >= 1 ? QUAT_IDENTITY : q.slerp(lastLocal[j]!, QUAT_IDENTITY, k);
    };

    /** Posición FK del joint `j` (requiere el padre ya colocado). */
    const locate = (j: number): void => {
      const parent = rest.joints[j]!.parent;
      if (parent >= 0) pos[j] = v3.add(pos[parent]!, q.rotate(Rw[parent]!, cache.offsets[j]!));
    };

    /** Coloca el joint `j` con rotación local medida `qMeas` y peso de confianza `wt`. */
    const place = (j: number, qMeas: Quat, wt: number): void => {
      const parent = rest.joints[j]!.parent;
      const limited = applyJointLimit(j, sanitizeQuat(qMeas), cache.restDir[j]!);
      const wc = clamp(wt, 0, 1);
      const blended = wc >= 0.999 ? limited : q.slerp(fallbackFor(j), limited, wc);
      const ql = sanitizeQuat(blended);
      Rl[j] = ql;
      conf[j] = wc;
      if (wc >= 0.6) {
        lastLocal[j] = ql;
        lastTime[j] = t;
      }
      if (parent < 0) {
        Rw[j] = ql;
      } else {
        Rw[j] = sanitizeQuat(q.multiply(Rw[parent]!, ql));
        locate(j);
      }
    };

    interface BoneOpts {
      /** Dirección de referencia del hueso en reposo si difiere de `restDir` (pie, mano). */
      readonly refDir?: Vec3;
      /** Dirección MUNDO del hueso hijo (bisagra) para alinear la torsión; `flexSign` de la bisagra. */
      readonly hingeChild?: { readonly dir: Vec3 | null; readonly flexSign: 1 | -1 };
    }

    /** Hueso del joint `j` apuntando de la posición `a` a la `b` (landmarks). */
    const bone = (j: number, a: Vec3, b: Vec3, wt: number, o: BoneOpts = {}): void => {
      const parent = rest.joints[j]!.parent;
      locate(j);
      const tWorld = wt > 0 ? dirBetween(a, b) : null;
      if (!tWorld || parent < 0) {
        place(j, QUAT_IDENTITY, 0);
        return;
      }
      const refDir = o.refDir ?? cache.restDir[j]!;
      const parentInv = q.conjugate(Rw[parent]!);
      const dLoc = v3.normalize(q.rotate(parentInv, tWorld), refDir);
      let qs = q.fromUnitVectors(refDir, dLoc);
      const h0 = cache.hingeAxis[j];
      if (o.hingeChild?.dir && h0) {
        // torsión: alinear el plano de la bisagra del hijo con el eje de reposo del hueso
        const axis = cache.restDir[j]!;
        const e = q.rotate(q.conjugate(qs), q.rotate(parentInv, o.hingeChild.dir));
        const bend = Math.acos(clamp(v3.dot(e, axis), -1, 1));
        const wb = sstep(TWIST_BEND_LO, TWIST_BEND_HI, bend);
        if (wb > 0) {
          const ePerp = v3.sub(e, v3.scale(axis, v3.dot(e, axis)));
          const tau = Math.atan2(v3.dot(ePerp, h0), v3.dot(v3.cross(axis, ePerp), h0));
          const alt = tau > 0 ? tau - Math.PI : tau + Math.PI;
          const flexOf = (ang: number): number =>
            v3.dot(q.rotate(q.fromAxisAngle(axis, -ang), e), AXIS_Z) * o.hingeChild!.flexSign;
          const best = flexOf(tau) >= flexOf(alt) ? tau : alt;
          qs = q.multiply(qs, q.fromAxisAngle(axis, wb * best));
        }
      }
      place(j, qs, wt);
    };

    // -- Pelvis (raíz) --
    const wPel = Math.max(wHip, 0.5 * wSh);
    place(J.pelvis, Fp, wPel);
    pos[J.pelvis] = v3.add(hipMid, q.rotate(Rw[J.pelvis]!, cache.pelvisFromHip));
    // -- Columna: spine = punto medio entre pelvis y tórax --
    const wSpine = Math.max(0.5 * (wHip + wSh), 0.3 * Math.max(wHip, wSh));
    locate(J.spine);
    place(J.spine, qRelative(Rw[J.pelvis]!, q.slerp(Rw[J.pelvis]!, Fc, 0.5)), wSpine);
    locate(J.chest);
    place(J.chest, qRelative(Rw[J.spine]!, Fc), wSh > 0.01 ? wSh : 0.5 * wHip);

    // -- Cuello / cabeza (marco TRIAD de orejas + nariz) --
    {
      const vNose = V[LM.nose]!;
      const vEars = Math.min(V[LM.l_ear]!, V[LM.r_ear]!);
      const earsOk = vEars > 0.35 && v3.distance(P[LM.l_ear]!, P[LM.r_ear]!) > 0.04;
      const wFace = wOf(Math.min(vNose, Math.max(vEars, 0.5 * vNose)));
      const refEarMid = v3.lerp(cache.lm[LM.l_ear]!, cache.lm[LM.r_ear]!, 0.5);
      const refFwd = v3.sub(cache.lm[LM.nose]!, refEarMid);
      const refX = v3.sub(cache.lm[LM.l_ear]!, cache.lm[LM.r_ear]!);
      const Mrest = frameFromZX(refFwd, refX);
      let Rhead: Quat = Rw[J.chest]!;
      if (wFace > 0.01) {
        let fwd: Vec3;
        let xHint: Vec3;
        if (earsOk) {
          fwd = v3.sub(P[LM.nose]!, v3.lerp(P[LM.l_ear]!, P[LM.r_ear]!, 0.5));
          xHint = v3.sub(P[LM.l_ear]!, P[LM.r_ear]!);
        } else {
          // sin ambas orejas: centro esperado de la cabeza desde los hombros y el marco del tórax
          const shRest = v3.lerp(cache.lm[LM.l_shoulder]!, cache.lm[LM.r_shoulder]!, 0.5);
          fwd = v3.sub(P[LM.nose]!, v3.add(shMid, q.rotate(Fc, v3.sub(refEarMid, shRest))));
          xHint = q.rotate(Fc, AXIS_X);
        }
        if (v3.length(fwd) > 0.02) {
          const Mmeas = frameFromZX(fwd, xHint, q.rotate(Fc, AXIS_X));
          Rhead = sanitizeQuat(q.multiply(Mmeas, q.conjugate(Mrest)));
        }
      }
      locate(J.neck);
      place(J.neck, qRelative(Rw[J.chest]!, q.slerp(Rw[J.chest]!, Rhead, 0.5)), wFace);
      locate(J.head);
      place(J.head, qRelative(Rw[J.neck]!, Rhead), wFace);
    }

    // -- Brazos --
    const sides = [
      {
        k: 0,
        cl: J.l_clavicle,
        ua: J.l_upper_arm,
        fa: J.l_forearm,
        hd: J.l_hand,
        sh: LM.l_shoulder,
        el: LM.l_elbow,
        wr: LM.l_wrist,
        idx: LM.l_index,
        pk: LM.l_pinky,
        hip: LM.l_hip,
        kn: LM.l_knee,
        an: LM.l_ankle,
        ft: LM.l_foot_index,
        th: J.l_thigh,
        ca: J.l_calf,
        fo: J.l_foot,
        to: J.l_toes,
      },
      {
        k: 1,
        cl: J.r_clavicle,
        ua: J.r_upper_arm,
        fa: J.r_forearm,
        hd: J.r_hand,
        sh: LM.r_shoulder,
        el: LM.r_elbow,
        wr: LM.r_wrist,
        idx: LM.r_index,
        pk: LM.r_pinky,
        hip: LM.r_hip,
        kn: LM.r_knee,
        an: LM.r_ankle,
        ft: LM.r_foot_index,
        th: J.r_thigh,
        ca: J.r_calf,
        fo: J.r_foot,
        to: J.r_toes,
      },
    ] as const;

    for (const s of sides) {
      const wS = wOf(V[s.sh]!);
      const wE = wOf(V[s.el]!);
      const wW = wOf(V[s.wr]!);
      // clavícula: apunta, desde su posición FK, al landmark del hombro
      locate(s.cl);
      bone(s.cl, pos[s.cl]!, P[s.sh]!, wS);
      bone(s.ua, P[s.sh]!, P[s.el]!, Math.min(wS, wE), {
        hingeChild: { dir: dirBetween(P[s.el]!, P[s.wr]!), flexSign: 1 },
      });
      bone(s.fa, P[s.el]!, P[s.wr]!, Math.min(wE, wW));
      // mano: muñeca → centro de índice/meñique
      const wF = Math.min(wW, wOf(Math.min(V[s.idx]!, V[s.pk]!)));
      const fingersMid = v3.lerp(P[s.idx]!, P[s.pk]!, 0.5);
      bone(s.hd, P[s.wr]!, fingersMid, wF * 0.9, { refDir: cache.handRef[s.k]! });
    }

    // -- Piernas --
    for (const s of sides) {
      const wH = wOf(V[s.hip]!);
      const wK = wOf(V[s.kn]!);
      const wA = wOf(V[s.an]!);
      bone(s.th, P[s.hip]!, P[s.kn]!, Math.min(wH, wK), {
        hingeChild: { dir: dirBetween(P[s.kn]!, P[s.an]!), flexSign: -1 },
      });
      bone(s.ca, P[s.kn]!, P[s.an]!, Math.min(wK, wA));
      const wT = Math.min(wA, wOf(V[s.ft]!));
      bone(s.fo, P[s.an]!, P[s.ft]!, wT, { refDir: cache.footRef[s.k]! });
      locate(s.to);
      place(s.to, QUAT_IDENTITY, 0.5 * wT);
    }

    // ---- 4. Raíz: mínimos cuadrados con rayos pinhole -----------------------------------------
    const image = frame.image;
    let sw = 0;
    let rx = 0;
    let ry = 0;
    let rz = 0;
    let solved = false;
    const avatarScale = estimateAvatarScale(P, V, cache.lm, wOf);
    {
      const n = ROOT_FIT_LANDMARKS.length;
      const ex = new Array<number>(n).fill(0);
      const ey = new Array<number>(n).fill(0);
      const b1 = new Array<number>(n).fill(0);
      const b2 = new Array<number>(n).fill(0);
      const wk = new Array<number>(n).fill(0);
      for (let k = 0; k < n; k++) {
        const lmIdx = ROOT_FIT_LANDMARKS[k]!;
        const im = image?.[lmIdx];
        if (!im || !Number.isFinite(im.x) || !Number.isFinite(im.y)) continue;
        const wv = wOf(V[lmIdx]!);
        if (wv <= 0) continue;
        const [rex, rey] = rayFromNormalized(im.x, im.y, scales);
        // desplazamiento desde el centro de caderas, a la escala métrica del esqueleto
        const O = v3.scale(v3.sub(P[lmIdx]!, hipMid), avatarScale);
        ex[k] = rex;
        ey[k] = rey;
        b1[k] = -O[0] - O[2] * rex;
        b2[k] = -O[1] - O[2] * rey;
        wk[k] = wv;
        sw += wv;
      }
      if (sw >= 1.2) {
        const w2 = wk.slice();
        for (let iter = 0; iter < 3; iter++) {
          let a00 = 0,
            a02 = 0,
            a12 = 0,
            a22 = 0,
            c0 = 0,
            c1 = 0,
            c2 = 0,
            s = 0;
          for (let k = 0; k < n; k++) {
            const wv = w2[k]!;
            if (wv <= 0) continue;
            s += wv;
            a00 += wv;
            a02 += wv * ex[k]!;
            a12 += wv * ey[k]!;
            a22 += wv * (ex[k]! * ex[k]! + ey[k]! * ey[k]!);
            c0 += wv * b1[k]!;
            c1 += wv * b2[k]!;
            c2 += wv * (ex[k]! * b1[k]! + ey[k]! * b2[k]!);
          }
          // Sistema simétrico [[a00,0,a02],[0,a00,a12],[a02,a12,a22]]·(x,y,z) = (c0,c1,c2).
          // Eliminando x e y: z·(a22 − (a02²+a12²)/a00) = c2 − (a02·c0 + a12·c1)/a00
          const denom = a22 - (a02 * a02 + a12 * a12) / a00;
          if (!(denom > 1e-9 * s)) break;
          const zSol = (c2 - (a02 * c0 + a12 * c1) / a00) / denom;
          const xSol = (c0 - a02 * zSol) / a00;
          const ySol = (c1 - a12 * zSol) / a00;
          if (!Number.isFinite(zSol) || !Number.isFinite(xSol) || !Number.isFinite(ySol)) break;
          rx = xSol;
          ry = ySol;
          rz = zSol;
          solved = true;
          // reponderación (Huber en metros)
          for (let k = 0; k < n; k++) {
            if (wk[k]! <= 0) continue;
            const r = Math.hypot(rx + ex[k]! * rz - b1[k]!, ry + ey[k]! * rz - b2[k]!);
            w2[k] = r > 0.08 ? (wk[k]! * 0.08) / r : wk[k]!;
          }
        }
      }
    }
    let root: Vec3;
    if (solved && rz < -0.15 && rz > -40) {
      // (rx, ry, rz) = centro de caderas en espacio cámara ⇒ pelvis = centro + R_pelvis·(0, 0.02H, 0)
      root = v3.add([rx, ry, rz], q.rotate(Rw[J.pelvis]!, cache.pelvisFromHip));
    } else if (lastRoot) {
      root = lastRoot;
    } else {
      // sin información de imagen: coloca el centro de las caderas en el eje óptico
      root = [0, 0, -defaultDepth];
    }
    if (!v3.isFinite(root)) root = [0, 0, -defaultDepth];
    lastRoot = root;

    // ---- 5. Confianzas -------------------------------------------------------------------------
    let limbSum = 0;
    for (const lmIdx of ROOT_FIT_LANDMARKS) limbSum += wOf(V[lmIdx]!);
    const limbMean = limbSum / ROOT_FIT_LANDMARKS.length;
    const torso = 0.5 * (wHip + wSh);
    const confidence = clamp(0.4 * torso + 0.6 * limbMean, 0, 1);
    if (confidence < minConfidence) return null;

    return {
      timestampMs: t,
      rootPosition: root,
      rotations: Rl,
      confidence,
      jointConfidence: conf,
    };
  }

  return {
    update,
    reset(): void {
      lastLocal.fill(QUAT_IDENTITY);
      lastTime.fill(-Infinity);
      lastRoot = null;
      lastUp = AXIS_Y;
    },
  };
}

/** Retargeting sin estado (cada llamada parte del reposo). Firma del contrato `PoseToSkeleton`. */
export const poseToSkeleton: PoseToSkeleton = (frame, rest, camera) =>
  createPoseRetargeter(rest, camera).update(frame);
