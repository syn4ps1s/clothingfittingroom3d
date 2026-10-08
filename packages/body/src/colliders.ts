import { J, type BodyModel, type CapsuleCollider, type Vec3, type WorldCapsule } from '@fitroom/shared';
import { BodyInputError } from './errors.js';

/** Definición de un colisionador: eje en espacio de reposo (anclado a dos joints) y huesos cuyos vértices lo ajustan. */
interface ColliderDef {
  readonly name: string;
  readonly jointA: number;
  readonly jointB: number;
  /** extremos del eje en espacio de reposo (m); se convierten a offsets respecto a sus joints */
  readonly a: Vec3;
  readonly b: Vec3;
  /** joints cuyos vértices dominantes definen la piel de esta cápsula */
  readonly bones: readonly number[];
  /** rango de proyección a lo largo del eje admitido (para descartar los extremos con otros segmentos) */
  readonly tMin: number;
  readonly tMax: number;
  /** distancia máxima eje-vértice considerada */
  readonly maxDist: number;
}

const add = (a: Vec3, b: Vec3, s = 1): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

/** Definiciones de los colisionadores del cuerpo (los de un lado se espejan). */
function colliderDefs(P: readonly Vec3[], H: number, handLen: number, dirH: (side: 1 | -1) => Vec3) {
  const defs: ColliderDef[] = [];
  const mid = (a: Vec3, b: Vec3, t: number): Vec3 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  defs.push({
    name: 'head',
    jointA: J.head,
    jointB: J.head,
    a: add(P[J.head]!, [0, 0.055 * H, 0.006 * H]),
    b: add(P[J.head]!, [0, 0.095 * H, 0.006 * H]),
    bones: [J.head],
    tMin: -1,
    tMax: 2,
    maxDist: 0.2,
  });
  defs.push({
    name: 'neck',
    jointA: J.neck,
    jointB: J.head,
    a: add(P[J.neck]!, [0, -0.01 * H, 0]),
    b: add(P[J.head]!, [0, 0.0, 0]),
    bones: [J.neck],
    tMin: 0.1,
    tMax: 0.9,
    maxDist: 0.12,
  });
  defs.push({
    name: 'chest',
    jointA: J.spine,
    jointB: J.neck,
    a: P[J.spine]!,
    b: add(P[J.neck]!, [0, -0.03 * H, 0]),
    bones: [J.spine, J.chest],
    tMin: 0.1,
    tMax: 0.95,
    maxDist: 0.3,
  });
  defs.push({
    name: 'waist',
    jointA: J.pelvis,
    jointB: J.spine,
    a: add(P[J.pelvis]!, [0, -0.01 * H, 0]),
    b: add(P[J.spine]!, [0, 0.02 * H, 0]),
    bones: [J.pelvis, J.spine],
    tMin: 0,
    tMax: 1,
    maxDist: 0.3,
  });
  defs.push({
    name: 'pelvis',
    jointA: J.l_thigh,
    jointB: J.r_thigh,
    a: add(P[J.l_thigh]!, [0, 0.02 * H, 0]),
    b: add(P[J.r_thigh]!, [0, 0.02 * H, 0]),
    bones: [J.pelvis],
    tMin: -1,
    tMax: 2,
    maxDist: 0.3,
  });
  for (const side of [1, -1] as const) {
    const L = side === 1;
    const n = L ? 'l' : 'r';
    const jCl = L ? J.l_clavicle : J.r_clavicle;
    const jUa = L ? J.l_upper_arm : J.r_upper_arm;
    const jFa = L ? J.l_forearm : J.r_forearm;
    const jHa = L ? J.l_hand : J.r_hand;
    const jT = L ? J.l_thigh : J.r_thigh;
    const jC = L ? J.l_calf : J.r_calf;
    const jF = L ? J.l_foot : J.r_foot;
    const jTo = L ? J.l_toes : J.r_toes;
    defs.push({
      name: `shoulder_${n}`,
      jointA: jCl,
      jointB: jUa,
      a: P[jCl]!,
      b: P[jUa]!,
      bones: [jCl],
      tMin: 0,
      tMax: 1,
      maxDist: 0.12,
    });
    defs.push({
      name: `upper_arm_${n}`,
      jointA: jUa,
      jointB: jFa,
      a: P[jUa]!,
      b: P[jFa]!,
      bones: [jUa],
      tMin: 0.1,
      tMax: 0.95,
      maxDist: 0.12,
    });
    defs.push({
      name: `forearm_${n}`,
      jointA: jFa,
      jointB: jHa,
      a: P[jFa]!,
      b: P[jHa]!,
      bones: [jFa],
      tMin: 0.1,
      tMax: 0.95,
      maxDist: 0.1,
    });
    defs.push({
      name: `hand_${n}`,
      jointA: jHa,
      jointB: jHa,
      a: add(P[jHa]!, dirH(side), 0.1 * handLen),
      b: add(P[jHa]!, dirH(side), 0.8 * handLen),
      bones: [jHa],
      tMin: 0,
      tMax: 1,
      maxDist: 0.1,
    });
    // muslo y pantorrilla se dividen en dos cápsulas para seguir el estrechamiento hacia la rodilla / el tobillo
    defs.push({
      name: `thigh_${n}`,
      jointA: jT,
      jointB: jT,
      a: P[jT]!,
      b: mid(P[jT]!, P[jC]!, 0.48),
      bones: [jT],
      tMin: 0.2,
      tMax: 0.98,
      maxDist: 0.2,
    });
    defs.push({
      name: `thigh_lower_${n}`,
      jointA: jT,
      jointB: jC,
      a: mid(P[jT]!, P[jC]!, 0.48),
      b: P[jC]!,
      bones: [jT],
      tMin: 0.05,
      tMax: 0.95,
      maxDist: 0.2,
    });
    defs.push({
      name: `calf_${n}`,
      jointA: jC,
      jointB: jC,
      a: P[jC]!,
      b: mid(P[jC]!, P[jF]!, 0.5),
      bones: [jC],
      tMin: 0.15,
      tMax: 0.98,
      maxDist: 0.15,
    });
    defs.push({
      name: `shin_${n}`,
      jointA: jC,
      jointB: jF,
      a: mid(P[jC]!, P[jF]!, 0.5),
      b: P[jF]!,
      bones: [jC],
      tMin: 0.05,
      tMax: 0.9,
      maxDist: 0.15,
    });
    defs.push({
      name: `foot_${n}`,
      jointA: jF,
      jointB: jTo,
      a: add(P[jF]!, [0, -0.012 * H, 0]),
      b: add(P[jTo]!, [0, 0.003 * H, 0.02 * H]),
      bones: [jF, jTo],
      tMin: 0.15,
      tMax: 0.9,
      maxDist: 0.12,
    });
  }
  return defs;
}

/** Distancia de un punto a un segmento y parámetro de proyección. */
function segDist(
  px: number,
  py: number,
  pz: number,
  a: Vec3,
  b: Vec3,
): { d: number; t: number } {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 1e-12 ? ((px - a[0]) * abx + (py - a[1]) * aby + (pz - a[2]) * abz) / l2 : 0;
  const traw = t;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = a[0] + abx * t;
  const qy = a[1] + aby * t;
  const qz = a[2] + abz * t;
  return { d: Math.hypot(px - qx, py - qy, pz - qz), t: traw };
}

/**
 * Ajusta los colisionadores a la malla: el radio de cada cápsula es el 8 % más pequeño de las distancias
 * eje→piel de los vértices que le pertenecen, por un factor de seguridad < 1 (queda ligeramente por dentro).
 */
export function fitColliders(
  P: readonly Vec3[],
  H: number,
  handLen: number,
  dirH: (side: 1 | -1) => Vec3,
  positions: Float32Array,
  dominant: Uint8Array,
): CapsuleCollider[] {
  const defs = colliderDefs(P, H, handLen, dirH);
  const out: CapsuleCollider[] = [];
  const n = positions.length / 3;
  for (const def of defs) {
    const boneSet = new Set(def.bones);
    const dists: number[] = [];
    for (let v = 0; v < n; v++) {
      if (!boneSet.has(dominant[v]!)) continue;
      const { d, t } = segDist(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!, def.a, def.b);
      if (t < def.tMin || t > def.tMax || d > def.maxDist) continue;
      dists.push(d);
    }
    let r: number;
    if (dists.length >= 8) {
      dists.sort((x, y) => x - y);
      r = dists[Math.floor(dists.length * 0.08)]! * 0.93;
    } else {
      r = 0.02 * H;
    }
    r = Math.max(r, 0.008);
    const jA = def.jointA;
    const jB = def.jointB;
    out.push({
      name: def.name,
      jointA: jA,
      jointB: jB,
      offsetA: [def.a[0] - P[jA]![0], def.a[1] - P[jA]![1], def.a[2] - P[jA]![2]],
      offsetB: [def.b[0] - P[jB]![0], def.b[1] - P[jB]![1], def.b[2] - P[jB]![2]],
      radius: r,
    });
  }
  return out;
}

type MutableWorldCapsule = { a: [number, number, number]; b: [number, number, number]; radius: number };

/**
 * Transforma los colisionadores a espacio mundo con las matrices de skinning del fotograma
 * (16 floats por joint, column-major). Con `out` no asigna memoria (reutiliza los objetos existentes).
 */
export function worldColliders(
  body: BodyModel,
  skinMatrices: Float32Array,
  out: WorldCapsule[] = [],
): WorldCapsule[] {
  const joints = body.skeleton.joints;
  if (skinMatrices.length < joints.length * 16) {
    throw new BodyInputError(
      'invalid-skin-matrices',
      `se esperaban ${joints.length * 16} floats y llegaron ${skinMatrices.length}`,
    );
  }
  const cols = body.colliders;
  const m = skinMatrices;
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i]!;
    let w = out[i] as MutableWorldCapsule | undefined;
    if (!w) {
      w = { a: [0, 0, 0], b: [0, 0, 0], radius: 0 };
      out[i] = w;
    }
    const pa = joints[c.jointA]!.position;
    const ax = pa[0] + c.offsetA[0];
    const ay = pa[1] + c.offsetA[1];
    const az = pa[2] + c.offsetA[2];
    const ma = c.jointA * 16;
    w.a[0] = m[ma]! * ax + m[ma + 4]! * ay + m[ma + 8]! * az + m[ma + 12]!;
    w.a[1] = m[ma + 1]! * ax + m[ma + 5]! * ay + m[ma + 9]! * az + m[ma + 13]!;
    w.a[2] = m[ma + 2]! * ax + m[ma + 6]! * ay + m[ma + 10]! * az + m[ma + 14]!;
    const pb = joints[c.jointB]!.position;
    const bx = pb[0] + c.offsetB[0];
    const by = pb[1] + c.offsetB[1];
    const bz = pb[2] + c.offsetB[2];
    const mb = c.jointB * 16;
    w.b[0] = m[mb]! * bx + m[mb + 4]! * by + m[mb + 8]! * bz + m[mb + 12]!;
    w.b[1] = m[mb + 1]! * bx + m[mb + 5]! * by + m[mb + 9]! * bz + m[mb + 13]!;
    w.b[2] = m[mb + 2]! * bx + m[mb + 6]! * by + m[mb + 10]! * bz + m[mb + 14]!;
    w.radius = c.radius;
  }
  if (out.length > cols.length) out.length = cols.length;
  return out;
}
