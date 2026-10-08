import { J, REST_BONE_DIRECTIONS } from '@fitroom/shared';
import { rayExit, type BodyField } from './bodyField.js';
import {
  bodyRadii,
  convexHull2D,
  hullRadii,
  makeFrame,
  radiiToPoints,
  smoothCircular,
  perimeter2D,
} from './ring.js';

/**
 * Cortes horizontales del cuerpo (tronco/pelvis): por cada altura el centro z y los radios polares del cuerpo y de su
 * envolvente convexa (ángulo 0 = espalda (−z), π/2 = lado izquierdo (+x), π = frente (+z)).
 * Se muestrean cada `step` m y se interpola linealmente (más suave y barato que un corte por fila).
 */
export interface TorsoSlice {
  readonly y: number;
  readonly zc: number;
  /** radios del cuerpo (K) */
  readonly body: Float64Array;
  /** radios de la envolvente convexa (K) */
  readonly hull: Float64Array;
  readonly pBody: number;
  readonly pHull: number;
}

export class TorsoSlices {
  private readonly cache = new Map<number, TorsoSlice>();
  constructor(
    readonly field: BodyField,
    readonly K: number,
    readonly step = 0.015,
    readonly rmax = 0.34,
  ) {}

  /**
   * Bajo la entrepierna el centro (x=0) queda fuera del cuerpo: el «contorno» es la envolvente convexa de las dos piernas
   * (la prenda las abarca a ambas), medido desde el centro entre ellas.
   */
  private computeLegs(y: number): TorsoSlice {
    const g = this.field.sdf;
    const sk = this.field.body.skeleton;
    const pts: number[] = [];
    let zSum = 0;
    for (const side of [1, -1] as const) {
      const th = side === 1 ? J.l_thigh : J.r_thigh;
      const ca = side === 1 ? J.l_calf : J.r_calf;
      const p0 = sk.joints[th]!.position;
      const d = REST_BONE_DIRECTIONS[th]!;
      const t = (y - p0[1]) / d[1];
      let cx = p0[0] + d[0] * t;
      void ca;
      let cz = 0;
      for (let it = 0; it < 2; it++) {
        const tf = rayExit(g, cx, y, cz, 0, 0, 1, 0.3);
        const tb = rayExit(g, cx, y, cz, 0, 0, -1, 0.3);
        if (!Number.isNaN(tf) && !Number.isNaN(tb)) cz += (tf - tb) / 2;
        const tl = rayExit(g, cx, y, cz, side, 0, 0, 0.3);
        const tm = rayExit(g, cx, y, cz, -side, 0, 0, 0.3);
        if (!Number.isNaN(tl) && !Number.isNaN(tm)) cx += side * (tl - tm) / 2;
      }
      zSum += cz;
      const fr = makeFrame([cx, y, cz], [0, 0, -1], [1, 0, 0]);
      const r = smoothCircular(bodyRadii(this.field, fr, 48, 0.2, 0.03), 1, 0.2);
      for (let i = 0; i < 48; i++) {
        const a = (2 * Math.PI * i) / 48;
        // (u=-z, v=+x): punto absoluto en (a=-z, b=x)
        pts.push(-(cz) + r[i]! * Math.cos(a), cx + r[i]! * Math.sin(a));
      }
    }
    const zc = zSum / 2;
    // puntos en coordenadas del anillo del tronco: a = -(z - zc), b = x
    const rel = new Float64Array(pts.length);
    for (let i = 0; i < pts.length; i += 2) {
      rel[i] = pts[i]! + zc;
      rel[i + 1] = pts[i + 1]!;
    }
    void convexHull2D;
    const hull = hullRadii(rel, this.K);
    const pHull = perimeter2D(radiiToPoints(hull));
    return { y, zc, body: hull, hull, pBody: pHull, pHull };
  }

  /** corte exacto a la altura (sin interpolar) */
  private compute(y: number): TorsoSlice {
    if (y < this.field.lm.yCrotch + 0.012) return this.computeLegs(y);
    const g = this.field.sdf;
    // centro z: punto medio entre salida trasera y delantera, en la línea x=0
    let zc = 0;
    for (let it = 0; it < 2; it++) {
      const tf = rayExit(g, 0, y, zc, 0, 0, 1, 0.3);
      const tb = rayExit(g, 0, y, zc, 0, 0, -1, 0.3);
      if (!Number.isNaN(tf) && !Number.isNaN(tb)) zc += (tf - tb) / 2;
    }
    const fr = makeFrame([0, y, zc], [0, 0, -1], [1, 0, 0]);
    const body = smoothCircular(bodyRadii(this.field, fr, this.K, this.rmax, 0.05), 1, 0.2);
    const pts = radiiToPoints(body);
    const hull = hullRadii(pts, this.K);
    // la envolvente nunca queda por dentro del cuerpo
    for (let i = 0; i < this.K; i++) if (hull[i]! < body[i]!) hull[i] = body[i]!;
    return {
      y,
      zc,
      body,
      hull,
      pBody: perimeter2D(pts),
      pHull: perimeter2D(radiiToPoints(hull)),
    };
  }

  at(y: number): TorsoSlice {
    const k = Math.round(y / this.step);
    let s = this.cache.get(k);
    if (!s) {
      s = this.compute(k * this.step);
      this.cache.set(k, s);
    }
    return s;
  }

  /** interpola linealmente entre los dos cortes que rodean a `y` */
  interp(y: number): TorsoSlice {
    const f = y / this.step;
    const k0 = Math.floor(f);
    const t = f - k0;
    const a = this.at(k0 * this.step),
      b = this.at((k0 + 1) * this.step);
    if (t < 1e-6) return a;
    const body = new Float64Array(this.K);
    const hull = new Float64Array(this.K);
    for (let i = 0; i < this.K; i++) {
      body[i] = a.body[i]! + (b.body[i]! - a.body[i]!) * t;
      hull[i] = a.hull[i]! + (b.hull[i]! - a.hull[i]!) * t;
    }
    return {
      y,
      zc: a.zc + (b.zc - a.zc) * t,
      body,
      hull,
      pBody: a.pBody + (b.pBody - a.pBody) * t,
      pHull: a.pHull + (b.pHull - a.pHull) * t,
    };
  }
}
