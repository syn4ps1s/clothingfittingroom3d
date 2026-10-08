import { J, REST_BONE_DIRECTIONS, type BodyModel, type Vec3 } from '@fitroom/shared';

/**
 * Utilidades PURAS de medición sobre la malla del cuerpo (cortes por plano, perímetros, alturas, anchos).
 * Las usan los tests y los agentes de auditoría para comprobar que la malla respeta las medidas pedidas.
 */

export type Loop = Float64Array; // xyz intercalados, cerrado implícitamente

/** Corta una malla triangular con un plano (punto + normal) y devuelve los lazos cerrados de la sección. */
export function slicePlane(
  positions: Float32Array,
  indices: Uint32Array,
  origin: Vec3,
  normal: Vec3,
): Loop[] {
  const nv = positions.length / 3;
  const nl = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  const nx = normal[0] / nl;
  const ny = normal[1] / nl;
  const nz = normal[2] / nl;
  const sv = new Float64Array(nv);
  for (let v = 0; v < nv; v++) {
    let s =
      (positions[v * 3]! - origin[0]) * nx +
      (positions[v * 3 + 1]! - origin[1]) * ny +
      (positions[v * 3 + 2]! - origin[2]) * nz;
    if (s === 0) s = 1e-12;
    sv[v] = s;
  }
  const pts: number[] = [];
  const keyToPt = new Map<number, number>();
  const pointOnEdge = (a: number, b: number): number => {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = lo * nv + hi;
    let id = keyToPt.get(key);
    if (id === undefined) {
      const sa = sv[lo]!;
      const sb = sv[hi]!;
      const t = sa / (sa - sb);
      id = pts.length / 3;
      pts.push(
        positions[lo * 3]! + (positions[hi * 3]! - positions[lo * 3]!) * t,
        positions[lo * 3 + 1]! + (positions[hi * 3 + 1]! - positions[lo * 3 + 1]!) * t,
        positions[lo * 3 + 2]! + (positions[hi * 3 + 2]! - positions[lo * 3 + 2]!) * t,
      );
      keyToPt.set(key, id);
    }
    return id;
  };
  // segmentos: cada punto-arista aparece en exactamente dos segmentos en una malla cerrada
  const link = new Map<number, number[]>();
  const nT = indices.length / 3;
  for (let t = 0; t < nT; t++) {
    const a = indices[t * 3]!;
    const b = indices[t * 3 + 1]!;
    const c = indices[t * 3 + 2]!;
    const pa = sv[a]! > 0;
    const pb = sv[b]! > 0;
    const pc = sv[c]! > 0;
    if (pa === pb && pb === pc) continue;
    let p0: number;
    let p1: number;
    // aristas que cruzan: las dos cuyo signo difiere
    if (pa !== pb && pa !== pc) {
      p0 = pointOnEdge(a, b);
      p1 = pointOnEdge(a, c);
    } else if (pb !== pa && pb !== pc) {
      p0 = pointOnEdge(b, a);
      p1 = pointOnEdge(b, c);
    } else {
      p0 = pointOnEdge(c, a);
      p1 = pointOnEdge(c, b);
    }
    if (p0 === p1) continue;
    (link.get(p0) ?? link.set(p0, []).get(p0)!).push(p1);
    (link.get(p1) ?? link.set(p1, []).get(p1)!).push(p0);
  }
  const visited = new Set<number>();
  const loops: Loop[] = [];
  const starts = Array.from(link.keys()).sort((x, y) => x - y);
  for (const s of starts) {
    if (visited.has(s)) continue;
    const seq: number[] = [];
    let prev = -1;
    let cur = s;
    for (let guard = 0; guard < link.size + 2; guard++) {
      seq.push(cur);
      visited.add(cur);
      const nb = link.get(cur)!;
      let next = nb[0]!;
      if (next === prev && nb.length > 1) next = nb[1]!;
      if (nb.length === 1 && next === prev) break;
      prev = cur;
      cur = next;
      if (cur === s) break;
    }
    if (seq.length < 3) continue;
    const loop = new Float64Array(seq.length * 3);
    for (let i = 0; i < seq.length; i++) {
      loop[i * 3] = pts[seq[i]! * 3]!;
      loop[i * 3 + 1] = pts[seq[i]! * 3 + 1]!;
      loop[i * 3 + 2] = pts[seq[i]! * 3 + 2]!;
    }
    loops.push(loop);
  }
  return loops;
}

export function loopPerimeter(loop: Loop): number {
  const n = loop.length / 3;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += Math.hypot(
      loop[j * 3]! - loop[i * 3]!,
      loop[j * 3 + 1]! - loop[i * 3 + 1]!,
      loop[j * 3 + 2]! - loop[i * 3 + 2]!,
    );
  }
  return s;
}

/** Área con signo del lazo proyectado en el plano XZ (m²). */
export function loopAreaXZ(loop: Loop): number {
  const n = loop.length / 3;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += loop[i * 3]! * loop[j * 3 + 2]! - loop[j * 3]! * loop[i * 3 + 2]!;
  }
  return a / 2;
}

/** ¿Contiene el lazo (proyectado en XZ) el punto (x, z)? */
export function loopContainsXZ(loop: Loop, x: number, z: number): boolean {
  const n = loop.length / 3;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = loop[i * 3]!;
    const zi = loop[i * 3 + 2]!;
    const xj = loop[j * 3]!;
    const zj = loop[j * 3 + 2]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Centroide (media de vértices ponderada por longitud de arista) de un lazo 3D. */
export function loopCentroid(loop: Loop): Vec3 {
  const n = loop.length / 3;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let w = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const l = Math.hypot(
      loop[j * 3]! - loop[i * 3]!,
      loop[j * 3 + 1]! - loop[i * 3 + 1]!,
      loop[j * 3 + 2]! - loop[i * 3 + 2]!,
    );
    cx += l * 0.5 * (loop[i * 3]! + loop[j * 3]!);
    cy += l * 0.5 * (loop[i * 3 + 1]! + loop[j * 3 + 1]!);
    cz += l * 0.5 * (loop[i * 3 + 2]! + loop[j * 3 + 2]!);
    w += l;
  }
  return w > 0 ? [cx / w, cy / w, cz / w] : [0, 0, 0];
}

/** Recorta un lazo con el semiplano x >= 0 (side = 1) o x <= 0 (side = −1) cerrándolo por el plano x = 0. */
export function clipLoopHalfX(loop: Loop, side: 1 | -1): Loop {
  const n = loop.length / 3;
  const out: number[] = [];
  const inside = (i: number): boolean => side * loop[i * 3]! >= 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ii = inside(i);
    const jj = inside(j);
    if (ii) out.push(loop[i * 3]!, loop[i * 3 + 1]!, loop[i * 3 + 2]!);
    if (ii !== jj) {
      const xi = loop[i * 3]!;
      const xj = loop[j * 3]!;
      const t = xi / (xi - xj);
      out.push(
        0,
        loop[i * 3 + 1]! + (loop[j * 3 + 1]! - loop[i * 3 + 1]!) * t,
        loop[i * 3 + 2]! + (loop[j * 3 + 2]! - loop[i * 3 + 2]!) * t,
      );
    }
  }
  return Float64Array.from(out);
}

/** Resultado de `measureBody`: todo en cm salvo donde se indica. */
export interface MeasuredBody {
  /** max y − min y de la malla */
  readonly heightCm: number;
  readonly minYCm: number;
  readonly chestCm: number;
  readonly waistCm: number;
  readonly hipCm: number;
  readonly neckCm: number;
  /** media de ambos muslos (cada uno cortado por su plano medio si los contornos se funden) */
  readonly thighCm: number;
  readonly thighLeftCm: number;
  readonly thighRightCm: number;
  /**
   * Distancia entre los ejes de los dos brazos a la altura del hombro (eje ajustado a los centroides de dos cortes
   * perpendiculares del brazo). Es la definición coherente con el esqueleto: las articulaciones del hombro.
   */
  readonly shoulderWidthCm: number;
  /** Anchura bideltoidea: extensión lateral máxima del tronco+hombros a la altura del hombro (≈ shoulderWidth + 2·r del deltoides). */
  readonly bideltoidCm: number;
  /** Longitud media del brazo: articulación del hombro → muñeca (mínimo de circunferencia del antebrazo-mano). */
  readonly armLengthCm: number;
  /** Altura de la entrepierna: primera altura (hacia arriba) en que los contornos de las piernas se funden. */
  readonly inseamCm: number;
  /** Extensión X total de la malla y desplazamiento del centro respecto a x = 0 */
  readonly widthCm: number;
  readonly centerXCm: number;
  readonly depthCm: number;
  /** Volumen (L) y superficie (m²) */
  readonly volumeL: number;
  readonly surfaceM2: number;
  /** Alturas (m) de los cortes usados */
  readonly landmarks: {
    readonly chest: number;
    readonly waist: number;
    readonly hip: number;
    readonly neck: number;
    readonly thigh: number;
    readonly shoulder: number;
  };
}

function torsoLoop(loops: readonly Loop[], z = 0): Loop | undefined {
  let best: Loop | undefined;
  let bestArea = -1;
  for (const l of loops) {
    const a = Math.abs(loopAreaXZ(l));
    if (loopContainsXZ(l, 0, z)) {
      if (a > bestArea) {
        best = l;
        bestArea = a;
      }
    }
  }
  if (best) return best;
  for (const l of loops) {
    const a = Math.abs(loopAreaXZ(l));
    if (a > bestArea) {
      best = l;
      bestArea = a;
    }
  }
  return best;
}

/** Perímetro (cm) del lazo del tronco/cuello a la altura y. */
export function torsoGirthCm(
  positions: Float32Array,
  indices: Uint32Array,
  y: number,
  z = 0,
): number {
  const l = torsoLoop(slicePlane(positions, indices, [0, y, 0], [0, 1, 0]), z);
  return l ? loopPerimeter(l) * 100 : NaN;
}

/** Perímetro (cm) del muslo de un lado a la altura y (recortado por el plano medio si los muslos se funden). */
export function thighGirthCm(
  positions: Float32Array,
  indices: Uint32Array,
  y: number,
  side: 1 | -1,
  expectedX: number,
): number {
  const loops = slicePlane(positions, indices, [0, y, 0], [0, 1, 0]);
  let best = NaN;
  let bestDx = Infinity;
  for (const l of loops) {
    const clipped = clipLoopHalfX(l, side);
    if (clipped.length < 9) continue;
    const c = loopCentroid(clipped);
    const dx = Math.abs(c[0] - expectedX);
    if (dx < bestDx) {
      bestDx = dx;
      best = loopPerimeter(clipped) * 100;
    }
  }
  return best;
}

/** Primera altura (m) desde yLo hacia arriba en que algún lazo cruza el plano x = 0 (piernas fundidas). */
export function crotchHeight(
  positions: Float32Array,
  indices: Uint32Array,
  yLo: number,
  yHi: number,
): number {
  const merged = (y: number): boolean => {
    const loops = slicePlane(positions, indices, [0, y, 0], [0, 1, 0]);
    for (const l of loops) {
      let pos = false;
      let neg = false;
      for (let i = 0; i < l.length; i += 3) {
        if (l[i]! > 0) pos = true;
        else neg = true;
      }
      if (pos && neg) return true;
    }
    return false;
  };
  let lo = yLo;
  let hi = yHi;
  if (!merged(hi)) return NaN;
  if (merged(lo)) return lo;
  for (let i = 0; i < 16; i++) {
    const mid = 0.5 * (lo + hi);
    if (merged(mid)) hi = mid;
    else lo = mid;
  }
  return 0.5 * (lo + hi);
}

interface ArmAxis {
  readonly shoulderX: number;
  readonly wristDist: number;
}

/**
 * Mide un brazo: ajusta el eje a los centroides de dos cortes perpendiculares (20 % y 60 % del húmero),
 * lo intersecta con el plano horizontal del hombro y busca el mínimo de circunferencia (muñeca) a lo largo del eje.
 */
function measureArm(body: BodyModel, side: 1 | -1): ArmAxis {
  const { positions, indices } = body.mesh;
  const jUa = side === 1 ? J.l_upper_arm : J.r_upper_arm;
  const jFa = side === 1 ? J.l_forearm : J.r_forearm;
  const jHa = side === 1 ? J.l_hand : J.r_hand;
  const sh = body.skeleton.joints[jUa]!.position;
  const el = body.skeleton.joints[jFa]!.position;
  const wr = body.skeleton.joints[jHa]!.position;
  const dir = REST_BONE_DIRECTIONS[jUa]!;
  const upperLen = Math.hypot(el[0] - sh[0], el[1] - sh[1], el[2] - sh[2]);
  const foreLen = Math.hypot(wr[0] - el[0], wr[1] - el[1], wr[2] - el[2]);
  const armLen = upperLen + foreLen;
  const centroidAt = (s: number): Vec3 | undefined => {
    const o: Vec3 = [sh[0] + dir[0] * s, sh[1] + dir[1] * s, sh[2] + dir[2] * s];
    const loops = slicePlane(positions, indices, o, dir);
    let best: Loop | undefined;
    let bd = Infinity;
    for (const l of loops) {
      const c = loopCentroid(l);
      const d = Math.hypot(c[0] - o[0], c[1] - o[1], c[2] - o[2]);
      if (d < bd) {
        bd = d;
        best = l;
      }
    }
    return best ? loopCentroid(best) : undefined;
  };
  const c1 = centroidAt(0.2 * upperLen);
  const c2 = centroidAt(0.6 * upperLen);
  let shoulderX = sh[0];
  if (c1 && c2 && Math.abs(c2[1] - c1[1]) > 1e-6) {
    const t = (sh[1] - c1[1]) / (c2[1] - c1[1]);
    shoulderX = c1[0] + (c2[0] - c1[0]) * t;
  }
  // mínimo de circunferencia en una ventana alrededor de la muñeca (±6 cm de la articulación)
  let bestS = armLen;
  let bestP = Infinity;
  const prof: [number, number][] = [];
  for (let s = armLen - 0.06; s <= armLen + 0.06; s += 0.004) {
    const o: Vec3 = [sh[0] + dir[0] * s, sh[1] + dir[1] * s, sh[2] + dir[2] * s];
    const loops = slicePlane(positions, indices, o, dir);
    let best: Loop | undefined;
    let bd = Infinity;
    for (const l of loops) {
      const c = loopCentroid(l);
      const d = Math.hypot(c[0] - o[0], c[1] - o[1], c[2] - o[2]);
      if (d < bd && d < 0.08) {
        bd = d;
        best = l;
      }
    }
    if (!best) continue;
    const p = loopPerimeter(best);
    prof.push([s, p]);
    if (p < bestP) {
      bestP = p;
      bestS = s;
    }
  }
  // centro de la meseta del mínimo (±2 % del perímetro mínimo) para no depender de ruido de la malla
  let sumS = 0;
  let cnt = 0;
  for (const [s, p] of prof) {
    if (p <= bestP * 1.02 && Math.abs(s - bestS) < 0.02) {
      sumS += s;
      cnt++;
    }
  }
  if (cnt > 0) bestS = sumS / cnt;
  return { shoulderX, wristDist: bestS };
}

/**
 * Mide la malla del cuerpo (definiciones documentadas en `docs/anthropometry.md` y en cada campo de
 * `MeasuredBody`). Pura, determinista y sin efectos: no modifica el cuerpo.
 */
export function measureBody(body: BodyModel): MeasuredBody {
  const { positions, indices } = body.mesh;
  const sk = body.skeleton;
  const H = sk.height;
  const P = sk.joints.map((j) => j.position);
  const crotchTarget = body.measurements.inseamCm / 100;
  const lmChest = P[J.chest]![1] - 0.035 * H;
  const lmWaist = P[J.spine]![1];
  const lmHip = P[J.l_thigh]![1] - 0.02 * H;
  const lmNeck = P[J.neck]![1] + 0.027 * H;
  const lmThigh = crotchTarget - 0.03 * H;
  const lmShoulder = P[J.l_upper_arm]![1];

  let minY = Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  let vol = 0;
  let area = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const ax = positions[a]!;
    const ay = positions[a + 1]!;
    const az = positions[a + 2]!;
    const bx = positions[b]!;
    const by = positions[b + 1]!;
    const bz = positions[b + 2]!;
    const cx = positions[c]!;
    const cy = positions[c + 1]!;
    const cz = positions[c + 2]!;
    vol +=
      (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }

  const legX = P[J.l_thigh]![0];
  const tL = thighGirthCm(positions, indices, lmThigh, 1, legX);
  const tR = thighGirthCm(positions, indices, lmThigh, -1, -legX);
  const armL = measureArm(body, 1);
  const armR = measureArm(body, -1);
  const shWidth = armL.shoulderX - armR.shoulderX;
  // bideltoidea: extensión lateral en el plano del hombro (lazo que contiene el eje)
  const shLoop = torsoLoop(slicePlane(positions, indices, [0, lmShoulder, 0], [0, 1, 0]), 0);
  let bideltoid = NaN;
  if (shLoop) {
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < shLoop.length; i += 3) {
      mn = Math.min(mn, shLoop[i]!);
      mx = Math.max(mx, shLoop[i]!);
    }
    bideltoid = (mx - mn) * 100;
  }
  const crotch = crotchHeight(positions, indices, 0.3 * H, crotchTarget + 0.12);
  return {
    heightCm: (maxY - minY) * 100,
    minYCm: minY * 100,
    chestCm: torsoGirthCm(positions, indices, lmChest),
    waistCm: torsoGirthCm(positions, indices, lmWaist),
    hipCm: torsoGirthCm(positions, indices, lmHip),
    neckCm: torsoGirthCm(positions, indices, lmNeck, 0.006 * H),
    thighCm: (tL + tR) / 2,
    thighLeftCm: tL,
    thighRightCm: tR,
    shoulderWidthCm: shWidth * 100,
    bideltoidCm: bideltoid,
    armLengthCm: ((armL.wristDist + armR.wristDist) / 2) * 100,
    inseamCm: crotch * 100,
    widthCm: (maxX - minX) * 100,
    centerXCm: ((maxX + minX) / 2) * 100,
    depthCm: (maxZ - minZ) * 100,
    volumeL: vol * 1000,
    surfaceM2: area,
    landmarks: {
      chest: lmChest,
      waist: lmWaist,
      hip: lmHip,
      neck: lmNeck,
      thigh: lmThigh,
      shoulder: lmShoulder,
    },
  };
}
