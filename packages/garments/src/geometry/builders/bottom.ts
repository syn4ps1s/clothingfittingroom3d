import {
  J,
  REST_BONE_DIRECTIONS,
  type BodyModel,
  type GarmentDefinition,
  type GarmentFit,
  type GarmentSpec,
} from '@fitroom/shared';
import { rayExit, type BodyField } from '../core/bodyField.js';
import { GarmentMesh, newSurface, type Surface } from '../core/mesh.js';
import { TorsoSlices } from '../core/slices.js';
import {
  bodyRadiiAt,
  hullRadiiAt,
  offsetContour,
  perimeter2D,
  polarToPoints,
  radiiToPoints,
  solveOffsetForPerimeter,
} from '../core/ring.js';
import { clamp01, mix, smooth01 } from '../core/geom.js';
import { EASE_BY_FIT, bodyOf, cm, fabricHintFor, param } from '../plan.js';

export interface BottomPlan {
  K: number;
  e: number;
  T: number;
  clear: number;
  /** altura de la cintura en el centro delantero (borde superior de la cinturilla) */
  yWaist: number;
  /** elevación extra de la cintura en la espalda */
  backRise: number;
  yCrotch: number;
  ySplit: number;
  yHem: number;
  waistC: number;
  hipC: number;
  thighC: number;
  kneeC: number;
  openC: number;
  /** altura de la cadera (m) donde se mide hipC */
  yHip: number;
  waistbandH: number;
  fit: GarmentFit;
  /** pantalón corto: la pernera acaba antes de la rodilla */
  kind: 'long' | 'shorts';
}

export interface BottomBuild {
  plan: BottomPlan;
  hip: Surface;
  legs: Surface[];
  rowSplit: number;
}

const OPEN_BY_FIT: Record<GarmentFit, number> = { slim: 0.31, regular: 0.37, relaxed: 0.42, oversized: 0.5 };

export function planBottom(def: GarmentDefinition, spec: GarmentSpec, body: BodyModel, field: BodyField): BottomPlan {
  const B = bodyOf(body);
  const lm = field.lm;
  const fit = def.fit;
  const T = fabricHintFor(def.fabricId).thickness;
  const clear = T / 2 + 0.001;
  const e = param(def, 'edgeMm', 7.5) / 1000;
  const ease = EASE_BY_FIT[fit];
  const waistC = cm(spec.waistCm, B.waist + ease * 0.6);
  const hipC = cm(spec.hipCm, B.hip + ease * 0.85);
  const thighC = cm(spec.thighCm, B.thigh + ease * 0.45);
  const shorts = def.template === 'shorts';
  const openC = cm(spec.legOpeningCm, shorts ? thighC * 0.95 : OPEN_BY_FIT[fit]);
  const rise = cm(spec.riseCm, 0.26 * (B.H / 1.78));
  const yCrotch = lm.yCrotch - (fit === 'slim' ? 0.005 : fit === 'regular' ? 0.012 : fit === 'relaxed' ? 0.03 : 0.045);
  const inseam = cm(spec.inseamCm, shorts ? 0.15 : Math.max(0.3, B.inseam - 0.045));
  const yHem = yCrotch - inseam;
  const yWaist = yCrotch + rise;
  const kneeC = mix(thighC, openC, shorts ? 0.3 : 0.55) * (fit === 'slim' ? 0.97 : 1);
  const depthU = 0.055;
  const K = Math.max(120, Math.ceil(Math.max(hipC, waistC) / e / 8) * 8);
  return {
    K,
    e,
    T,
    clear,
    yWaist,
    backRise: 0.03,
    yCrotch,
    ySplit: yCrotch + depthU,
    yHem,
    waistC,
    hipC,
    thighC,
    kneeC,
    openC,
    yHip: Math.min(lm.yHip, yWaist - 0.08),
    waistbandH: param(def, 'waistbandCm', 3.8) / 100,
    fit,
    kind: shorts ? 'shorts' : 'long',
  };
}

type V3 = [number, number, number];

/** Anillos de la pierna (planos horizontales) en los ángulos (no uniformes) del anillo 0. */
class LegRings {
  private readonly cache = new Map<number, Float64Array>();
  readonly step = 0.02;
  constructor(
    private readonly field: BodyField,
    readonly side: 1 | -1,
    private readonly angles: Float64Array,
  ) {}
  axis(y: number): { x: number; z: number } {
    const sk = this.field.body.skeleton;
    const th = this.side === 1 ? J.l_thigh : J.r_thigh;
    const ca = this.side === 1 ? J.l_calf : J.r_calf;
    const p0 = sk.joints[th]!.position;
    const pk = sk.joints[ca]!.position;
    const pf = sk.joints[this.side === 1 ? J.l_foot : J.r_foot]!.position;
    if (y > pk[1]) {
      const t = (p0[1] - y) / (p0[1] - pk[1]);
      return { x: p0[0] + (pk[0] - p0[0]) * t, z: p0[2] + (pk[2] - p0[2]) * t };
    }
    const t = (pk[1] - y) / (pk[1] - pf[1]);
    return { x: pk[0] + (pf[0] - pk[0]) * t, z: pk[2] + (pf[2] - pk[2]) * t };
  }
  center(y: number): { cx: number; cz: number } {
    const k = Math.round(y / this.step);
    const a = this.axis(y);
    // centra en z con rayos ±z
    let cz = a.z,
      cx = a.x;
    const g = this.field.sdf;
    for (let it = 0; it < 2; it++) {
      const tf = rayExit(g, cx, y, cz, 0, 0, 1, 0.2);
      const tb = rayExit(g, cx, y, cz, 0, 0, -1, 0.2);
      if (!Number.isNaN(tf) && !Number.isNaN(tb)) cz += (tf - tb) / 2;
      const tl = rayExit(g, cx, y, cz, 1, 0, 0, 0.2);
      const tm = rayExit(g, cx, y, cz, -1, 0, 0, 0.2);
      if (!Number.isNaN(tl) && !Number.isNaN(tm)) {
        const shift = (tl - tm) / 2;
        // el lado interior puede estar fusionado con la otra pierna: sólo se corrige si es plausible
        if (Math.abs(shift) < 0.02) cx += shift;
      }
    }
    void k;
    return { cx, cz };
  }
  /** radios de la envolvente convexa de la pierna a la altura y (interpolados en cortes cada `step`) */
  hullAt(y: number): { r: Float64Array; cx: number; cz: number } {
    const f = y / this.step;
    const k0 = Math.floor(f);
    const t = f - k0;
    const a = this.key(k0);
    const ca = this.center(k0 * this.step);
    if (t < 1e-6) return { r: a, cx: ca.cx, cz: ca.cz };
    const b = this.key(k0 + 1);
    const cb = this.center((k0 + 1) * this.step);
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i]! + (b[i]! - a[i]!) * t;
    return { r: out, cx: ca.cx + (cb.cx - ca.cx) * t, cz: ca.cz + (cb.cz - ca.cz) * t };
  }
  private key(k: number): Float64Array {
    let r = this.cache.get(k);
    if (r) return r;
    const y = k * this.step;
    const c = this.center(y);
    const fr = { cx: c.cx, cy: y, cz: c.cz, ux: 0, uy: 0, uz: -1, vx: 1, vy: 0, vz: 0 };
    const raw = bodyRadiiAt(this.field, fr, this.angles, 0.16, 0.025);
    const sorted = Array.from(raw).sort((x, y2) => x - y2);
    const med = sorted[sorted.length >> 1]!;
    for (let i = 0; i < raw.length; i++) if (raw[i]! > 1.5 * med) raw[i] = 1.5 * med;
    const pts = polarToPoints(raw, this.angles);
    r = hullRadiiAt(pts, this.angles);
    for (let i = 0; i < r.length; i++) if (r[i]! < raw[i]!) r[i] = raw[i]!;
    this.cache.set(k, r);
    return r;
  }
}

/** Pantalón: tubo de cadera (cintura→entrepierna) que se divide en dos perneras con la curva de tiro compartida. */
export function buildBottom(
  def: GarmentDefinition,
  spec: GarmentSpec,
  body: BodyModel,
  field: BodyField,
  mesh: GarmentMesh,
  plan: BottomPlan,
): BottomBuild {
  const { K, e, clear, T } = plan;
  void spec;
  void def;
  const slices = new TorsoSlices(field, K);
  const tmp = new Float64Array(K * 2);
  const nH = Math.max(10, Math.ceil((plan.yWaist - plan.ySplit) / e));
  const rows = nH + 1;
  const hip = newSurface('hip', rows, K + 1, { wrap: true });
  const sk = body.skeleton;
  void sk;

  const hipHullP = (y: number): number => slices.interp(y).pHull;
  const easeHip = Math.max(clear, (plan.hipC - hipHullP(plan.yHip)) / (2 * Math.PI));
  const easeSplit = Math.max(clear, easeHip * 0.8);
  const targetAt = (y: number): { abs?: number; ease?: number } => {
    if (y >= plan.yHip) {
      const t = smooth01((y - plan.yHip) / Math.max(0.03, plan.yWaist - plan.yHip));
      return { abs: mix(plan.hipC, plan.waistC, t) };
    }
    const t = smooth01((plan.yHip - y) / Math.max(0.03, plan.yHip - plan.ySplit));
    return { ease: mix(easeHip, easeSplit, t) };
  };
  const ringAt = (y: number): { pts: Float64Array; zc: number } => {
    const sc = slices.interp(y);
    const tg = targetAt(y);
    const base = tg.abs !== undefined ? tg.abs : sc.pHull + 2 * Math.PI * tg.ease!;
    const tgt = Math.max(base, sc.pBody + 2 * Math.PI * clear);
    const h = clamp01(1 - (tgt - sc.pBody) / Math.max(1e-6, sc.pHull - sc.pBody));
    const m = new Float64Array(K);
    for (let i = 0; i < K; i++) m[i] = mix(sc.hull[i]!, sc.body[i]!, h);
    const pts = radiiToPoints(m);
    const pm = perimeter2D(pts);
    const t2 = Math.max(tgt, pm + 2 * Math.PI * clear);
    const eo = solveOffsetForPerimeter(pts, t2, tmp);
    return { pts: offsetContour(pts, eo, new Float64Array(K * 2)), zc: sc.zc };
  };

  // altura de cintura por columna: más alta en la espalda
  const waistDy = (i: number): number => {
    const th = (2 * Math.PI * i) / K;
    const back = Math.max(0, Math.cos(th)); // espalda = 1
    return plan.backRise * Math.pow(back, 1.5) + 0.006 * Math.abs(Math.sin(th)) * (1 - back);
  };
  const hipPos: V3[][] = [];
  for (let r = 0; r <= nH; r++) {
    const y = mix(plan.yWaist, plan.ySplit, r / nH);
    const ring = ringAt(y);
    const fade = smooth01((y - plan.yHip) / Math.max(0.04, plan.yWaist - plan.yHip));
    const row: V3[] = [];
    for (let i = 0; i < K; i++) {
      const dy = waistDy(i) * fade;
      row.push([ring.pts[i * 2 + 1]!, y + dy, ring.zc - ring.pts[i * 2]!]);
    }
    hipPos.push(row);
  }
  for (let r = 0; r <= nH; r++) {
    for (let i = 0; i < K; i++) {
      const p = hipPos[r]![i]!;
      hip.node[r * (K + 1) + i] = mesh.addNode(p[0], p[1], p[2], clear);
    }
    hip.node[r * (K + 1) + K] = hip.node[r * (K + 1)]!;
  }
  mesh.surfaces.push(hip);

  // ---- curva de tiro (U) bajo el anillo de división ----
  const F = hipPos[nH]![K / 2]!;
  const Bk = hipPos[nH]![0]!;
  const depth = plan.ySplit - plan.yCrotch;
  const nIn = Math.max(8, Math.round(Math.hypot(F[2] - Bk[2], depth * 2) / e) - 1);
  const uPos: V3[] = [];
  const uNodes: number[] = [];
  for (let k = 1; k <= nIn; k++) {
    const s = -1 + (2 * k) / (nIn + 1); // F (s=-1) → B (s=+1)
    const z = mix(F[2], Bk[2], (s + 1) / 2);
    const y = plan.yCrotch + depth * (1 - Math.sqrt(Math.max(0, 1 - s * s)));
    uPos.push([0, y, z]);
    uNodes.push(mesh.addNode(0, y, z, clear));
  }
  // ---- perneras ----
  const legs: Surface[] = [];
  const nL = Math.max(8, Math.ceil((plan.ySplit - plan.yHem) / e));
  for (const side of [1, -1] as const) {
    // anillo 0: arco de cadera + curva de tiro
    const ring0: number[] = [];
    const ring0Pos: V3[] = [];
    const arcStart = side === 1 ? 0 : K / 2;
    for (let i = arcStart; i <= arcStart + K / 2; i++) {
      ring0.push(hip.node[nH * (K + 1) + (i % K)]!);
      ring0Pos.push(hipPos[nH]![i % K]!);
    }
    const inner = side === 1 ? uNodes : uNodes.slice().reverse();
    const innerPos = side === 1 ? uPos : uPos.slice().reverse();
    ring0.push(...inner);
    ring0Pos.push(...innerPos);
    const Lp = ring0.length;
    const arcCount = K / 2 + 1;
    // ángulos de cada vértice del anillo 0 alrededor del eje de la pierna (u=-z, v=+x)
    const c0 = new LegRings(field, side, new Float64Array(0)).center(plan.ySplit);
    const angles = new Float64Array(Lp);
    for (let j = 0; j < Lp; j++) {
      const rel = [ring0Pos[j]![0] - c0.cx, ring0Pos[j]![2] - c0.cz];
      angles[j] = Math.atan2(rel[0]!, -rel[1]!);
    }
    for (let j = 1; j < Lp; j++) while (angles[j]! < angles[j - 1]!) angles[j] = angles[j]! + 2 * Math.PI;
    const legR = new LegRings(field, side, angles);
    const cols = Lp + 1;
    const surf = newSurface(side === 1 ? 'legL' : 'legR', nL + 1, cols, { wrap: true });
    const pts0 = new Float64Array(Lp * 2);
    const tmpL = new Float64Array(Lp * 2);
    const yC = plan.yCrotch;
    const targetC = (y: number): number => {
      // perímetro absoluto de la pierna: muslo → rodilla → bajo
      const yK = field.lm.yKnee;
      const y0 = yC - 0.03;
      if (y >= y0) return plan.thighC;
      if (y >= yK) return mix(plan.thighC, plan.kneeC, smooth01((y0 - y) / Math.max(0.05, y0 - yK)));
      return mix(plan.kneeC, plan.openC, smooth01((yK - y) / Math.max(0.05, yK - plan.yHem)));
    };
    const jBlend = 12,
      jFlat = 14;
    for (let r = 0; r <= nL; r++) {
      const y = mix(plan.ySplit, plan.yHem, r / nL);
      const { r: hull, cx, cz } = legR.hullAt(y);
      polarToPoints(hull, angles, pts0);
      const P0 = perimeter2D(pts0);
      const tgt = Math.max(targetC(y), P0 + 2 * Math.PI * clear);
      const eo = solveOffsetForPerimeter(pts0, tgt, tmpL);
      const ring = offsetContour(pts0, eo, new Float64Array(Lp * 2));
      for (let j = 0; j < Lp; j++) {
        let node: number;
        if (r === 0) {
          node = ring0[j]!;
        } else {
          const isInner = j >= arcCount;
          // posición objetivo en el anillo plano (x = cx + b, z = cz - a); el lado interior no cruza x=0
          let x = cx + ring[j * 2 + 1]!;
          const z = cz - ring[j * 2]!;
          const minX = 0.003;
          if (side * x < minX) x = side * minX;
          const target: V3 = [x, y, z];
          let base: V3;
          let s: number;
          if (!isInner) {
            base = [ring0Pos[j]![0], y, ring0Pos[j]![2]];
            s = smooth01(r / jBlend);
          } else {
            const dk = ring0Pos[j]![1] - yC;
            base = [0, y - (ring0Pos[j]![1] - plan.ySplit) * -1 - 0, ring0Pos[j]![2]];
            // el lado interior parte de la curva de tiro (deprimida) y sube a su plano
            base = [0, y - (plan.ySplit - ring0Pos[j]![1]), ring0Pos[j]![2]];
            void dk;
            s = smooth01(r / jFlat);
          }
          const p: V3 = [mix(base[0], target[0], s), mix(base[1], target[1], s), mix(base[2], target[2], s)];
          node = mesh.addNode(p[0], p[1], p[2], clear + (r > nL - 6 ? T * (r - (nL - 6)) / 6 : 0));
        }
        surf.node[r * cols + j] = node;
      }
      surf.node[r * cols + Lp] = surf.node[r * cols]!;
    }
    mesh.surfaces.push(surf);
    legs.push(surf);
  }
  return { plan, hip, legs, rowSplit: nH };
}
