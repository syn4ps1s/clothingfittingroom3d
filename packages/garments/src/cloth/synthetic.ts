import type { GarmentGeometry, WorldCapsule } from '@fitroom/shared';

/**
 * Geometrías sintéticas para pruebas del solver (no forman parte de la API pública).
 * `makeSkirt`: falda cónica abierta con correa creciente hacia el bajo y la cintura anclada.
 * `makeTube`: tubo ceñido (manga/pernera) alrededor de un eje, para probar colisión con cápsulas.
 */

export interface SkirtOptions {
  readonly rings: number;
  readonly segments: number;
  /** altura de la cintura (m) */
  readonly waistY?: number;
  readonly length?: number;
  readonly waistRadius?: number;
  readonly hemRadius?: number;
  /** correa en el bajo (m) */
  readonly hemMaxDistance?: number;
  readonly stiffness?: number;
  readonly damping?: number;
}

export function makeSkirt(o: SkirtOptions): GarmentGeometry {
  const rings = o.rings;
  const segs = o.segments;
  const waistY = o.waistY ?? 1.0;
  const length = o.length ?? 0.55;
  const r0 = o.waistRadius ?? 0.2;
  const r1 = o.hemRadius ?? 0.32;
  const hemMax = o.hemMaxDistance ?? 0.12;
  const n = (rings + 1) * segs;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const uvs = new Float32Array(n * 2);
  const maxDistance = new Float32Array(n);
  const invMass = new Float32Array(n);
  const ao = new Float32Array(n).fill(1);
  const skinIndices = new Uint16Array(n * 4);
  const skinWeights = new Float32Array(n * 4);
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const y = waistY - t * length;
    const rad = r0 + (r1 - r0) * t;
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const i = r * segs + s;
      positions[i * 3] = Math.cos(a) * rad;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = Math.sin(a) * rad;
      normals[i * 3] = Math.cos(a);
      normals[i * 3 + 1] = 0;
      normals[i * 3 + 2] = Math.sin(a);
      uvs[i * 2] = s / segs;
      uvs[i * 2 + 1] = 1 - t;
      maxDistance[i] = t * hemMax;
      invMass[i] = r === 0 ? 0 : 1;
      // pelvis (0) → muslos (13, 17) al bajar
      skinIndices[i * 4] = 0;
      skinIndices[i * 4 + 1] = 13;
      skinIndices[i * 4 + 2] = 17;
      skinIndices[i * 4 + 3] = 0;
      skinWeights[i * 4] = 1 - t * 0.7;
      skinWeights[i * 4 + 1] = t * 0.35;
      skinWeights[i * 4 + 2] = t * 0.35;
      skinWeights[i * 4 + 3] = 0;
    }
  }
  const indices = new Uint32Array(rings * segs * 6);
  let k = 0;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segs; s++) {
      const a = r * segs + s;
      const b = r * segs + ((s + 1) % segs);
      const c = (r + 1) * segs + s;
      const d = (r + 1) * segs + ((s + 1) % segs);
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }
  return {
    garmentId: 'synthetic-skirt',
    sizeLabel: 'M',
    slot: 'lower',
    mesh: { positions, normals, uvs, indices, skinIndices, skinWeights },
    groups: [{ start: 0, count: indices.length, slot: 'main' }],
    cloth: { maxDistance, invMass, stiffness: o.stiffness ?? 0.35, damping: o.damping ?? 0.08 },
    ao,
    coversRegions: ['pelvis', 'l_leg', 'r_leg'],
    uvMetersPerTile: 0.1,
  };
}

export interface TubeOptions {
  readonly rings: number;
  readonly segments: number;
  readonly length?: number;
  readonly radius?: number;
  readonly maxDistance?: number;
  readonly stiffness?: number;
  readonly damping?: number;
  /** nº de anillos superiores anclados */
  readonly pinnedRings?: number;
}

/** Tubo vertical (eje Y) centrado en el origen, de y = 0 a y = −length. */
export function makeTube(o: TubeOptions): GarmentGeometry {
  const rings = o.rings;
  const segs = o.segments;
  const length = o.length ?? 0.5;
  const radius = o.radius ?? 0.1;
  const n = (rings + 1) * segs;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const uvs = new Float32Array(n * 2);
  const maxDistance = new Float32Array(n).fill(o.maxDistance ?? 0.05);
  const invMass = new Float32Array(n).fill(1);
  const skinIndices = new Uint16Array(n * 4);
  const skinWeights = new Float32Array(n * 4);
  for (let r = 0; r <= rings; r++) {
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const i = r * segs + s;
      positions[i * 3] = Math.cos(a) * radius;
      positions[i * 3 + 1] = -(r / rings) * length;
      positions[i * 3 + 2] = Math.sin(a) * radius;
      normals[i * 3] = Math.cos(a);
      normals[i * 3 + 2] = Math.sin(a);
      uvs[i * 2] = s / segs;
      uvs[i * 2 + 1] = 1 - r / rings;
      if (r < (o.pinnedRings ?? 1)) invMass[i] = 0;
      skinIndices[i * 4] = 6;
      skinWeights[i * 4] = 1;
    }
  }
  const indices = new Uint32Array(rings * segs * 6);
  let k = 0;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segs; s++) {
      const a = r * segs + s;
      const b = r * segs + ((s + 1) % segs);
      const c = (r + 1) * segs + s;
      const d = (r + 1) * segs + ((s + 1) % segs);
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }
  return {
    garmentId: 'synthetic-tube',
    sizeLabel: 'M',
    slot: 'upper',
    mesh: { positions, normals, uvs, indices, skinIndices, skinWeights },
    groups: [{ start: 0, count: indices.length, slot: 'main' }],
    cloth: { maxDistance, invMass, stiffness: o.stiffness ?? 0.5, damping: o.damping ?? 0.1 },
    ao: new Float32Array(n).fill(1),
    coversRegions: ['l_arm'],
    uvMetersPerTile: 0.1,
  };
}

/** Cápsulas "cuerpo" que ocupan el interior de {@link makeSkirt} (caderas y muslos). */
export function skirtCapsules(): WorldCapsule[] {
  return [
    { a: [-0.09, 0.97, 0], b: [0.09, 0.97, 0], radius: 0.13 },
    { a: [0.09, 0.85, 0], b: [0.1, 0.45, 0], radius: 0.08 },
    { a: [-0.09, 0.85, 0], b: [-0.1, 0.45, 0], radius: 0.08 },
  ];
}

/**
 * Pose rígida animada (balanceo de caderas + paso) del estado de reposo → `out`.
 * Gira alrededor de la cintura y traslada; `t` en segundos. Devuelve la matriz usada para mover cápsulas.
 */
export function poseSkirt(
  rest: Float32Array,
  out: Float32Array,
  t: number,
  amp = 1,
): { yaw: number; roll: number; dx: number; dz: number } {
  const yaw = 0.35 * amp * Math.sin(t * 2.7);
  const roll = 0.12 * amp * Math.sin(t * 1.9 + 1);
  const dx = 0.08 * amp * Math.sin(t * 1.3);
  const dz = 0.06 * amp * Math.cos(t * 1.7);
  const cy = Math.cos(yaw),
    sy = Math.sin(yaw),
    cr = Math.cos(roll),
    sr = Math.sin(roll);
  const py = 1.0;
  for (let i = 0; i < rest.length; i += 3) {
    const x = rest[i]!,
      y = rest[i + 1]! - py,
      z = rest[i + 2]!;
    // yaw (eje Y) y luego roll (eje Z)
    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;
    const x2 = x1 * cr - y * sr;
    const y2 = x1 * sr + y * cr;
    out[i] = x2 + dx;
    out[i + 1] = y2 + py;
    out[i + 2] = z1 + dz;
  }
  return { yaw, roll, dx, dz };
}

/** Mueve las cápsulas con la misma pose rígida (`poseSkirt`). */
export function poseCapsules(
  caps: readonly WorldCapsule[],
  pose: { yaw: number; roll: number; dx: number; dz: number },
): WorldCapsule[] {
  const cy = Math.cos(pose.yaw),
    sy = Math.sin(pose.yaw),
    cr = Math.cos(pose.roll),
    sr = Math.sin(pose.roll);
  const mv = (p: readonly [number, number, number]): [number, number, number] => {
    const x = p[0],
      y = p[1] - 1.0,
      z = p[2];
    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;
    return [x1 * cr - y * sr + pose.dx, x1 * sr + y * cr + 1.0, z1 + pose.dz];
  };
  return caps.map((c) => ({ a: mv(c.a), b: mv(c.b), radius: c.radius }));
}
