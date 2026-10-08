import { J, REST_BONE_DIRECTIONS, type Vec3 } from '@fitroom/shared';
import { BIG, clampN, ellipsePerimeter, smax, smin } from './geom.js';
import {
  Ellipsoid,
  Loft,
  Tube,
  type LoftRing,
  type Prim,
  type TubeProfilePoint,
  type TubeSpec,
} from './prims.js';
import { ellipseSideRadius, type BodyDims, type Calibration } from './dims.js';

/** Índices de primitivas por nombre (para la mezcla y para los pesos de piel). */
interface Index {
  torso: number;
  bustL: number;
  bustR: number;
  gluteL: number;
  gluteR: number;
  neck: number;
  head: number;
  jaw: number;
  claviL: number;
  claviR: number;
  upperL: number;
  foreL: number;
  handL: number;
  thumbL: number;
  upperR: number;
  foreR: number;
  handR: number;
  thumbR: number;
  thighL: number;
  calfL: number;
  footL: number;
  toesL: number;
  thighR: number;
  calfR: number;
  footR: number;
  toesR: number;
}

/** Radios de mezcla (m) de las uniones suaves. */
const K = {
  bust: 0.045,
  glute: 0.05,
  neck: 0.03,
  jaw: 0.03,
  jawNeck: 0.025,
  shoulder: 0.03,
  clavi: 0.025,
  armpit: 0.03,
  elbow: 0.012,
  wrist: 0.01,
  thumb: 0.012,
  groin: 0.035,
  legs: 0.012,
  knee: 0.015,
  ankle: 0.012,
  foot: 0.01,
  floor: 0.006,
};

const PAD = 0.12;

const G_BUST = 1 << 1;
const G_GLUTE = 1 << 2;
const G_HEAD = 1 << 3;
const G_CLAVI = 1 << 4;
const G_ARM_L = 1 << 5;
const G_ARM_R = 1 << 6;
const G_LEG_L = 1 << 7;
const G_LEG_R = 1 << 8;
const ALL_GROUPS = 0x1ff;

export interface FieldBuild {
  readonly field: BodyField;
}

export class BodyField {
  readonly prims: Prim[];
  readonly ix: Index;
  readonly d: Float64Array;
  readonly bounds: Float64Array;
  readonly dims: BodyDims;
  readonly loft: Loft;
  readonly tubes: Map<string, Tube>;

  constructor(
    dims: BodyDims,
    prims: Prim[],
    ix: Index,
    loft: Loft,
    tubes: Map<string, Tube>,
  ) {
    this.dims = dims;
    this.prims = prims;
    this.ix = ix;
    this.loft = loft;
    this.tubes = tubes;
    this.group = new Int8Array(prims.length);
    const gset = (i: number, g: number): void => {
      this.group[i] = g;
    };
    gset(ix.torso, 0);
    gset(ix.bustL, 1);
    gset(ix.bustR, 1);
    gset(ix.gluteL, 2);
    gset(ix.gluteR, 2);
    gset(ix.head, 3);
    gset(ix.jaw, 3);
    gset(ix.neck, 3);
    gset(ix.claviL, 4);
    gset(ix.claviR, 4);
    for (const i of [ix.upperL, ix.foreL, ix.handL, ix.thumbL]) gset(i, 5);
    for (const i of [ix.upperR, ix.foreR, ix.handR, ix.thumbR]) gset(i, 6);
    for (const i of [ix.thighL, ix.calfL, ix.footL, ix.toesL]) gset(i, 7);
    for (const i of [ix.thighR, ix.calfR, ix.footR, ix.toesR]) gset(i, 8);
    this.d = new Float64Array(prims.length).fill(BIG);
    this.scratch = new Float64Array(prims.length);
    this.bounds = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    for (const p of prims) {
      for (let k = 0; k < 3; k++) {
        this.bounds[k] = Math.min(this.bounds[k]!, p.box[k]!);
        this.bounds[k + 3] = Math.max(this.bounds[k + 3]!, p.box[k + 3]!);
      }
    }
  }

  /** Evalúa cada primitiva (BIG si el punto cae fuera de su caja inflada). */
  evalPrims(x: number, y: number, z: number, d: Float64Array = this.scratch): Float64Array {
    const ps = this.prims;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]!;
      const b = p.box;
      d[i] =
        x >= b[0]! && x <= b[3]! && y >= b[1]! && y <= b[4]! && z >= b[2]! && z <= b[5]!
          ? p.dist(x, y, z)
          : BIG;
    }
    return d;
  }

  private active: Int32Array = new Int32Array(0);
  private activeN = 0;

  /** Lista de primitivas cuya caja corta el cubo [x0,x1]×[y0,y1]×[z0,z1] (inclusive), restringida a `from` si se da. */
  activeFor(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    from?: Int32Array,
    out: Int32Array = new Int32Array(this.prims.length),
  ): number {
    let n = 0;
    const cnt = from ? from.length : this.prims.length;
    for (let q = 0; q < cnt; q++) {
      const i = from ? from[q]! : q;
      const b = this.prims[i]!.box;
      if (x1 >= b[0]! && x0 <= b[3]! && y1 >= b[1]! && y0 <= b[4]! && z1 >= b[2]! && z0 <= b[5]!)
        out[n++] = i;
    }
    return n;
  }

  /** Fija la lista de primitivas activas (el resto vale BIG) para `valueActive`. */
  setActive(list: Int32Array, n: number, offset = 0): void {
    const d = this.d;
    for (let q = 0; q < this.activeN; q++) d[this.active[this.activeOff + q]!] = BIG;
    this.active = list;
    this.activeOff = offset;
    this.activeN = n;
    let mask = 0;
    for (let q = 0; q < n; q++) {
      const i = list[offset + q]!;
      d[i] = BIG;
      mask |= 1 << this.group[i]!;
    }
    this.activeMask = mask;
  }
  private activeOff = 0;

  /** Evalúa el campo sólo con las primitivas de la lista activa (equivale a `value` si la lista es un superconjunto). */
  valueActive(x: number, y: number, z: number): number {
    const d = this.d;
    const ps = this.prims;
    const a = this.active;
    const off = this.activeOff;
    const n = this.activeN;
    if (n === 1) {
      const i = a[off]!;
      const v = ps[i]!.dist(x, y, z);
      d[i] = v;
      // identidad bajo smin con BIG, salvo la intersección con el suelo
      return smax(v, -y, K.floor);
    }
    for (let q = 0; q < n; q++) {
      const i = a[off + q]!;
      d[i] = ps[i]!.dist(x, y, z);
    }
    return this.combine(d, y, this.activeMask);
  }

  /** Grupo de mezcla de cada primitiva (para saltarse subárboles inactivos). */
  private readonly group: Int8Array;
  private activeMask = ALL_GROUPS;

  /**
   * Mezcla las distancias de las primitivas con uniones suaves simétricas. `mask` indica qué grupos pueden tener
   * primitivas activas (los demás valen BIG y se omiten sin cambiar el resultado).
   */
  combine(d: Float64Array, y: number, mask = ALL_GROUPS): number {
    const ix = this.ix;
    let t = d[ix.torso]!;
    if (mask & G_BUST) t = smin(t, Math.min(d[ix.bustL]!, d[ix.bustR]!), K.bust);
    if (mask & G_GLUTE) t = smin(t, Math.min(d[ix.gluteL]!, d[ix.gluteR]!), K.glute);
    if (mask & G_HEAD)
      t = smin(t, smin(smin(d[ix.head]!, d[ix.jaw]!, K.jaw), d[ix.neck]!, K.jawNeck), K.neck);
    if (mask & G_CLAVI) t = smin(t, Math.min(d[ix.claviL]!, d[ix.claviR]!), K.clavi);
    if (mask & (G_ARM_L | G_ARM_R)) {
      let arms = BIG;
      if (mask & G_ARM_L) {
        arms = smin(
          smin(smin(d[ix.upperL]!, d[ix.foreL]!, K.elbow), d[ix.handL]!, K.wrist),
          d[ix.thumbL]!,
          K.thumb,
        );
      }
      if (mask & G_ARM_R) {
        arms = Math.min(
          arms,
          smin(
            smin(smin(d[ix.upperR]!, d[ix.foreR]!, K.elbow), d[ix.handR]!, K.wrist),
            d[ix.thumbR]!,
            K.thumb,
          ),
        );
      }
      t = smin(t, arms, K.armpit);
    }
    if (mask & (G_LEG_L | G_LEG_R)) {
      let legs = BIG;
      if (mask & G_LEG_L) {
        legs = smin(
          smin(d[ix.thighL]!, d[ix.calfL]!, K.knee),
          smin(d[ix.footL]!, d[ix.toesL]!, K.foot),
          K.ankle,
        );
      }
      if (mask & G_LEG_R) {
        const legR = smin(
          smin(d[ix.thighR]!, d[ix.calfR]!, K.knee),
          smin(d[ix.footR]!, d[ix.toesR]!, K.foot),
          K.ankle,
        );
        legs = mask & G_LEG_L ? smin(legs, legR, K.legs) : legR;
      }
      t = smin(t, legs, K.groin);
    }
    return smax(t, -y, K.floor);
  }

  private readonly scratch: Float64Array;

  value(x: number, y: number, z: number): number {
    this.evalPrims(x, y, z, this.scratch);
    return this.combine(this.scratch, y);
  }
}

function tube(
  list: Prim[],
  tubes: Map<string, Tube>,
  spec: Omit<TubeSpec, 'pad'>,
  pad = PAD,
): number {
  const t = new Tube({ ...spec, pad });
  list.push(t);
  tubes.set(spec.name, t);
  return list.length - 1;
}

const add3 = (a: Vec3, b: Vec3, s = 1): [number, number, number] => [
  a[0] + b[0] * s,
  a[1] + b[1] * s,
  a[2] + b[2] * s,
];

/** Construye el campo de distancia del cuerpo para unas dimensiones y una calibración dadas. */
export function buildField(dims: BodyDims, cal: Calibration): BodyField {
  const { H, P, lm, s, m } = dims;
  const prims: Prim[] = [];
  const tubes = new Map<string, Tube>();
  const pt = (t: number, rF: number, rS: number, off = 0, offS = 0): TubeProfilePoint => ({
    t,
    rF,
    rS,
    off,
    offS,
  });

  // ---------------------------------------------------------------- tronco
  const ring = (C: number, aspect: number, delta: number, mult: number) => {
    // perímetro de dos semielipses (delantera y trasera) de semieje lateral 1
    const p1 =
      0.5 * ellipsePerimeter(1, aspect * (1 + delta)) + 0.5 * ellipsePerimeter(1, aspect * (1 - delta));
    const a = (C * mult) / p1;
    return { a, bF: a * aspect * (1 + delta), bB: a * aspect * (1 - delta) };
  };
  const rH = ring(dims.hipC, dims.aspectHip, -0.07, cal.hip);
  const rW = ring(dims.waistC, dims.aspectWaist, 0.06 + 0.1 * dims.belly, cal.waist);
  const rC = ring(dims.chestC, dims.aspectChest, 0.1, cal.chest);
  const neckR = ellipseSideRadius(dims.neckC, 1) * cal.neck;
  const yCrotch = Math.min(lm.crotch + cal.crotchDy, lm.hip - 0.03);
  const rings: LoftRing[] = [
    { y: yCrotch - 0.004, a: 0.3 * rH.a, bF: 0.8 * rH.bF, bB: 0.7 * rH.bB },
    { y: yCrotch + 0.45 * (lm.hip - yCrotch), a: 0.72 * rH.a, bF: 0.96 * rH.bF, bB: 0.97 * rH.bB },
    { y: lm.hip, a: rH.a, bF: rH.bF, bB: rH.bB },
    { y: lm.waist, a: rW.a, bF: rW.bF, bB: rW.bB },
    { y: lm.chest, a: rC.a, bF: rC.bF, bB: rC.bB },
    { y: lm.chest + 0.052 * H, a: 0.93 * rC.a, bF: 0.9 * rC.bF, bB: 0.92 * rC.bB },
    {
      y: lm.shoulder,
      a: Math.min(0.85 * dims.halfShoulder, 0.9 * rC.a),
      bF: 0.62 * rC.bF,
      bB: 0.7 * rC.bB,
    },
    { y: P[J.neck]![1] + 0.004 * H, a: 0.8 * neckR + 0.01, bF: 0.8 * neckR, bB: 0.85 * neckR },
  ];
  const loft = new Loft({ rings, tau: 0.05, pad: PAD });
  prims.push(loft);

  // ---------------------------------------------------------------- busto / pectorales / glúteos
  const ix = {} as Index;
  const push = (p: Prim): number => {
    prims.push(p);
    return prims.length - 1;
  };
  ix.torso = 0;
  // Busto (constitución femenina) o pectoral (masculina): elipsoides parcialmente embebidos en el pecho.
  const bustAmt = dims.bust; // 0..1
  const pecAmt = clampN(0.5 + 0.5 * s, 0, 1) * (1 - 0.5 * bustAmt);
  const rx = 0.038 * H * (0.7 + 0.3 * bustAmt) + 0.014 * H * pecAmt;
  const ry = 0.04 * H * (0.6 + 0.4 * bustAmt) + 0.0 * H * pecAmt;
  const rz = 0.004 * H + 0.021 * H * bustAmt + 0.006 * H * pecAmt;
  const bustSpec = (name: string, sx: number) => ({
    name,
    bone: J.chest,
    c: [
      sx * (0.052 * H * (0.85 + 0.15 * bustAmt)),
      lm.chest - (0.004 * bustAmt - 0.008 * pecAmt) * H,
      rC.bF - 0.55 * rz,
    ] as const,
    r: [rx, ry, rz] as const,
    tau: 0.03,
    pad: PAD,
  });
  ix.bustL = push(new Ellipsoid(bustSpec('bust_l', 1)));
  ix.bustR = push(new Ellipsoid(bustSpec('bust_r', -1)));
  const gR = 0.036 * H * (0.7 + 0.45 * dims.glute);
  const gluteSpec = (name: string, sx: number) => ({
    name,
    bone: J.pelvis,
    c: [sx * (0.22 * rH.a + 0.015 * H), lm.hip - 0.012 * H, -(rH.bB - 0.5 * gR)] as const,
    r: [1.1 * gR, 0.95 * gR, 0.8 * gR] as const,
    tau: 0.03,
    pad: PAD,
  });
  ix.gluteL = push(new Ellipsoid(gluteSpec('glute_l', 1)));
  ix.gluteR = push(new Ellipsoid(gluteSpec('glute_r', -1)));

  // ---------------------------------------------------------------- cuello y cabeza
  const nb = P[J.neck]!;
  const hd = P[J.head]!;
  const nTop = hd[1] + 0.05 * H;
  ix.neck = tube(prims, tubes, {
    name: 'neck',
    bone: J.neck,
    a: [0, nb[1] - 0.03 * H, 0.0 * H],
    b: [0, nTop, 0.012 * H],
    ref: [0, 0, 1],
    profile: [
      pt(0, 1.45 * neckR, 1.45 * neckR),
      pt(0.3, 1.16 * neckR, 1.18 * neckR),
      pt(0.5, 1.03 * neckR, 1.05 * neckR),
      pt(0.75, 0.97 * neckR, 1.0 * neckR),
      pt(1, 0.97 * neckR, 1.0 * neckR),
    ],
    tau: 0.03,
  });
  const cRy = 0.062 * H;
  ix.head = push(
    new Ellipsoid({
      name: 'head',
      bone: J.head,
      c: [0, H - cRy, 0.002 * H],
      r: [0.0435 * H, cRy, 0.0565 * H],
      tau: 0.03,
      pad: PAD,
    }),
  );
  ix.jaw = push(
    new Ellipsoid({
      name: 'jaw',
      bone: J.head,
      c: [0, 0.903 * H, 0.016 * H],
      r: [0.034 * H, 0.038 * H, 0.043 * H],
      tau: 0.03,
      pad: PAD,
    }),
  );

  // ---------------------------------------------------------------- hombros y brazos
  for (const side of [1, -1] as const) {
    const L = side === 1;
    const jCl = L ? J.l_clavicle : J.r_clavicle;
    const jUa = L ? J.l_upper_arm : J.r_upper_arm;
    const jFa = L ? J.l_forearm : J.r_forearm;
    const jHa = L ? J.l_hand : J.r_hand;
    const sh = P[jUa]!;
    const el = P[jFa]!;
    const wr = P[jHa]!;
    const dirU = REST_BONE_DIRECTIONS[jUa]!;
    const dirF = REST_BONE_DIRECTIONS[jFa]!;
    const dirH = REST_BONE_DIRECTIONS[jHa]!;
    const handLen = dims.rest.joints[jHa]!.boneLength;
    const nm = L ? 'l' : 'r';
    // clavícula / trapecio
    const iCl = tube(prims, tubes, {
      name: `clavicle_${nm}`,
      bone: jCl,
      a: [side * 0.02 * H, 0.836 * H, 0.0],
      b: [sh[0], sh[1] - 0.01 * H, sh[2]],
      ref: [0, 0, 1],
      profile: [
        pt(0, 0.032 * H, 0.021 * H),
        pt(0.5, 0.035 * H, 0.0225 * H),
        pt(1, 0.036 * H, 0.024 * H),
      ],
      tau: 0.03,
    });
    // brazo
    const rB = dims.armR;
    const iU = tube(prims, tubes, {
      name: `upper_arm_${nm}`,
      bone: jUa,
      a: sh as [number, number, number],
      b: el as [number, number, number],
      ref: [0, 0, 1],
      profile: [
        pt(0, 0.66 * rB, 0.66 * rB),
        pt(0.12, 1.02 * rB, 1.0 * rB),
        pt(0.4, 1.04 * rB, 1.0 * rB, 0.04 * rB),
        pt(0.65, 0.98 * rB, 0.94 * rB, 0.04 * rB),
        pt(1, 0.84 * rB, 0.84 * rB),
      ],
      tau: 0.025,
    });
    const rW = dims.wristR;
    const iF = tube(prims, tubes, {
      name: `forearm_${nm}`,
      bone: jFa,
      a: el as [number, number, number],
      b: wr as [number, number, number],
      ref: [0, 0, 1],
      profile: [
        pt(0, 0.86 * rB, 0.86 * rB),
        pt(0.18, 0.9 * rB, 0.88 * rB),
        pt(0.6, Math.max(0.7 * rB, 1.35 * rW), Math.max(0.66 * rB, 1.15 * rW)),
        pt(0.88, 1.2 * rW, 0.95 * rW),
        pt(1, 1.04 * rW, 0.84 * rW),
      ],
      tau: 0.025,
    });
    // mano (mitón) y pulgar
    const hb = 0.0245 * H; // semi-anchura de nudillos
    const iH = tube(prims, tubes, {
      name: `hand_${nm}`,
      bone: jHa,
      a: wr as [number, number, number],
      b: add3(wr, dirH, handLen),
      ref: [0, 0, 1],
      profile: [
        pt(0, 1.04 * rW, 0.84 * rW),
        pt(0.12, 1.5 * rW, 0.9 * rW),
        pt(0.4, hb, 0.0085 * H, 0),
        pt(0.7, 0.88 * hb, 0.0075 * H, 0),
        pt(1, 0.5 * hb, 0.0062 * H, 0),
      ],
      tau: 0.02,
    });
    const tb = add3(add3(wr, dirH, 0.025 * H), [0, 0, 1], 0.03 * H);
    const te = add3(add3(wr, dirH, 0.085 * H), [0, 0, 1], 0.045 * H);
    const iT = tube(prims, tubes, {
      name: `thumb_${nm}`,
      bone: jHa,
      a: tb,
      b: te,
      ref: [1, 0, 0],
      profile: [pt(0, 0.0088 * H, 0.0085 * H), pt(0.6, 0.0075 * H, 0.0072 * H), pt(1, 0.0062 * H, 0.0062 * H)],
      tau: 0.015,
    });
    if (L) {
      ix.claviL = iCl;
      ix.upperL = iU;
      ix.foreL = iF;
      ix.handL = iH;
      ix.thumbL = iT;
    } else {
      ix.claviR = iCl;
      ix.upperR = iU;
      ix.foreR = iF;
      ix.handR = iH;
      ix.thumbR = iT;
    }
  }

  // ---------------------------------------------------------------- piernas y pies
  const thighRs = ellipseSideRadius(dims.thighC * cal.thigh, 1.1);
  const thighRf = thighRs * 1.1;
  for (const side of [1, -1] as const) {
    const L = side === 1;
    const jT = L ? J.l_thigh : J.r_thigh;
    const jC = L ? J.l_calf : J.r_calf;
    const jF = L ? J.l_foot : J.r_foot;
    const jTo = L ? J.l_toes : J.r_toes;
    const hip = P[jT]!;
    const knee = P[jC]!;
    const ankle = P[jF]!;
    const nm = L ? 'l' : 'r';
    const thighLen = Math.hypot(knee[0] - hip[0], knee[1] - hip[1]);
    // t del anillo de medida del muslo
    const tThigh = clampN((hip[1] - lm.thigh) / thighLen, 0.05, 0.95);
    const kneeR = dims.kneeR;
    // Muslos gruesos: la sección se desplaza hacia fuera para que los dos muslos no se solapen en la entrepierna
    // (el hueso queda donde dicta el esqueleto; sólo cambia la piel). e2 = −x para ambos muslos (eje hacia abajo).
    const xCrotch = Math.abs(hip[0] + ((knee[0] - hip[0]) * (hip[1] - lm.crotch)) / (hip[1] - knee[1]));
    const dShift = clampN(0.011 + 0.9 * thighRs * 0.0 + thighRs * 0.97 - xCrotch, 0, 0.06);
    const outward = side === 1 ? -1 : 1; // signo de e2 que lleva hacia fuera
    const sh = (t: number): number => outward * dShift * t;
    const iT = tube(prims, tubes, {
      name: `thigh_${nm}`,
      bone: jT,
      a: hip as [number, number, number],
      b: knee as [number, number, number],
      ref: [0, 0, 1],
      profile: [
        pt(0, 0.82 * thighRf, 0.78 * thighRs, 0, sh(0.35)),
        pt(0.14, 0.93 * thighRf, 0.88 * thighRs, 0, sh(0.8)),
        pt(Math.max(tThigh - 0.1, 0.22), 0.98 * thighRf, 0.95 * thighRs, 0, sh(1)),
        pt(tThigh, thighRf, thighRs, 0, sh(1)),
        pt(0.75, 0.8 * thighRf, 0.76 * thighRs, 0, sh(0.45)),
        pt(1, 1.0 * kneeR, 0.95 * kneeR, 0, 0),
      ],
      tau: 0.014,
    });
    const cR = dims.calfR;
    const aR = dims.ankleR;
    const iC = tube(prims, tubes, {
      name: `calf_${nm}`,
      bone: jC,
      a: knee as [number, number, number],
      b: ankle as [number, number, number],
      ref: [0, 0, 1],
      profile: [
        pt(0, 1.0 * kneeR, 0.95 * kneeR),
        pt(0.2, 1.0 * cR, 0.96 * cR, -0.16 * cR),
        pt(0.55, 0.74 * cR, 0.72 * cR, -0.1 * cR),
        pt(0.9, 1.08 * aR, 1.0 * aR),
        pt(1, 1.05 * aR, 1.0 * aR),
      ],
      tau: 0.014,
    });
    const fx = ankle[0];
    const toeJ = P[jTo]!;
    const footA: [number, number, number] = [fx, 0.03 * H, -0.0075 * H];
    const footB: [number, number, number] = [fx, 0.0105 * H, toeJ[2]];
    const iFoot = tube(prims, tubes, {
      name: `foot_${nm}`,
      bone: jF,
      a: footA,
      b: footB,
      ref: [0, 1, 0],
      profile: [
        pt(0, 0.03 * H, 0.0175 * H),
        pt(0.15, 0.0305 * H, 0.02 * H),
        pt(0.4, 0.027 * H, 0.0225 * H, 0.001 * H),
        pt(0.7, 0.019 * H, 0.0255 * H),
        pt(1, 0.0112 * H, 0.0275 * H),
      ],
      tau: 0.014,
    });
    const iToes = tube(prims, tubes, {
      name: `toes_${nm}`,
      bone: jTo,
      a: [fx, 0.0105 * H, toeJ[2]],
      b: [fx, 0.0095 * H, 0.1185 * H],
      ref: [0, 1, 0],
      profile: [pt(0, 0.0112 * H, 0.0275 * H), pt(0.6, 0.0102 * H, 0.0235 * H), pt(1, 0.0085 * H, 0.0165 * H)],
      tau: 0.01,
    });
    if (L) {
      ix.thighL = iT;
      ix.calfL = iC;
      ix.footL = iFoot;
      ix.toesL = iToes;
    } else {
      ix.thighR = iT;
      ix.calfR = iC;
      ix.footR = iFoot;
      ix.toesR = iToes;
    }
  }
  void s;
  void m;
  return new BodyField(dims, prims, ix, loft, tubes);
}
