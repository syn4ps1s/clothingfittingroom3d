import { closestPointTriangle } from './geom.js';

/**
 * Campo de distancia con signo (SDF) del cuerpo en una rejilla regular.
 * Negativo dentro de la piel, positivo fuera. Cerca de la superficie (banda de ~1.5 celdas) el valor es
 * EXACTO (punto-triángulo); más lejos se propaga por barrido chamfer (error <8 %, suficiente para empujar prendas).
 */
export interface SdfGrid {
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  readonly h: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly data: Float32Array;
}

export interface SdfBuildOptions {
  /** rondas de barrido chamfer (cada una = adelante + atrás) */
  readonly rounds?: number;
  /** tamaño de celda (m) */
  readonly cell?: number;
  /** margen alrededor de la caja del cuerpo (m) */
  readonly margin?: number;
}

export function buildSdfGrid(
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
  opts: SdfBuildOptions = {},
): SdfGrid {
  const h = opts.cell ?? 0.01;
  const margin = opts.margin ?? 0.14;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!,
      y = positions[i + 1]!,
      z = positions[i + 2]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const ox = minX - margin,
    oy = minY - margin,
    oz = minZ - margin;
  const nx = Math.ceil((maxX + margin - ox) / h) + 1;
  const ny = Math.ceil((maxY + margin - oy) / h) + 1;
  const nz = Math.ceil((maxZ + margin - oz) / h) + 1;
  const total = nx * ny * nz;
  const absd = new Float32Array(total).fill(1e9);
  const sgn = new Int8Array(total).fill(1);
  const band = 1.6 * h;
  const out = new Float64Array(6);
  const strideY = nx;
  const strideZ = nx * ny;
  const invH = 1 / h;

  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t]! * 3,
      ib = indices[t + 1]! * 3,
      ic = indices[t + 2]! * 3;
    const ax = positions[ia]!,
      ay = positions[ia + 1]!,
      az = positions[ia + 2]!;
    const bx = positions[ib]!,
      by = positions[ib + 1]!,
      bz = positions[ib + 2]!;
    const cx = positions[ic]!,
      cy = positions[ic + 1]!,
      cz = positions[ic + 2]!;
    // normal de la cara
    const e1x = bx - ax,
      e1y = by - ay,
      e1z = bz - az;
    const e2x = cx - ax,
      e2y = cy - ay,
      e2z = cz - az;
    let fnx = e1y * e2z - e1z * e2y;
    let fny = e1z * e2x - e1x * e2z;
    let fnz = e1x * e2y - e1y * e2x;
    const fl = Math.hypot(fnx, fny, fnz);
    if (fl < 1e-14) continue;
    fnx /= fl;
    fny /= fl;
    fnz /= fl;
    const x0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - band - ox) * invH));
    const x1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx, cx) + band - ox) * invH));
    const y0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - band - oy) * invH));
    const y1 = Math.min(ny - 1, Math.ceil((Math.max(ay, by, cy) + band - oy) * invH));
    const z0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - band - oz) * invH));
    const z1 = Math.min(nz - 1, Math.ceil((Math.max(az, bz, cz) + band - oz) * invH));
    for (let iz = z0; iz <= z1; iz++) {
      const pz = oz + iz * h;
      for (let iy = y0; iy <= y1; iy++) {
        const py = oy + iy * h;
        for (let ix = x0; ix <= x1; ix++) {
          const px = ox + ix * h;
          const dp = fnx * (px - ax) + fny * (py - ay) + fnz * (pz - az);
          if (dp > band || dp < -band) continue;
          const d2 = closestPointTriangle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, out);
          const vi = ix + iy * strideY + iz * strideZ;
          const d = Math.sqrt(d2);
          if (d < absd[vi]!) {
            absd[vi] = d;
            // signo con la normal suave interpolada en el punto más cercano
            const u = out[3]!,
              v = out[4]!,
              w = out[5]!;
            const nxs = u * normals[ia]! + v * normals[ib]! + w * normals[ic]!;
            const nys = u * normals[ia + 1]! + v * normals[ib + 1]! + w * normals[ic + 1]!;
            const nzs = u * normals[ia + 2]! + v * normals[ib + 2]! + w * normals[ic + 2]!;
            let s = (px - out[0]!) * nxs + (py - out[1]!) * nys + (pz - out[2]!) * nzs;
            if (Math.abs(s) < 1e-9 * (1 + d)) s = dp;
            sgn[vi] = s >= 0 ? 1 : -1;
          }
        }
      }
    }
  }

  // signo de los voxels NO sembrados: relleno desde el borde (exterior) sin cruzar la banda sembrada
  const seeded = new Uint8Array(total);
  for (let i = 0; i < total; i++) seeded[i] = absd[i]! < 1e8 ? 1 : 0;
  const outside = new Uint8Array(total);
  {
    const stack = new Int32Array(total);
    let sp = 0;
    const push = (i: number): void => {
      if (!seeded[i] && !outside[i]) {
        outside[i] = 1;
        stack[sp++] = i;
      }
    };
    for (let iz = 0; iz < nz; iz++)
      for (let iy = 0; iy < ny; iy++)
        for (let ix = 0; ix < nx; ix++) {
          if (ix === 0 || iy === 0 || iz === 0 || ix === nx - 1 || iy === ny - 1 || iz === nz - 1)
            push(ix + iy * strideY + iz * strideZ);
        }
    while (sp > 0) {
      const i = stack[--sp]!;
      const ix = i % nx;
      const iy = Math.floor(i / nx) % ny;
      const iz = Math.floor(i / strideZ);
      if (ix > 0) push(i - 1);
      if (ix < nx - 1) push(i + 1);
      if (iy > 0) push(i - strideY);
      if (iy < ny - 1) push(i + strideY);
      if (iz > 0) push(i - strideZ);
      if (iz < nz - 1) push(i + strideZ);
    }
  }
  // barrido chamfer (distancias 1, √2, √3) sobre la distancia ABSOLUTA (los semilleros no se modifican)
  const offs: number[] = [];
  const wts: number[] = [];
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        if (dz * 1e6 + dy * 1e3 + dx >= 0) continue;
        const nn = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
        offs.push(dx + dy * strideY + dz * strideZ);
        wts.push(h * (nn === 1 ? 1 : nn === 2 ? Math.SQRT2 : Math.sqrt(3)));
      }
  const o0 = offs[0]!, o1 = offs[1]!, o2 = offs[2]!, o3 = offs[3]!, o4 = offs[4]!, o5 = offs[5]!;
  const o6 = offs[6]!, o7 = offs[7]!, o8 = offs[8]!, o9 = offs[9]!, o10 = offs[10]!, o11 = offs[11]!, o12 = offs[12]!;
  const q0 = wts[0]!, q1 = wts[1]!, q2 = wts[2]!, q3 = wts[3]!, q4 = wts[4]!, q5 = wts[5]!;
  const q6 = wts[6]!, q7 = wts[7]!, q8 = wts[8]!, q9 = wts[9]!, q10 = wts[10]!, q11 = wts[11]!, q12 = wts[12]!;
  const rounds = opts.rounds ?? 1;
  for (let round = 0; round < rounds; round++) {
    for (let iz = 1; iz < nz - 1; iz++)
      for (let iy = 1; iy < ny - 1; iy++) {
        let vi = 1 + iy * strideY + iz * strideZ;
        for (let ix = 1; ix < nx - 1; ix++, vi++) {
          if (seeded[vi]) continue;
          let b = absd[vi]!;
          let c = absd[vi + o0]! + q0; if (c < b) b = c;
          c = absd[vi + o1]! + q1; if (c < b) b = c;
          c = absd[vi + o2]! + q2; if (c < b) b = c;
          c = absd[vi + o3]! + q3; if (c < b) b = c;
          c = absd[vi + o4]! + q4; if (c < b) b = c;
          c = absd[vi + o5]! + q5; if (c < b) b = c;
          c = absd[vi + o6]! + q6; if (c < b) b = c;
          c = absd[vi + o7]! + q7; if (c < b) b = c;
          c = absd[vi + o8]! + q8; if (c < b) b = c;
          c = absd[vi + o9]! + q9; if (c < b) b = c;
          c = absd[vi + o10]! + q10; if (c < b) b = c;
          c = absd[vi + o11]! + q11; if (c < b) b = c;
          c = absd[vi + o12]! + q12; if (c < b) b = c;
          absd[vi] = b;
        }
      }
    for (let iz = nz - 2; iz >= 1; iz--)
      for (let iy = ny - 2; iy >= 1; iy--) {
        let vi = nx - 2 + iy * strideY + iz * strideZ;
        for (let ix = nx - 2; ix >= 1; ix--, vi--) {
          if (seeded[vi]) continue;
          let b = absd[vi]!;
          let c = absd[vi - o0]! + q0; if (c < b) b = c;
          c = absd[vi - o1]! + q1; if (c < b) b = c;
          c = absd[vi - o2]! + q2; if (c < b) b = c;
          c = absd[vi - o3]! + q3; if (c < b) b = c;
          c = absd[vi - o4]! + q4; if (c < b) b = c;
          c = absd[vi - o5]! + q5; if (c < b) b = c;
          c = absd[vi - o6]! + q6; if (c < b) b = c;
          c = absd[vi - o7]! + q7; if (c < b) b = c;
          c = absd[vi - o8]! + q8; if (c < b) b = c;
          c = absd[vi - o9]! + q9; if (c < b) b = c;
          c = absd[vi - o10]! + q10; if (c < b) b = c;
          c = absd[vi - o11]! + q11; if (c < b) b = c;
          c = absd[vi - o12]! + q12; if (c < b) b = c;
          absd[vi] = b;
        }
      }
  }
  const data = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const a = absd[i]!;
    data[i] = seeded[i] ? a * sgn[i]! : outside[i] ? a : -a;
  }
  return { ox, oy, oz, h, nx, ny, nz, data };
}

/** Distancia con signo interpolada trilinealmente. Fuera de la rejilla suma la distancia a la caja. */
export function sampleSdf(g: SdfGrid, x: number, y: number, z: number): number {
  let fx = (x - g.ox) / g.h,
    fy = (y - g.oy) / g.h,
    fz = (z - g.oz) / g.h;
  let extra = 0;
  const mx = g.nx - 1.001,
    my = g.ny - 1.001,
    mz = g.nz - 1.001;
  if (fx < 0 || fy < 0 || fz < 0 || fx > mx || fy > my || fz > mz) {
    const cx = fx < 0 ? 0 : fx > mx ? mx : fx;
    const cy = fy < 0 ? 0 : fy > my ? my : fy;
    const cz = fz < 0 ? 0 : fz > mz ? mz : fz;
    extra = Math.hypot(fx - cx, fy - cy, fz - cz) * g.h;
    fx = cx;
    fy = cy;
    fz = cz;
  }
  const ix = Math.floor(fx),
    iy = Math.floor(fy),
    iz = Math.floor(fz);
  const tx = fx - ix,
    ty = fy - iy,
    tz = fz - iz;
  const sy = g.nx,
    sz = g.nx * g.ny;
  const i0 = ix + iy * sy + iz * sz;
  const d = g.data;
  const c000 = d[i0]!,
    c100 = d[i0 + 1]!,
    c010 = d[i0 + sy]!,
    c110 = d[i0 + sy + 1]!;
  const c001 = d[i0 + sz]!,
    c101 = d[i0 + sz + 1]!,
    c011 = d[i0 + sz + sy]!,
    c111 = d[i0 + sz + sy + 1]!;
  const c00 = c000 + (c100 - c000) * tx;
  const c10 = c010 + (c110 - c010) * tx;
  const c01 = c001 + (c101 - c001) * tx;
  const c11 = c011 + (c111 - c011) * tx;
  const c0 = c00 + (c10 - c00) * ty;
  const c1 = c01 + (c11 - c01) * ty;
  return c0 + (c1 - c0) * tz + extra;
}

/** SDF + gradiente (trilineal analítico). Devuelve la distancia; `grad` recibe el gradiente (no unitario). */
export function sampleSdfGrad(
  g: SdfGrid,
  x: number,
  y: number,
  z: number,
  grad: Float64Array,
): number {
  let fx = (x - g.ox) / g.h,
    fy = (y - g.oy) / g.h,
    fz = (z - g.oz) / g.h;
  let extra = 0;
  let ex = 0,
    ey = 0,
    ez = 0;
  const mx = g.nx - 1.001,
    my = g.ny - 1.001,
    mz = g.nz - 1.001;
  if (fx < 0 || fy < 0 || fz < 0 || fx > mx || fy > my || fz > mz) {
    const cx = fx < 0 ? 0 : fx > mx ? mx : fx;
    const cy = fy < 0 ? 0 : fy > my ? my : fy;
    const cz = fz < 0 ? 0 : fz > mz ? mz : fz;
    ex = fx - cx;
    ey = fy - cy;
    ez = fz - cz;
    extra = Math.hypot(ex, ey, ez) * g.h;
    fx = cx;
    fy = cy;
    fz = cz;
  }
  const ix = Math.floor(fx),
    iy = Math.floor(fy),
    iz = Math.floor(fz);
  const tx = fx - ix,
    ty = fy - iy,
    tz = fz - iz;
  const sy = g.nx,
    sz = g.nx * g.ny;
  const i0 = ix + iy * sy + iz * sz;
  const d = g.data;
  const c000 = d[i0]!,
    c100 = d[i0 + 1]!,
    c010 = d[i0 + sy]!,
    c110 = d[i0 + sy + 1]!;
  const c001 = d[i0 + sz]!,
    c101 = d[i0 + sz + 1]!,
    c011 = d[i0 + sz + sy]!,
    c111 = d[i0 + sz + sy + 1]!;
  const c00 = c000 + (c100 - c000) * tx;
  const c10 = c010 + (c110 - c010) * tx;
  const c01 = c001 + (c101 - c001) * tx;
  const c11 = c011 + (c111 - c011) * tx;
  const c0 = c00 + (c10 - c00) * ty;
  const c1 = c01 + (c11 - c01) * ty;
  const val = c0 + (c1 - c0) * tz;
  const inv = 1 / g.h;
  let gx = ((c100 - c000) * (1 - ty) * (1 - tz) + (c110 - c010) * ty * (1 - tz) + (c101 - c001) * (1 - ty) * tz + (c111 - c011) * ty * tz) * inv;
  let gy = ((c10 - c00) * (1 - tz) + (c11 - c01) * tz) * inv;
  const gz = (c1 - c0) * inv;
  if (extra > 0) {
    // fuera de la caja el gradiente apunta lejos de ella
    const l = Math.hypot(ex, ey, ez);
    gx = ex / l;
    gy = ey / l;
    grad[0] = gx;
    grad[1] = gy;
    grad[2] = ez / l;
    return val + extra;
  }
  grad[0] = gx;
  grad[1] = gy;
  grad[2] = gz;
  return val;
}
