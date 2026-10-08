import {
  J,
  JOINT_COUNT,
  buildRestSkeleton,
  computeVertexNormals,
  type BodyModel,
  type BodyRegion,
  type CapsuleCollider,
  type Measurements,
  type RestSkeleton,
  BODY_REGIONS,
} from '@fitroom/shared';
import { F64Buf, U32Buf } from '../core/buf.js';

/**
 * Cuerpo de PRUEBA (sólo para desarrollo/tests de GARMENT-GEO): unión suave de elipsoides/cápsulas
 * conformes a las medidas, extraída con surface-nets a una malla cerrada única, con pesos de skin por huesos.
 * No pretende ser realista: sólo tener topología/escala parecidas al cuerpo real para probar las prendas.
 */

const ellipsePerimeter = (a: number, b: number): number =>
  Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));

/** semieje mayor `a` de una elipse con relación b/a = k y perímetro C */
function semiAxisFromCircumference(C: number, k: number): number {
  return C / ellipsePerimeter(1, k);
}

interface Station {
  y: number;
  a: number;
  bf: number;
  bb: number;
  zc: number;
}

function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

type Vec = readonly [number, number, number];

function segDist(
  px: number,
  py: number,
  pz: number,
  a: Vec,
  b: Vec,
): { d: number; t: number } {
  const abx = b[0] - a[0],
    aby = b[1] - a[1],
    abz = b[2] - a[2];
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 0 ? ((px - a[0]) * abx + (py - a[1]) * aby + (pz - a[2]) * abz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { d: Math.hypot(px - a[0] - abx * t, py - a[1] - aby * t, pz - a[2] - abz * t), t };
}

interface Limb {
  pts: Vec[];
  radii: number[];
  /** escala en Y para aplanar (pies/manos) */
  flatY?: number;
}

function limbDist(limb: Limb, x: number, y: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < limb.pts.length; i++) {
    const s = segDist(x, y, z, limb.pts[i]!, limb.pts[i + 1]!);
    const r = limb.radii[i]! + (limb.radii[i + 1]! - limb.radii[i]!) * s.t;
    const d = s.d - r;
    if (d < best) best = d;
  }
  return best;
}

export interface TestBodyOptions {
  /** tamaño de celda del surface-nets (m) */
  readonly cell?: number;
}

export function buildTestBody(m: Measurements, opts: TestBodyOptions = {}): BodyModel {
  const skeleton = buildRestSkeleton(m);
  const H = skeleton.height;
  const pos = (j: number): Vec => skeleton.joints[j]!.position;
  const inseam = m.inseamCm / 100;

  const wHip = semiAxisFromCircumference(m.hipCm / 100, 0.76);
  const wWaist = semiAxisFromCircumference(m.waistCm / 100, 0.7);
  const wChest = semiAxisFromCircumference(m.chestCm / 100, 0.74);
  const feminine = m.bodyBase === 'feminine';
  const stations: Station[] = [
    { y: inseam + 0.0, a: wHip * 0.9, bf: wHip * 0.5, bb: wHip * 0.58, zc: -0.012 },
    { y: inseam + 0.05, a: wHip * 0.97, bf: wHip * 0.68, bb: wHip * 0.76, zc: -0.008 },
    { y: 0.52 * H, a: wHip, bf: wHip * 0.74, bb: wHip * 0.82, zc: -0.008 },
    { y: 0.62 * H, a: wWaist, bf: wWaist * 0.68, bb: wWaist * 0.66, zc: 0 },
    {
      y: 0.7 * H,
      a: wChest * 0.97,
      bf: wChest * (feminine ? 0.84 : 0.76),
      bb: wChest * 0.7,
      zc: 0.004,
    },
    { y: 0.77 * H, a: wChest * 0.93, bf: wChest * 0.68, bb: wChest * 0.66, zc: -0.004 },
    { y: 0.808 * H, a: (m.shoulderWidthCm / 100) * 0.4, bf: 0.062, bb: 0.072, zc: -0.008 },
    { y: 0.83 * H, a: 0.075, bf: 0.06, bb: 0.07, zc: -0.008 },
  ];
  const neckR = m.neckCm / 100 / (2 * Math.PI) + 0.004;
  const profile = (y: number): Station => {
    const s = stations;
    if (y <= s[0]!.y) return s[0]!;
    if (y >= s[s.length - 1]!.y) return s[s.length - 1]!;
    let i = 0;
    while (y > s[i + 1]!.y) i++;
    const t = (y - s[i]!.y) / (s[i + 1]!.y - s[i]!.y);
    const u = t * t * (3 - 2 * t);
    const a = s[i]!,
      b = s[i + 1]!;
    return {
      y,
      a: a.a + (b.a - a.a) * u,
      bf: a.bf + (b.bf - a.bf) * u,
      bb: a.bb + (b.bb - a.bb) * u,
      zc: a.zc + (b.zc - a.zc) * u,
    };
  };

  const armR = (m.chestCm / 100) * 0.056; // ~ 0.055 para pecho 98
  const side = (s: 1 | -1): { arm: Limb; leg: Limb; foot: Limb; clav: Limb } => {
    const [cl, ua, fa, ha, th, ca, ft, to] =
      s === 1
        ? [J.l_clavicle, J.l_upper_arm, J.l_forearm, J.l_hand, J.l_thigh, J.l_calf, J.l_foot, J.l_toes]
        : [J.r_clavicle, J.r_upper_arm, J.r_forearm, J.r_hand, J.r_thigh, J.r_calf, J.r_foot, J.r_toes];
    const handEnd: Vec = [
      pos(ha)[0] + skeleton.joints[ha]!.boneLength * 0.65 * s * Math.sin((38 * Math.PI) / 180),
      pos(ha)[1] - skeleton.joints[ha]!.boneLength * 0.65 * Math.cos((38 * Math.PI) / 180),
      pos(ha)[2],
    ];
    const rt = m.thighCm / 100 / (2 * Math.PI);
    // las articulaciones del hombro quedan dentro del torso: el brazo arranca algo hacia dentro
    const shoulderIn: Vec = [pos(ua)[0] - s * 0.012, pos(ua)[1] - 0.012, pos(ua)[2]];
    return {
      arm: {
        pts: [shoulderIn, pos(ua), pos(fa), pos(ha), handEnd],
        radii: [armR * 1.15, armR * 1.12, armR * 0.78, armR * 0.54, armR * 0.5],
      },
      leg: {
        pts: [
          [pos(th)[0] * 0.9, pos(th)[1] + 0.05, pos(th)[2]],
          pos(th),
          pos(ca),
          pos(ft),
        ],
        radii: [rt * 1.05, rt * 1.0, rt * 0.62, rt * 0.42],
      },
      foot: {
        pts: [
          [pos(ft)[0], pos(ft)[1] - 0.03, pos(ft)[2] - 0.045],
          [pos(to)[0], pos(to)[1] - 0.018, pos(to)[2]],
        ],
        radii: [0.04, 0.032],
      },
      clav: {
        pts: [
          [s * 0.02, 0.83 * H, -0.008],
          [pos(ua)[0] - s * 0.02, pos(ua)[1] + 0.005, -0.004],
        ],
        radii: [0.04, 0.046],
      },
    };
  };
  const L = side(1),
    R = side(-1);
  const headC: Vec = [0, 0.935 * H, 0.005];
  const neckLimb: Limb = {
    pts: [
      [0, 0.82 * H, -0.006],
      [0, 0.875 * H, 0.0],
    ],
    radii: [neckR * 1.15, neckR * 0.95],
  };

  const sdf = (x: number, y: number, z: number): number => {
    const ax = Math.abs(x);
    const st = profile(y);
    const q = Math.hypot(ax / st.a, (z - st.zc) / (z > st.zc ? st.bf : st.bb));
    let d = (q - 1) * Math.min(st.a, z > st.zc ? st.bf : st.bb);
    // límite superior del bloque del tronco
    d = Math.max(d, y - 0.835 * H, inseam - y);
    const k = 0.028;
    d = smin(d, limbDist(L.arm, x, y, z), k);
    d = smin(d, limbDist(R.arm, x, y, z), k);
    d = smin(d, limbDist(L.leg, x, y, z), 0.05);
    d = smin(d, limbDist(R.leg, x, y, z), 0.05);
    d = smin(d, limbDist(L.clav, x, y, z), k);
    d = smin(d, limbDist(R.clav, x, y, z), k);
    d = smin(d, limbDist(neckLimb, x, y, z), 0.02);
    // pies: más bajos y planos
    d = Math.min(d, limbDist(L.foot, x, y, z), limbDist(R.foot, x, y, z));
    // cabeza (elipsoide)
    const hx = (x - headC[0]) / 0.078,
      hy = (y - headC[1]) / 0.108,
      hz = (z - headC[2]) / 0.098;
    d = smin(d, (Math.hypot(hx, hy, hz) - 1) * 0.078, 0.02);
    return d;
  };

  // ---- surface nets ----
  const cell = opts.cell ?? 0.012;
  const pad = 0.05;
  const x0 = -0.62 * H * 0.5 - 0.28,
    x1 = -x0;
  const y0 = -pad,
    y1 = H + pad;
  const z0 = -0.2,
    z1 = 0.32;
  const nx = Math.ceil((x1 - x0) / cell) + 1,
    ny = Math.ceil((y1 - y0) / cell) + 1,
    nz = Math.ceil((z1 - z0) / cell) + 1;
  const field = new Float32Array(nx * ny * nz);
  for (let iz = 0; iz < nz; iz++)
    for (let iy = 0; iy < ny; iy++)
      for (let ix = 0; ix < nx; ix++) {
        field[ix + iy * nx + iz * nx * ny] = sdf(x0 + ix * cell, y0 + iy * cell, z0 + iz * cell);
      }
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const verts = new F64Buf(60000);
  let vcount = 0;
  const corner = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 1],
  ] as const;
  const edges = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ] as const;
  for (let iz = 0; iz < nz - 1; iz++)
    for (let iy = 0; iy < ny - 1; iy++)
      for (let ix = 0; ix < nx - 1; ix++) {
        const vals: number[] = [];
        let inside = 0;
        for (const c of corner) {
          const v = field[ix + c[0] + (iy + c[1]) * nx + (iz + c[2]) * nx * ny]!;
          vals.push(v);
          if (v < 0) inside++;
        }
        if (inside === 0 || inside === 8) continue;
        let sx = 0,
          sy = 0,
          sz = 0,
          cnt = 0;
        for (const [a, b] of edges) {
          const va = vals[a]!,
            vb = vals[b]!;
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          sx += corner[a]![0] + (corner[b]![0] - corner[a]![0]) * t;
          sy += corner[a]![1] + (corner[b]![1] - corner[a]![1]) * t;
          sz += corner[a]![2] + (corner[b]![2] - corner[a]![2]) * t;
          cnt++;
        }
        cellVert[ix + iy * (nx - 1) + iz * (nx - 1) * (ny - 1)] = vcount++;
        verts.push3(x0 + (ix + sx / cnt) * cell, y0 + (iy + sy / cnt) * cell, z0 + (iz + sz / cnt) * cell);
      }
  const tris = new U32Buf(200000);
  const cv = (ix: number, iy: number, iz: number): number =>
    cellVert[ix + iy * (nx - 1) + iz * (nx - 1) * (ny - 1)]!;
  const f = (ix: number, iy: number, iz: number): number => field[ix + iy * nx + iz * nx * ny]!;
  // una quad por arista de la rejilla con cambio de signo
  for (let iz = 1; iz < nz - 1; iz++)
    for (let iy = 1; iy < ny - 1; iy++)
      for (let ix = 1; ix < nx - 1; ix++) {
        const a = f(ix, iy, iz) < 0;
        // arista +X
        if (ix < nx - 2 && a !== f(ix + 1, iy, iz) < 0) {
          const q = [cv(ix, iy - 1, iz - 1), cv(ix, iy, iz - 1), cv(ix, iy, iz), cv(ix, iy - 1, iz)];
          if (q.every((v) => v >= 0)) {
            if (a) tris.push3(q[0]!, q[1]!, q[2]!), tris.push3(q[0]!, q[2]!, q[3]!);
            else tris.push3(q[0]!, q[2]!, q[1]!), tris.push3(q[0]!, q[3]!, q[2]!);
          }
        }
        if (iy < ny - 2 && a !== f(ix, iy + 1, iz) < 0) {
          const q = [cv(ix - 1, iy, iz - 1), cv(ix - 1, iy, iz), cv(ix, iy, iz), cv(ix, iy, iz - 1)];
          if (q.every((v) => v >= 0)) {
            if (a) tris.push3(q[0]!, q[1]!, q[2]!), tris.push3(q[0]!, q[2]!, q[3]!);
            else tris.push3(q[0]!, q[2]!, q[1]!), tris.push3(q[0]!, q[3]!, q[2]!);
          }
        }
        if (iz < nz - 2 && a !== f(ix, iy, iz + 1) < 0) {
          const q = [cv(ix - 1, iy - 1, iz), cv(ix, iy - 1, iz), cv(ix, iy, iz), cv(ix - 1, iy, iz)];
          if (q.every((v) => v >= 0)) {
            if (a) tris.push3(q[0]!, q[1]!, q[2]!), tris.push3(q[0]!, q[2]!, q[3]!);
            else tris.push3(q[0]!, q[2]!, q[1]!), tris.push3(q[0]!, q[3]!, q[2]!);
          }
        }
      }
  const positions = new Float32Array(verts.toArray());
  // proyecta cada vértice sobre la isosuperficie (2 pasos de Newton)
  const eps = 0.002;
  for (let v = 0; v < vcount; v++) {
    let x = positions[v * 3]!,
      y = positions[v * 3 + 1]!,
      z = positions[v * 3 + 2]!;
    for (let it = 0; it < 3; it++) {
      const d = sdf(x, y, z);
      const gx = (sdf(x + eps, y, z) - sdf(x - eps, y, z)) / (2 * eps);
      const gy = (sdf(x, y + eps, z) - sdf(x, y - eps, z)) / (2 * eps);
      const gz = (sdf(x, y, z + eps) - sdf(x, y, z - eps)) / (2 * eps);
      const gl = Math.hypot(gx, gy, gz) || 1;
      // paso acotado: nunca arrastra el vértice más de media celda (evita triángulos largos por el interior)
      const k = Math.min(1, (0.5 * cell) / Math.max(Math.abs(d) / gl, 1e-9));
      x -= (k * d * gx) / (gl * gl);
      y -= (k * d * gy) / (gl * gl);
      z -= (k * d * gz) / (gl * gl);
    }
    positions[v * 3] = x;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = z;
  }
  const indices = tris.toArray();
  const normals = computeVertexNormals(positions, indices);

  // ---- skin weights por distancia a huesos ----
  const bones: Array<{ joint: number; a: Vec; b: Vec }> = [];
  const tip = (j: number): Vec => {
    const jt = skeleton.joints[j]!;
    return [jt.position[0], jt.position[1] + jt.boneLength, jt.position[2]];
  };
  const childOf: Record<number, Vec> = {
    [J.pelvis]: pos(J.spine),
    [J.spine]: pos(J.chest),
    [J.chest]: pos(J.neck),
    [J.neck]: pos(J.head),
    [J.head]: tip(J.head),
    [J.l_clavicle]: pos(J.l_upper_arm),
    [J.l_upper_arm]: pos(J.l_forearm),
    [J.l_forearm]: pos(J.l_hand),
    [J.l_hand]: [pos(J.l_hand)[0] + 0.05, pos(J.l_hand)[1] - 0.07, 0],
    [J.r_clavicle]: pos(J.r_upper_arm),
    [J.r_upper_arm]: pos(J.r_forearm),
    [J.r_forearm]: pos(J.r_hand),
    [J.r_hand]: [pos(J.r_hand)[0] - 0.05, pos(J.r_hand)[1] - 0.07, 0],
    [J.l_thigh]: pos(J.l_calf),
    [J.l_calf]: pos(J.l_foot),
    [J.l_foot]: pos(J.l_toes),
    [J.l_toes]: [pos(J.l_toes)[0], pos(J.l_toes)[1], pos(J.l_toes)[2] + 0.04],
    [J.r_thigh]: pos(J.r_calf),
    [J.r_calf]: pos(J.r_foot),
    [J.r_foot]: pos(J.r_toes),
    [J.r_toes]: [pos(J.r_toes)[0], pos(J.r_toes)[1], pos(J.r_toes)[2] + 0.04],
  };
  for (let j = 0; j < JOINT_COUNT; j++) bones.push({ joint: j, a: pos(j), b: childOf[j]! });
  const skinIndices = new Uint16Array(vcount * 4);
  const skinWeights = new Float32Array(vcount * 4);
  const regions = new Uint8Array(vcount);
  const regionOfJoint = (j: number): BodyRegion => {
    if (j === J.pelvis) return 'pelvis';
    if (j === J.head) return 'head';
    if (j === J.neck) return 'neck';
    if (j <= J.chest || j === J.l_clavicle || j === J.r_clavicle) return 'torso';
    if (j >= J.l_upper_arm && j <= J.l_forearm) return 'l_arm';
    if (j === J.l_hand) return 'l_hand';
    if (j >= J.r_upper_arm && j <= J.r_forearm) return 'r_arm';
    if (j === J.r_hand) return 'r_hand';
    if (j === J.l_thigh || j === J.l_calf) return 'l_leg';
    if (j === J.r_thigh || j === J.r_calf) return 'r_leg';
    if (j === J.l_foot || j === J.l_toes) return 'l_foot';
    return 'r_foot';
  };
  const scored = new Array<{ j: number; w: number }>(JOINT_COUNT);
  for (let v = 0; v < vcount; v++) {
    const px = positions[v * 3]!,
      py = positions[v * 3 + 1]!,
      pz = positions[v * 3 + 2]!;
    for (const b of bones) {
      const d = segDist(px, py, pz, b.a, b.b).d;
      scored[b.joint] = { j: b.joint, w: 1 / Math.pow(d + 0.012, 4) };
    }
    const top = scored.slice().sort((p, q) => q.w - p.w).slice(0, 4);
    const sum = top.reduce((s, e) => s + e.w, 0);
    for (let k = 0; k < 4; k++) {
      skinIndices[v * 4 + k] = top[k]!.j;
      skinWeights[v * 4 + k] = top[k]!.w / sum;
    }
    regions[v] = BODY_REGIONS.indexOf(regionOfJoint(top[0]!.j));
  }
  const capsule = (name: string, a: number, b: number, r: number): CapsuleCollider => ({
    name,
    jointA: a,
    jointB: b,
    offsetA: [0, 0, 0],
    offsetB: [0, 0, 0],
    radius: r,
  });
  const colliders: CapsuleCollider[] = [
    capsule('torso', J.pelvis, J.chest, wChest * 0.9),
    capsule('l_arm', J.l_upper_arm, J.l_forearm, armR),
    capsule('r_arm', J.r_upper_arm, J.r_forearm, armR),
    capsule('l_leg', J.l_thigh, J.l_calf, m.thighCm / 100 / (2 * Math.PI)),
    capsule('r_leg', J.r_thigh, J.r_calf, m.thighCm / 100 / (2 * Math.PI)),
  ];
  const skel: RestSkeleton = skeleton;
  return {
    measurements: m,
    skeleton: skel,
    mesh: { positions, normals, indices, skinIndices, skinWeights },
    regions,
    colliders,
  };
}
