import {
  J,
  LM,
  POSE_LANDMARK_COUNT,
  QUAT_IDENTITY,
  clamp,
  forwardKinematics,
  lerp,
  q,
  restPose,
  smoothstep,
  v3,
  type CameraIntrinsics,
  type ImageLandmark,
  type Measurements,
  type PoseFrame,
  type PoseProvider,
  type Quat,
  type RestSkeleton,
  type SegmentationMask,
  type SkeletonPose,
  type Vec3,
  type WorldLandmark,
  buildRestSkeleton,
} from '@fitroom/shared';
import { cameraScales, projectToNormalized, sanitizeCamera, DEFAULT_CAMERA } from './camera.js';
import { AXIS_Y, gaussian, hash32, mulberry32, sstep } from './geom.js';
import { SHOULDER_INSET_M } from './calibration.js';
import {
  ALL_POSE_NAMES,
  blendPoseStates,
  evalPose,
  type AnyPoseName,
  type PoseState,
  type SyntheticPoseName,
} from './poses.js';
import { LM_JOINT, LM_OFFSETS, defaultMeasurementsForHeight } from './rig.js';
import { renderCapsuleMask } from './silhouette.js';

export type { SyntheticPoseName, ExtendedPoseName, AnyPoseName } from './poses.js';

// ---------------------------------------------------------------------------------------------
// Opciones
// ---------------------------------------------------------------------------------------------

export interface TimeWindow {
  /** ms desde el inicio del guion */
  readonly fromMs: number;
  readonly toMs: number;
}

export type OcclusionGroup =
  'left-arm' | 'right-arm' | 'arms' | 'left-leg' | 'right-leg' | 'legs' | 'lower-body' | 'face';

const GROUPS: Record<OcclusionGroup, readonly number[]> = {
  'left-arm': [LM.l_elbow, LM.l_wrist, LM.l_pinky, LM.l_index, LM.l_thumb],
  'right-arm': [LM.r_elbow, LM.r_wrist, LM.r_pinky, LM.r_index, LM.r_thumb],
  arms: [
    LM.l_elbow,
    LM.r_elbow,
    LM.l_wrist,
    LM.r_wrist,
    LM.l_pinky,
    LM.r_pinky,
    LM.l_index,
    LM.r_index,
    LM.l_thumb,
    LM.r_thumb,
  ],
  'left-leg': [LM.l_knee, LM.l_ankle, LM.l_heel, LM.l_foot_index],
  'right-leg': [LM.r_knee, LM.r_ankle, LM.r_heel, LM.r_foot_index],
  legs: [
    LM.l_knee,
    LM.r_knee,
    LM.l_ankle,
    LM.r_ankle,
    LM.l_heel,
    LM.r_heel,
    LM.l_foot_index,
    LM.r_foot_index,
  ],
  'lower-body': [
    LM.l_hip,
    LM.r_hip,
    LM.l_knee,
    LM.r_knee,
    LM.l_ankle,
    LM.r_ankle,
    LM.l_heel,
    LM.r_heel,
    LM.l_foot_index,
    LM.r_foot_index,
  ],
  face: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
};

export interface SyntheticFaults {
  /** Fracción [0,1] de fotogramas sin detección (determinista por marca de tiempo). */
  readonly dropoutRate?: number;
  /** Ventanas sin detección (devuelve `null`). */
  readonly dropouts?: readonly TimeWindow[];
  /** Oclusiones: visibilidad baja de ciertos landmarks durante una ventana. */
  readonly occlusions?: readonly (TimeWindow & {
    readonly landmarks: readonly number[] | OcclusionGroup;
    /** visibilidad resultante (por defecto 0.05) */
    readonly visibility?: number;
  })[];
  /** Personas adicionales en cuadro (`personCount = 1 + count`). */
  readonly extraPeople?: readonly (TimeWindow & { readonly count: number })[];
  /** La persona sale de cuadro por un lado y vuelve (pico a mitad de ventana). */
  readonly walkOuts?: readonly (TimeWindow & { readonly side: 'left' | 'right' })[];
  /** Saltos bruscos de posición (p. ej. 5 m entre fotogramas). */
  readonly teleports?: readonly {
    readonly atMs: number;
    readonly dxM: number;
    readonly dyM?: number;
    readonly dzM: number;
    /** duración del desplazamiento (ms); por defecto 1 fotograma ≈ 33 ms */
    readonly durationMs?: number;
  }[];
}

export interface SyntheticPoseOptions {
  readonly heightCm: number;
  readonly script: readonly { readonly pose: AnyPoseName; readonly durationMs: number }[];
  readonly seed?: number;
  /** Medidas completas (si no, `defaultMeasurementsForHeight`). */
  readonly measurements?: Measurements;
  /** Esqueleto de reposo explícito (tiene prioridad sobre `measurements`). */
  readonly rest?: RestSkeleton;
  readonly camera?: CameraIntrinsics;
  readonly imageSize?: { readonly width: number; readonly height: number };
  /** Distancia de la pelvis a la cámara (m). Por defecto: la persona ocupa ≈ 66 % del alto. */
  readonly distanceM?: number;
  /** Altura de la cámara sobre el suelo (m). Por defecto 0.52·H (persona centrada). */
  readonly cameraHeightM?: number;
  /** σ del ruido gaussiano de landmarks (m). Por defecto 0. */
  readonly noiseSigmaM?: number;
  /** Giro base del cuerpo (grados): 0 = de frente, 180 = de espaldas. */
  readonly baseYawDeg?: number;
  /** `mediapipe-like`: los hombros del detector quedan `SHOULDER_INSET_M` por dentro de la articulación. */
  readonly landmarkBias?: 'none' | 'mediapipe-like';
  /** Fundido entre tramos del guion (ms). Por defecto 250. */
  readonly transitionMs?: number;
  /** Qué hacer pasado el final del guion. Por defecto `hold`. */
  readonly endBehavior?: 'hold' | 'loop' | 'none';
  /** El guion empieza en la primera llamada a `detect` en lugar de en t = 0. */
  readonly startAtFirstDetect?: boolean;
  readonly faults?: SyntheticFaults;
  /** Genera máscara de segmentación sintética (siluetas de cápsulas). */
  readonly mask?: boolean | { readonly width: number; readonly height?: number };
}

export interface SyntheticPoseProvider extends PoseProvider {
  readonly rest: RestSkeleton;
  readonly measurements: Measurements;
  readonly camera: CameraIntrinsics;
  readonly imageSize: { readonly width: number; readonly height: number };
  readonly distanceM: number;
  readonly cameraHeightM: number;
  /** Duración total del guion (ms). */
  readonly durationMs: number;
  /** Fotograma sintético en el instante `tMs` del guion (función pura; no usa el reloj). */
  frameAt(tMs: number): PoseFrame | null;
  /** Verdad de terreno (esqueleto exacto, sin ruido ni sesgo) en el instante `tMs`. */
  groundTruth(tMs: number): SkeletonPose;
}

// ---------------------------------------------------------------------------------------------
// Síntesis de landmarks a partir de un esqueleto
// ---------------------------------------------------------------------------------------------

export interface SynthesisOptions {
  readonly camera: CameraIntrinsics;
  readonly imageSize: { readonly width: number; readonly height: number };
  /** σ de ruido (m) en world; en imagen se proyecta a la profundidad de cada landmark. */
  readonly noiseSigmaM?: number;
  readonly seed?: number;
  /** Clave de fotograma para el ruido (p. ej. la marca de tiempo entera). */
  readonly frameKey?: number;
  readonly landmarkBias?: 'none' | 'mediapipe-like';
  /** visibilidad máxima por landmark (oclusiones forzadas) */
  readonly visibilityCap?: ReadonlyMap<number, number>;
  readonly personCount?: number;
  readonly mask?: SegmentationMask;
}

/** Posiciones mundo (espacio cámara) de los 33 landmarks de un esqueleto en una pose. */
export function landmarkPositions(
  rest: RestSkeleton,
  pose: SkeletonPose,
  bias: 'none' | 'mediapipe-like' = 'none',
): { pos: Vec3[]; fkRot: Quat[]; fkPos: Vec3[] } {
  const fk = forwardKinematics(rest, pose);
  const pos: Vec3[] = [];
  for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
    const jt = LM_JOINT[i];
    if (jt !== undefined) {
      pos.push(fk.positions[jt]!);
      continue;
    }
    const o = LM_OFFSETS[i];
    if (o) {
      pos.push(
        v3.add(
          fk.positions[o.joint]!,
          q.rotate(fk.rotations[o.joint]!, v3.scale(o.offset, rest.height)),
        ),
      );
    } else pos.push(fk.positions[J.pelvis]!);
  }
  if (bias === 'mediapipe-like') {
    // el detector coloca el hombro hacia dentro, a lo largo del eje lateral del tórax
    const lat = q.rotate(fk.rotations[J.chest]!, [1, 0, 0]);
    pos[LM.l_shoulder] = v3.sub(pos[LM.l_shoulder]!, v3.scale(lat, SHOULDER_INSET_M));
    pos[LM.r_shoulder] = v3.add(pos[LM.r_shoulder]!, v3.scale(lat, SHOULDER_INSET_M));
  }
  return { pos, fkRot: fk.rotations, fkPos: fk.positions };
}

/** Modelo de visibilidad (oclusión propia + fuera de cuadro) para los 33 landmarks. */
function baseVisibility(
  fkRot: readonly Quat[],
  imgPos: readonly { x: number; y: number }[],
): number[] {
  const vis = new Array<number>(POSE_LANDMARK_COUNT).fill(0.99);
  // cara: visible si la cabeza mira hacia la cámara (+Z)
  const headFwd = q.rotate(fkRot[J.head]!, [0, 0, 1]);
  const face = 0.05 + 0.94 * sstep(-0.15, 0.35, headFwd[2]);
  for (const i of [0, 1, 2, 3, 4, 5, 6, 9, 10]) vis[i] = face;
  const lx = q.rotate(fkRot[J.head]!, [1, 0, 0]);
  vis[LM.l_ear] = 0.15 + 0.8 * sstep(-0.5, 0.2, lx[2]);
  vis[LM.r_ear] = 0.15 + 0.8 * sstep(-0.5, 0.2, -lx[2]);
  // lado lejano del cuerpo ocluido por el torso al girar
  const lat = q.rotate(fkRot[J.pelvis]!, [1, 0, 0]);
  const far = sstep(0.55, 0.95, Math.abs(lat[2]));
  const farFactor = lerp(1, 0.5, far);
  const farSide = lat[2] > 0 ? 'r' : 'l';
  const sideLm =
    farSide === 'l'
      ? [
          LM.l_shoulder,
          LM.l_elbow,
          LM.l_wrist,
          LM.l_hip,
          LM.l_knee,
          LM.l_ankle,
          LM.l_heel,
          LM.l_foot_index,
          LM.l_pinky,
          LM.l_index,
          LM.l_thumb,
        ]
      : [
          LM.r_shoulder,
          LM.r_elbow,
          LM.r_wrist,
          LM.r_hip,
          LM.r_knee,
          LM.r_ankle,
          LM.r_heel,
          LM.r_foot_index,
          LM.r_pinky,
          LM.r_index,
          LM.r_thumb,
        ];
  for (const i of sideLm) vis[i] = vis[i]! * farFactor;
  // fuera de cuadro
  for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
    const p = imgPos[i]!;
    const out = Math.max(-p.x, p.x - 1, -p.y, p.y - 1, 0);
    vis[i] = vis[i]! * (1 - 0.97 * sstep(0, 0.03, out));
  }
  return vis;
}

/**
 * Convierte un esqueleto en un `PoseFrame` realista: landmarks en imagen (proyección pinhole) y world
 * (centrados en las caderas, convención del proyecto), visibilidades y ruido gaussiano con semilla.
 * Pura y determinista: depende sólo de sus argumentos.
 */
export function synthesizeFrame(
  rest: RestSkeleton,
  pose: SkeletonPose,
  timestampMs: number,
  o: SynthesisOptions,
): PoseFrame {
  const camera = sanitizeCamera(o.camera);
  const scales = cameraScales(camera);
  const { pos, fkRot } = landmarkPositions(rest, pose, o.landmarkBias ?? 'none');
  const hipMid = v3.lerp(pos[LM.l_hip]!, pos[LM.r_hip]!, 0.5);
  const sigma = o.noiseSigmaM ?? 0;
  const rand = mulberry32(hash32(o.seed ?? 1, o.frameKey ?? Math.round(timestampMs)));
  const noise = (): number => (sigma > 0 ? gaussian(rand) * sigma : 0);

  // profundidad de referencia (cadera) para escalar z de imagen
  const hipProj = projectToNormalized(hipMid, scales);
  const imgScale = 1 / (2 * scales.tanX * hipProj.depth);

  // proyección sin ruido para la visibilidad
  const clean = pos.map((p) => projectToNormalized(p, scales));
  const vis = baseVisibility(fkRot, clean);
  if (o.visibilityCap) {
    for (const [i, cap] of o.visibilityCap) vis[i] = Math.min(vis[i]!, cap);
  }

  const image: ImageLandmark[] = [];
  const world: WorldLandmark[] = [];
  for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
    const p = pos[i]!;
    const w = v3.sub(p, hipMid);
    // ruido de imagen: se añade a la posición 3D antes de proyectar (consistente con σ en m)
    const pn: Vec3 = sigma > 0 ? [p[0] + noise(), p[1] + noise(), p[2] + noise()] : p;
    const pr = projectToNormalized(pn, scales);
    image.push({
      x: pr.x,
      y: pr.y,
      z: -w[2] * imgScale + (sigma > 0 ? noise() * imgScale : 0),
      visibility: vis[i]!,
    });
    world.push({
      x: w[0] + noise(),
      y: w[1] + noise(),
      z: w[2] + noise(),
      visibility: vis[i]!,
    });
  }
  return {
    timestampMs,
    imageSize: o.imageSize,
    image,
    world,
    ...(o.mask ? { mask: o.mask } : {}),
    personCount: o.personCount ?? 1,
  };
}

export interface PlacementOptions {
  /** Distancia de la pelvis a la cámara (m). */
  readonly distanceM: number;
  /** Altura de la cámara sobre el suelo (m). */
  readonly cameraHeightM: number;
  readonly baseYawRad?: number;
  /** Desplazamiento extra [x, y, z] (m) en espacio cámara. */
  readonly offset?: Vec3;
  readonly timestampMs?: number;
}

/**
 * Coloca un `PoseState` en espacio cámara: giro base + giro propio de la pelvis, distancia a la
 * cámara y apoyo en el suelo (el punto más bajo de talones/puntas queda a y = −alturaCámara).
 */
export function skeletonFromState(
  rest: RestSkeleton,
  st: PoseState,
  o: PlacementOptions,
): SkeletonPose {
  const off = o.offset ?? [0, 0, 0];
  const rot = st.rot.slice();
  rot[J.pelvis] = q.normalize(
    q.multiply(
      q.fromAxisAngle(AXIS_Y, (o.baseYawRad ?? 0) + st.yaw),
      rot[J.pelvis] ?? QUAT_IDENTITY,
    ),
  );
  const probe: SkeletonPose = {
    ...restPose(rest, o.timestampMs ?? 0),
    rootPosition: [st.dx + off[0], 0, -o.distanceM + st.dz + off[2]],
    rotations: rot,
  };
  const { pos } = landmarkPositions(rest, probe, 'none');
  const contact = Math.min(
    pos[LM.l_heel]![1],
    pos[LM.r_heel]![1],
    pos[LM.l_foot_index]![1],
    pos[LM.r_foot_index]![1],
  );
  const rootY = -o.cameraHeightM - contact + off[1];
  return { ...probe, rootPosition: [probe.rootPosition[0], rootY, probe.rootPosition[2]] };
}

// ---------------------------------------------------------------------------------------------
// Proveedor sintético por guiones
// ---------------------------------------------------------------------------------------------

const inWindow = (t: number, w: TimeWindow): boolean => t >= w.fromMs && t < w.toMs;

/**
 * Guion determinista de poses para tests / e2e sin cámara.
 * Misma `seed` + mismos argumentos ⇒ exactamente los mismos fotogramas (el ruido depende sólo de la
 * semilla y de la marca de tiempo, no del orden de las llamadas).
 */
export function createSyntheticPoseProvider(opts: SyntheticPoseOptions): SyntheticPoseProvider {
  for (const s of opts.script) {
    if (!ALL_POSE_NAMES.includes(s.pose))
      throw new RangeError(`pose sintética desconocida: ${s.pose}`);
    if (!(s.durationMs > 0) || !Number.isFinite(s.durationMs)) {
      throw new RangeError('durationMs debe ser > 0 y finito');
    }
  }
  const measurements = opts.measurements ?? defaultMeasurementsForHeight(opts.heightCm);
  const rest = opts.rest ?? buildRestSkeleton(measurements);
  const camera = sanitizeCamera(opts.camera ?? DEFAULT_CAMERA);
  const scales = cameraScales(camera);
  const imageSize = opts.imageSize ?? {
    width: Math.round(720 * camera.aspect),
    height: 720,
  };
  const H = rest.height;
  const distanceM = opts.distanceM ?? H / (0.66 * 2 * scales.tanY);
  const cameraHeightM = opts.cameraHeightM ?? 0.52 * H;
  const transitionMs = opts.transitionMs ?? 250;
  const endBehavior = opts.endBehavior ?? 'hold';
  const baseYaw = ((opts.baseYawDeg ?? 0) * Math.PI) / 180;
  const faults = opts.faults ?? {};
  const seed = opts.seed ?? 1;
  const bias = opts.landmarkBias ?? 'none';
  const maskOpt = opts.mask;

  const starts: number[] = [];
  let total = 0;
  for (const s of opts.script) {
    starts.push(total);
    total += s.durationMs;
  }
  const durationMs = total;
  let disposed = false;
  let t0: number | null = null;

  /** Estado de pose combinando el tramo activo y el fundido desde el anterior. */
  function stateAt(tIn: number): PoseState {
    if (opts.script.length === 0) return evalPose('a-pose', 0, 1);
    let t = tIn;
    if (t >= durationMs) {
      if (endBehavior === 'loop') t = t % durationMs;
      else t = durationMs - 1e-6;
    }
    if (t < 0) t = 0;
    let idx = opts.script.length - 1;
    for (let i = 0; i < starts.length; i++) {
      if (t >= starts[i]! && (i === starts.length - 1 || t < starts[i + 1]!)) {
        idx = i;
        break;
      }
    }
    const seg = opts.script[idx]!;
    const local = t - starts[idx]!;
    // el estado se evalúa con el tiempo del guion para que la marcha mantenga la fase al encadenar
    let st = evalPose(seg.pose, local, seg.durationMs);
    if (idx > 0 && local < transitionMs && transitionMs > 0) {
      const prev = opts.script[idx - 1]!;
      const prevSt = evalPose(prev.pose, prev.durationMs + local, prev.durationMs);
      st = blendPoseStates(prevSt, st, smoothstep(0, transitionMs, local));
    }
    return st;
  }

  /** Desplazamiento por fallos (salidas de cuadro, saltos). */
  function faultOffset(t: number): Vec3 {
    let ox = 0;
    let oy = 0;
    let oz = 0;
    for (const w of faults.walkOuts ?? []) {
      if (!inWindow(t, w)) continue;
      const k = Math.sin((Math.PI * (t - w.fromMs)) / (w.toMs - w.fromMs));
      const half = distanceM * scales.tanX;
      ox += (w.side === 'left' ? -1 : 1) * (half + 1.1) * k * k;
    }
    for (const tp of faults.teleports ?? []) {
      const dur = tp.durationMs ?? 33;
      if (t >= tp.atMs && t < tp.atMs + dur) {
        ox += tp.dxM;
        oy += tp.dyM ?? 0;
        oz += tp.dzM;
      }
    }
    return [ox, oy, oz];
  }

  function skeletonAt(t: number, withFaults: boolean): { pose: SkeletonPose; state: PoseState } {
    const st = stateAt(t);
    const off: Vec3 = withFaults ? faultOffset(t) : [0, 0, 0];
    return {
      pose: skeletonFromState(rest, st, {
        distanceM,
        cameraHeightM,
        baseYawRad: baseYaw,
        offset: off,
        timestampMs: t,
      }),
      state: st,
    };
  }

  function frameAt(tIn: number): PoseFrame | null {
    if (!Number.isFinite(tIn)) return null;
    const t = tIn;
    if (endBehavior === 'none' && t >= durationMs) return null;
    for (const w of faults.dropouts ?? []) if (inWindow(t, w)) return null;
    const key = Math.round(t);
    if ((faults.dropoutRate ?? 0) > 0) {
      const r = hash32(seed ^ 0x51ed, key) / 4294967296;
      if (r < clamp(faults.dropoutRate ?? 0, 0, 1)) return null;
    }
    const { pose, state } = skeletonAt(t, true);
    // oclusiones forzadas
    let cap: Map<number, number> | undefined;
    for (const oc of faults.occlusions ?? []) {
      if (!inWindow(t, oc)) continue;
      cap ??= new Map();
      const lms = typeof oc.landmarks === 'string' ? GROUPS[oc.landmarks] : oc.landmarks;
      for (const i of lms) cap.set(i, Math.min(cap.get(i) ?? 1, oc.visibility ?? 0.05));
    }
    let personCount = 1;
    for (const ep of faults.extraPeople ?? []) if (inWindow(t, ep)) personCount += ep.count;

    const frame0 = synthesizeFrame(rest, pose, t, {
      camera,
      imageSize,
      noiseSigmaM: Math.hypot(opts.noiseSigmaM ?? 0, state.extraNoiseM),
      seed,
      frameKey: key,
      landmarkBias: bias,
      ...(cap ? { visibilityCap: cap } : {}),
      personCount,
    });
    // sin persona si casi todo queda fuera de cuadro
    let inside = 0;
    for (const lmk of frame0.image) {
      if (lmk.x >= 0 && lmk.x <= 1 && lmk.y >= 0 && lmk.y <= 1) inside++;
    }
    if (inside < 4) return null;
    if (!maskOpt) return frame0;
    const mw = typeof maskOpt === 'object' ? maskOpt.width : 192;
    const mh =
      typeof maskOpt === 'object' && maskOpt.height
        ? maskOpt.height
        : Math.round(mw / camera.aspect);
    const { fkPos, fkRot } = landmarkPositions(rest, pose, 'none');
    const mask = renderCapsuleMask({
      rest,
      measurements,
      fkPositions: fkPos,
      fkRotations: fkRot,
      camera,
      width: mw,
      height: mh,
    });
    return { ...frame0, mask };
  }

  return {
    name: 'synthetic',
    rest,
    measurements,
    camera,
    imageSize,
    distanceM,
    cameraHeightM,
    durationMs,
    init: () => Promise.resolve(),
    detect(_source, timestampMs) {
      if (disposed) return null;
      if (!Number.isFinite(timestampMs)) return null;
      let t = timestampMs;
      if (opts.startAtFirstDetect) {
        t0 ??= timestampMs;
        t = timestampMs - t0;
      }
      const f = frameAt(t);
      return f ? { ...f, timestampMs } : null;
    },
    dispose() {
      disposed = true;
    },
    frameAt,
    groundTruth: (t) => skeletonAt(t, false).pose,
  };
}
