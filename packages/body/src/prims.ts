import { BIG, pchip, sampleTable } from './geom.js';

/**
 * Primitivas de campo de distancia aproximado (negativo dentro). Todas devuelven una estimación CONSERVADORA
 * de la distancia con signo (|d| <= distancia real aproximadamente), lo que permite saltarse zonas lejanas
 * al muestrear la rejilla y mezclar con uniones suaves sin artefactos.
 */

export interface Prim {
  readonly name: string;
  /** Índice de joint dominante (para pesos de skin). -1 = reparto especial (tronco). */
  readonly bone: number;
  /** Escala (m) de la transición de pesos de piel: más alto = reparto más suave con las primitivas vecinas. */
  readonly tau: number;
  /** Caja envolvente ya inflada por el margen de mezcla [minX,minY,minZ,maxX,maxY,maxZ]. */
  readonly box: Float64Array;
  dist(x: number, y: number, z: number): number;
}

const TABLE_N = 48;

export interface TubeProfilePoint {
  /** Posición a lo largo del eje, 0..1 */
  readonly t: number;
  /** Semieje en la dirección «frontal» (m) */
  readonly rF: number;
  /** Semieje lateral (m) */
  readonly rS: number;
  /** Desplazamiento de la sección en la dirección frontal (m) */
  readonly off?: number;
  /** Desplazamiento de la sección en la dirección lateral e2 = eje × frontal (m) */
  readonly offS?: number;
}

export interface TubeSpec {
  readonly name: string;
  readonly bone: number;
  readonly a: readonly [number, number, number];
  readonly b: readonly [number, number, number];
  /** Vector de referencia que define la dirección «frontal» de la sección (se ortogonaliza respecto al eje). */
  readonly ref: readonly [number, number, number];
  readonly profile: readonly TubeProfilePoint[];
  readonly tau: number;
  readonly pad: number;
}

/**
 * Cilindro generalizado: eje A→B, sección elíptica (rF, rS) y desplazamiento variables a lo largo del eje
 * (tablas PCHIP), con tapas elipsoidales en los extremos.
 */
export class Tube implements Prim {
  readonly name: string;
  readonly bone: number;
  readonly tau: number;
  readonly box = new Float64Array(6);
  private readonly ax: number;
  private readonly ay: number;
  private readonly az: number;
  private readonly ux: number;
  private readonly uy: number;
  private readonly uz: number;
  private readonly e1x: number;
  private readonly e1y: number;
  private readonly e1z: number;
  private readonly e2x: number;
  private readonly e2y: number;
  private readonly e2z: number;
  private readonly invL: number;
  readonly length: number;
  private readonly rF: Float64Array;
  private readonly rS: Float64Array;
  private readonly off: Float64Array;
  private readonly offS: Float64Array;
  private readonly kap: Float64Array;

  constructor(spec: TubeSpec) {
    this.name = spec.name;
    this.bone = spec.bone;
    this.tau = spec.tau;
    const [ax, ay, az] = spec.a;
    const dx = spec.b[0] - ax;
    const dy = spec.b[1] - ay;
    const dz = spec.b[2] - az;
    const L = Math.max(Math.hypot(dx, dy, dz), 1e-6);
    this.length = L;
    this.invL = 1 / L;
    this.ax = ax;
    this.ay = ay;
    this.az = az;
    const ux = dx / L;
    const uy = dy / L;
    const uz = dz / L;
    this.ux = ux;
    this.uy = uy;
    this.uz = uz;
    // e1 = ref ortogonalizado respecto al eje
    const dr = spec.ref[0] * ux + spec.ref[1] * uy + spec.ref[2] * uz;
    let fx = spec.ref[0] - dr * ux;
    let fy = spec.ref[1] - dr * uy;
    let fz = spec.ref[2] - dr * uz;
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl;
    fy /= fl;
    fz /= fl;
    this.e1x = fx;
    this.e1y = fy;
    this.e1z = fz;
    this.e2x = uy * fz - uz * fy;
    this.e2y = uz * fx - ux * fz;
    this.e2z = ux * fy - uy * fx;

    // nudos ordenados y estrictamente crecientes (separación mínima 1e-3)
    const prof: TubeProfilePoint[] = [];
    for (const p of [...spec.profile].sort((a, b) => a.t - b.t)) {
      if (prof.length > 0 && p.t - prof[prof.length - 1]!.t < 1e-3) continue;
      prof.push(p);
    }
    const ts = prof.map((p) => p.t);
    const fF = pchip(
      ts,
      prof.map((p) => p.rF),
    );
    const fS = pchip(
      ts,
      prof.map((p) => p.rS),
    );
    const fO = pchip(
      ts,
      prof.map((p) => p.off ?? 0),
    );
    const fOS = pchip(
      ts,
      prof.map((p) => p.offS ?? 0),
    );
    this.rF = sampleTable(fF, TABLE_N);
    this.rS = sampleTable(fS, TABLE_N);
    this.off = sampleTable(fO, TABLE_N);
    this.offS = sampleTable(fOS, TABLE_N);
    this.kap = new Float64Array(TABLE_N);
    const ds = L / (TABLE_N - 1);
    for (let i = 0; i < TABLE_N; i++) {
      const i0 = Math.max(i - 1, 0);
      const i1 = Math.min(i + 1, TABLE_N - 1);
      const m0 = Math.min(this.rF[i0]!, this.rS[i0]!);
      const m1 = Math.min(this.rF[i1]!, this.rS[i1]!);
      const slope = (m1 - m0) / ((i1 - i0) * ds);
      this.kap[i] = 1 / Math.sqrt(1 + slope * slope);
    }
    let rMax = 0;
    for (let i = 0; i < TABLE_N; i++) rMax = Math.max(rMax, this.rF[i]!, this.rS[i]!);
    // desplazamientos
    let offMax = 0;
    for (let i = 0; i < TABLE_N; i++)
      offMax = Math.max(offMax, Math.abs(this.off[i]!), Math.abs(this.offS[i]!));
    const r = rMax + offMax + spec.pad;
    this.box[0] = Math.min(ax, spec.b[0]) - r;
    this.box[1] = Math.min(ay, spec.b[1]) - r;
    this.box[2] = Math.min(az, spec.b[2]) - r;
    this.box[3] = Math.max(ax, spec.b[0]) + r;
    this.box[4] = Math.max(ay, spec.b[1]) + r;
    this.box[5] = Math.max(az, spec.b[2]) + r;
  }

  /** Radios (rF, rS, off) en t∈[0,1]. */
  radiiAt(t: number): [number, number, number] {
    const fi = Math.min(Math.max(t, 0), 1) * (TABLE_N - 1);
    let i = fi | 0;
    if (i >= TABLE_N - 1) i = TABLE_N - 2;
    const fr = fi - i;
    return [
      this.rF[i]! + (this.rF[i + 1]! - this.rF[i]!) * fr,
      this.rS[i]! + (this.rS[i + 1]! - this.rS[i]!) * fr,
      this.off[i]! + (this.off[i + 1]! - this.off[i]!) * fr,
    ];
  }

  dist(x: number, y: number, z: number): number {
    const dx = x - this.ax;
    const dy = y - this.ay;
    const dz = z - this.az;
    const s = dx * this.ux + dy * this.uy + dz * this.uz;
    let tt = s * this.invL;
    let e = 0;
    if (tt < 0) {
      e = s;
      tt = 0;
    } else if (tt > 1) {
      e = s - this.length;
      tt = 1;
    }
    const fi = tt * (TABLE_N - 1);
    let i = fi | 0;
    if (i >= TABLE_N - 1) i = TABLE_N - 2;
    const fr = fi - i;
    const rF = this.rF[i]! + (this.rF[i + 1]! - this.rF[i]!) * fr;
    const rS = this.rS[i]! + (this.rS[i + 1]! - this.rS[i]!) * fr;
    const of = this.off[i]! + (this.off[i + 1]! - this.off[i]!) * fr;
    const os = this.offS[i]! + (this.offS[i + 1]! - this.offS[i]!) * fr;
    const kp = this.kap[i]! + (this.kap[i + 1]! - this.kap[i]!) * fr;
    const f = dx * this.e1x + dy * this.e1y + dz * this.e1z - of;
    const sd = dx * this.e2x + dy * this.e2y + dz * this.e2z - os;
    const qf = f / rF;
    const qs = sd / rS;
    const rmin = rF < rS ? rF : rS;
    let rho2 = qf * qf + qs * qs;
    if (e !== 0) {
      const qe = e / rmin;
      rho2 += qe * qe;
      return (Math.sqrt(rho2) - 1) * rmin;
    }
    return (Math.sqrt(rho2) - 1) * rmin * kp;
  }
}

export interface EllipsoidSpec {
  readonly name: string;
  readonly bone: number;
  readonly c: readonly [number, number, number];
  readonly r: readonly [number, number, number];
  readonly tau: number;
  readonly pad: number;
}

/** Elipsoide alineado con los ejes (aproximación de distancia de I. Quilez). */
export class Ellipsoid implements Prim {
  readonly name: string;
  readonly bone: number;
  readonly tau: number;
  readonly box = new Float64Array(6);
  private readonly cx: number;
  private readonly cy: number;
  private readonly cz: number;
  private readonly rx: number;
  private readonly ry: number;
  private readonly rz: number;
  private readonly rmin: number;

  constructor(spec: EllipsoidSpec) {
    this.name = spec.name;
    this.bone = spec.bone;
    this.tau = spec.tau;
    [this.cx, this.cy, this.cz] = spec.c;
    [this.rx, this.ry, this.rz] = spec.r;
    this.rmin = Math.min(this.rx, this.ry, this.rz);
    this.box[0] = this.cx - this.rx - spec.pad;
    this.box[1] = this.cy - this.ry - spec.pad;
    this.box[2] = this.cz - this.rz - spec.pad;
    this.box[3] = this.cx + this.rx + spec.pad;
    this.box[4] = this.cy + this.ry + spec.pad;
    this.box[5] = this.cz + this.rz + spec.pad;
  }

  dist(x: number, y: number, z: number): number {
    const px = (x - this.cx) / this.rx;
    const py = (y - this.cy) / this.ry;
    const pz = (z - this.cz) / this.rz;
    const k0 = Math.sqrt(px * px + py * py + pz * pz);
    if (k0 < 1e-9) return -this.rmin;
    const qx = px / this.rx;
    const qy = py / this.ry;
    const qz = pz / this.rz;
    const k1 = Math.sqrt(qx * qx + qy * qy + qz * qz);
    const d = (k0 * (k0 - 1)) / k1;
    return d < -this.rmin ? -this.rmin : d;
  }
}

/** Anillo de control del tronco. */
export interface LoftRing {
  /** Altura (m) */
  readonly y: number;
  /** Semieje lateral (m) */
  readonly a: number;
  /** Semieje delantero (m) */
  readonly bF: number;
  /** Semieje trasero (m) */
  readonly bB: number;
  /** Reservado (el exponente de la superelipse es fijo, 2.5). */
  readonly n?: number;
}

export interface LoftSpec {
  readonly rings: readonly LoftRing[];
  readonly tau: number;
  readonly pad: number;
  /** Desplazamiento en z del centro de las secciones (m) */
  readonly zc?: number;
}

const LOFT_N = 128;

/**
 * Tronco: extrusión a lo largo de Y de secciones elípticas asimétricas (delante/detrás) cuyos semiejes
 * varían con la altura (PCHIP). Cerrado por tapas elipsoidales arriba y abajo. Permite fijar de forma exacta
 * las circunferencias de pecho/cintura/cadera.
 */
export class Loft implements Prim {
  readonly name = 'torso';
  readonly bone = -1;
  readonly tau: number;
  readonly box = new Float64Array(6);
  readonly yBot: number;
  readonly yTop: number;
  private readonly invDy: number;
  private readonly dy: number;
  private readonly A: Float64Array;
  private readonly BF: Float64Array;
  private readonly BB: Float64Array;
  private readonly zc: number;

  constructor(spec: LoftSpec) {
    this.tau = spec.tau;
    const r = spec.rings;
    this.yBot = r[0]!.y;
    this.yTop = r[r.length - 1]!.y;
    this.dy = (this.yTop - this.yBot) / (LOFT_N - 1);
    this.invDy = 1 / this.dy;
    this.zc = spec.zc ?? 0;
    const ys = r.map((p) => p.y);
    const build = (sel: (p: LoftRing) => number): Float64Array => {
      const f = pchip(
        ys,
        r.map((p) => sel(p)),
      );
      const t = new Float64Array(LOFT_N);
      for (let i = 0; i < LOFT_N; i++) t[i] = f(this.yBot + i * this.dy);
      return t;
    };
    this.A = build((p) => p.a);
    this.BF = build((p) => p.bF);
    this.BB = build((p) => p.bB);
    let aMax = 0;
    let bMax = 0;
    for (let i = 0; i < LOFT_N; i++) {
      aMax = Math.max(aMax, this.A[i]!);
      bMax = Math.max(bMax, this.BF[i]!, this.BB[i]!);
    }
    this.box[0] = -aMax - spec.pad;
    this.box[1] = this.yBot - Math.min(this.A[0]!, this.BF[0]!, this.BB[0]!) - spec.pad;
    this.box[2] = this.zc - bMax - spec.pad;
    this.box[3] = aMax + spec.pad;
    this.box[4] = this.yTop + Math.min(this.A[LOFT_N - 1]!, this.BF[LOFT_N - 1]!) + spec.pad;
    this.box[5] = this.zc + bMax + spec.pad;
  }

  /** Semiejes (a, bF, bB) a la altura y (con sujeción a los extremos). */
  axesAt(y: number): [number, number, number] {
    const fi = Math.min(Math.max((y - this.yBot) * this.invDy, 0), LOFT_N - 1.000001);
    const i = fi | 0;
    const fr = fi - i;
    return [
      this.A[i]! + (this.A[i + 1]! - this.A[i]!) * fr,
      this.BF[i]! + (this.BF[i + 1]! - this.BF[i]!) * fr,
      this.BB[i]! + (this.BB[i + 1]! - this.BB[i]!) * fr,
    ];
  }

  dist(x: number, y: number, z0: number): number {
    let yy = y;
    let e = 0;
    if (y < this.yBot) {
      yy = this.yBot;
      e = y - this.yBot;
    } else if (y > this.yTop) {
      yy = this.yTop;
      e = y - this.yTop;
    }
    const fi = Math.min((yy - this.yBot) * this.invDy, LOFT_N - 1.000001);
    const i = fi | 0;
    const fr = fi - i;
    const a = this.A[i]! + (this.A[i + 1]! - this.A[i]!) * fr;
    const bF = this.BF[i]! + (this.BF[i + 1]! - this.BF[i]!) * fr;
    const bB = this.BB[i]! + (this.BB[i + 1]! - this.BB[i]!) * fr;
    const z = z0 - this.zc;
    const b = z >= 0 ? bF : bB;
    const au = Math.abs(x) / a;
    const av = Math.abs(z) / b;
    // tapa: grosor axial = 0.6 · semieje menor
    const dmin = Math.min(a, bF, bB);
    const rc = 0.6 * dmin;
    const ae = e / rc;
    // Forma implícita P = u² + v² + e² (elipse en cada sección), distancia ≈ (P − 1) / |∇P|
    const P = au * au + av * av + ae * ae;
    const ia = i + 1 < LOFT_N ? i + 1 : i;
    const da = (this.A[ia]! - this.A[i]!) * this.invDy;
    const db = (z >= 0 ? this.BF[ia]! - this.BF[i]! : this.BB[ia]! - this.BB[i]!) * this.invDy;
    const gx = (2 * au) / a;
    const gz = (2 * av) / b;
    const gy = -(2 * au * au * da) / a - (2 * av * av * db) / b + (2 * ae) / rc;
    const gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
    let d = (P - 1) / Math.max(gl, 1 / dmin);
    if (d < -dmin) d = -dmin;
    return d;
  }
}

/** Mínimo con corte por caja: devuelve BIG si el punto cae fuera de la caja de la primitiva. */
export function insideBox(p: Prim, x: number, y: number, z: number): boolean {
  const b = p.box;
  return x >= b[0]! && x <= b[3]! && y >= b[1]! && y <= b[4]! && z >= b[2]! && z <= b[5]!;
}

export { BIG };
