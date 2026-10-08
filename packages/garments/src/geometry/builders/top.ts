import {
  J,
  REST_BONE_DIRECTIONS,
  type BodyModel,
  type GarmentDefinition,
  type GarmentSpec,
} from '@fitroom/shared';
import { type BodyField } from '../core/bodyField.js';
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
import {
  ARMHOLE_DROP_BY_FIT,
  EASE_BY_FIT,
  SHOULDER_DROP_BY_FIT,
  TOP_DEFAULTS,
  bodyOf,
  cm,
  fabricHintFor,
  param,
} from '../plan.js';

export interface SleevePlan {
  kind: 'none' | 'short' | 'long';
  /** longitud desde el hombro de la prenda hasta el puño, a lo largo de la manga (m) */
  length: number;
  /** holgura radial en el bíceps / en el puño (m) */
  easeBicep: number;
  easeCuff: number;
  /** puño ajustado (canalé) */
  ribCuff: boolean;
}

export interface TopPlan {
  K: number;
  e: number;
  T: number;
  clear: number;
  yHem: number;
  yPitG: number;
  yTip: number;
  yHPS: number;
  chestC: number;
  hemC: number;
  waistC: number | undefined;
  hwT: number;
  sleeve: SleevePlan;
  neck: {
    aN: number;
    bF: number;
    bB: number;
    zc: number;
    yBack: number;
    yFront: number;
    yCenter: number;
    kind: string;
  };
}

export interface TopBuild {
  plan: TopPlan;
  torso: Surface;
  sleeves: Surface[];
  rowA: number;
  rowB: number;
  rowC: number;
  /** nodos de los lazos de sisa (izquierda, derecha) */
  loops: number[][];
}

/** Superelipse polar: radio en dirección (c = cosθ, s = sinθ) con semiejes A (según u) y B (según v). */
export function superEllipseRadius(c: number, s: number, A: number, B: number, n: number): number {
  const t = Math.pow(Math.abs(c) / A, n) + Math.pow(Math.abs(s) / B, n);
  return Math.pow(t, -1 / n);
}

const SLEEVE_EASE_BICEP = { slim: 0.012, regular: 0.022, relaxed: 0.034, oversized: 0.055 } as const;
const SLEEVE_EASE_CUFF = { slim: 0.014, regular: 0.028, relaxed: 0.042, oversized: 0.07 } as const;

export function planTop(def: GarmentDefinition, spec: GarmentSpec, body: BodyModel, field: BodyField): TopPlan {
  const B = bodyOf(body);
  const lm = field.lm;
  const D = TOP_DEFAULTS[def.template];
  const fit = def.fit;
  const hint = fabricHintFor(def.fabricId);
  const T = hint.thickness;
  const clear = T / 2 + 0.001;
  const chestC = cm(spec.chestCm, B.chest + EASE_BY_FIT[fit]);
  const hemC = cm(spec.hemCm, chestC - 0.01);
  const waistC = spec.waistCm !== undefined ? cm(spec.waistCm, 0) : undefined;
  const yHPS = lm.yNeckBase - 0.004;
  const length = cm(spec.lengthCm, (D?.lengthRatio ?? 0.4) * B.H);
  const yHem = yHPS - length;
  const yPitG = Math.max(yHem + 0.12, lm.yPit - ARMHOLE_DROP_BY_FIT[fit]);
  const yTip = lm.yShoulder - SHOULDER_DROP_BY_FIT[fit] * 0.5;
  const hwT =
    spec.shoulderWidthCm !== undefined
      ? cm(spec.shoulderWidthCm, B.shoulder) / 2
      : B.shoulder / 2 + SHOULDER_DROP_BY_FIT[fit] * 0.6 + 0.004;
  const e = param(def, 'edgeMm', 7.5) / 1000;
  const K = Math.max(96, Math.ceil(chestC / e / 8) * 8);
  const neckR = B.neck / (2 * Math.PI);
  const dropF = param(def, 'neckDropCm', 8) / 100;
  const neck = {
    aN: neckR + 0.024,
    bF: neckR + 0.03,
    bB: neckR + 0.014,
    zc: -0.008,
    yBack: yHPS - 0.02,
    yFront: yHPS - dropF,
    yCenter: yHPS,
    kind: 'crew',
  };
  const sleeveKind = D?.sleeve === 'long' ? 'long' : D?.sleeve === 'short' ? 'short' : 'none';
  const sleeveLen = cm(spec.sleeveLengthCm, (D?.sleeveRatio ?? 0.34) * B.arm);
  const sleeve: SleevePlan = {
    kind: spec.sleeveLengthCm !== undefined && spec.sleeveLengthCm <= 0 ? 'none' : sleeveKind,
    length: sleeveLen,
    easeBicep: SLEEVE_EASE_BICEP[fit],
    easeCuff: sleeveKind === 'long' ? SLEEVE_EASE_CUFF[fit] * 0.8 : SLEEVE_EASE_CUFF[fit],
    ribCuff: false,
  };
  return { K, e, T, clear, yHem, yPitG, yTip, yHPS, chestC, hemC, waistC, hwT, sleeve, neck };
}

type V3 = [number, number, number];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm3 = (a: V3): V3 => {
  const l = len3(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross3 = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Anillos de la sección del brazo en planos ⟂ al eje, en los ángulos (no uniformes) del lazo de sisa. */
class ArmRings {
  private readonly cache = new Map<number, Float64Array>();
  readonly J: V3;
  readonly a: V3;
  readonly u: V3 = [0, 0, 1];
  readonly v: V3;
  constructor(
    private readonly field: BodyField,
    readonly side: 1 | -1,
    private readonly angles: Float64Array,
    readonly keyStep = 0.02,
  ) {
    const sk = field.body.skeleton;
    const ua = side === 1 ? J.l_upper_arm : J.r_upper_arm;
    this.J = [...sk.joints[ua]!.position] as V3;
    this.a = [...REST_BONE_DIRECTIONS[ua]!] as V3;
    // v = componente "arriba" perpendicular al eje (arriba-afuera)
    const up: V3 = [0, 1, 0];
    this.v = norm3(sub3(up, mul3(this.a, dot3(up, this.a))));
  }
  center(s: number): V3 {
    return add3(this.J, mul3(this.a, s));
  }
  /** radios de la envolvente convexa del brazo (por ángulo) en s (interpolados entre cortes cada keyStep) */
  hullAt(s: number): Float64Array {
    const f = Math.max(0, s) / this.keyStep;
    const k0 = Math.floor(f);
    const t = f - k0;
    const a = this.key(k0);
    if (t < 1e-6) return a;
    const b = this.key(k0 + 1);
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i]! + (b[i]! - a[i]!) * t;
    return out;
  }
  private key(k: number): Float64Array {
    let r = this.cache.get(k);
    if (r) return r;
    const s = k * this.keyStep;
    const c = this.center(s);
    const fr = {
      cx: c[0],
      cy: c[1],
      cz: c[2],
      ux: this.u[0],
      uy: this.u[1],
      uz: this.u[2],
      vx: this.v[0],
      vy: this.v[1],
      vz: this.v[2],
    };
    const raw = bodyRadiiAt(this.field, fr, this.angles, 0.13, 0.02);
    // recorta radios anómalos (rayos que salen por el tronco): ≤ 1.6 × mediana
    const sorted = Array.from(raw).sort((x, y) => x - y);
    const med = sorted[sorted.length >> 1]!;
    for (let i = 0; i < raw.length; i++) if (raw[i]! > 1.6 * med) raw[i] = 1.6 * med;
    const pts = polarToPoints(raw, this.angles);
    r = hullRadiiAt(pts, this.angles);
    for (let i = 0; i < r.length; i++) if (r[i]! < raw[i]!) r[i] = raw[i]!;
    this.cache.set(k, r);
    return r;
  }
}

/** Construye el torso con sisas y las mangas. Todo en una malla de superficies que comparten nodos. */
export function buildTop(
  def: GarmentDefinition,
  spec: GarmentSpec,
  body: BodyModel,
  field: BodyField,
  mesh: GarmentMesh,
  plan: TopPlan,
): TopBuild {
  const { K, e, clear, T } = plan;
  const lm = field.lm;
  const slices = new TorsoSlices(field, K);
  const nA = Math.max(8, Math.ceil((plan.yPitG - plan.yHem) / e));
  const nB = Math.max(8, Math.ceil((plan.yTip - plan.yPitG) / e));
  const domeLen = Math.hypot(plan.hwT - plan.neck.aN, plan.yTip - plan.yHPS) + 0.02;
  const nC = Math.max(8, Math.ceil(domeLen / e));
  const rows = nA + nB + nC + 1;
  const s = newSurface('torso', rows, K + 1, { wrap: true });
  const tmp = new Float64Array(K * 2);
  const yReliable = lm.yPit - 0.035;
  const chestRef = plan.yPitG - 0.03;

  const targetAt = (y: number): number => {
    const t = clamp01((y - plan.yHem) / Math.max(0.05, chestRef - plan.yHem));
    let c = mix(plan.hemC, plan.chestC, smooth01(t));
    if (plan.waistC !== undefined && y < chestRef && y > plan.yHem) {
      const k = Math.exp(-Math.pow((y - lm.yWaist) / 0.09, 2));
      c = mix(c, plan.waistC, k * 0.85);
    }
    return c;
  };

  const ringAt = (y: number): { pts: Float64Array; zc: number } => {
    const ySl = Math.min(y, yReliable);
    const sc = slices.interp(ySl);
    const tgt = Math.max(targetAt(y), sc.pBody + 2 * Math.PI * (clear + (y < plan.yHem + 0.03 ? T : 0)));
    const h = clamp01(1 - (tgt - sc.pBody) / Math.max(1e-6, sc.pHull - sc.pBody));
    const m = new Float64Array(K);
    for (let i = 0; i < K; i++) m[i] = mix(sc.hull[i]!, sc.body[i]!, h);
    const pts = radiiToPoints(m);
    const pm = perimeter2D(pts);
    const t2 = Math.max(tgt, pm + 2 * Math.PI * clear);
    const eo = solveOffsetForPerimeter(pts, t2, tmp);
    return { pts: offsetContour(pts, eo, new Float64Array(K * 2)), zc: sc.zc };
  };

  const grid = new Float64Array(rows * K * 3);
  const put = (r: number, i: number, p: V3): void => {
    grid[(r * K + i) * 3] = p[0];
    grid[(r * K + i) * 3 + 1] = p[1];
    grid[(r * K + i) * 3 + 2] = p[2];
  };
  const get = (r: number, i: number): V3 => [grid[(r * K + i) * 3]!, grid[(r * K + i) * 3 + 1]!, grid[(r * K + i) * 3 + 2]!];

  // A: del bajo a la sisa
  for (let r = 0; r <= nA; r++) {
    const y = mix(plan.yHem, plan.yPitG, r / nA);
    const ring = ringAt(y);
    for (let i = 0; i < K; i++) put(r, i, [ring.pts[i * 2 + 1]!, y, ring.zc - ring.pts[i * 2]!]);
  }
  // anillo del hombro (superelipse) en yTip
  const pitRing = ringAt(plan.yPitG);
  const slPit = slices.interp(yReliable);
  const tipDf = slPit.body[K / 2]! * 0.85 + 0.012;
  const tipDb = slPit.body[0]! * 0.88 + 0.012;
  const tipZc = pitRing.zc - 0.01;
  const tipPts = new Float64Array(K * 2);
  for (let i = 0; i < K; i++) {
    const th = (2 * Math.PI * i) / K;
    const c = Math.cos(th),
      sn = Math.sin(th);
    const r = superEllipseRadius(c, sn, c > 0 ? tipDb : tipDf, plan.hwT, 2.6);
    tipPts[i * 2] = r * c;
    tipPts[i * 2 + 1] = r * sn;
  }
  // B: yugo
  for (let r = 1; r <= nB; r++) {
    const t = r / nB;
    const y = mix(plan.yPitG, plan.yTip, t);
    const zc = mix(pitRing.zc, tipZc, t);
    const u = smooth01(t);
    for (let i = 0; i < K; i++) {
      const a = mix(pitRing.pts[i * 2]!, tipPts[i * 2]!, u);
      const b = mix(pitRing.pts[i * 2 + 1]!, tipPts[i * 2 + 1]!, u);
      put(nA + r, i, [b, y, zc - a]);
    }
  }

  // ---- sisas: bloque rectangular en la rejilla que se convierte en un lazo ovalado 3D ----
  const hasSleeves = plan.sleeve.kind !== 'none';
  const rP = nA,
    rT = nA + nB;
  const colSpacing = plan.chestC / K;
  const Az = Math.min(0.125, Math.max(0.078, 0.4 * (slPit.body[0]! + slPit.body[K / 2]!)));
  const hc = Math.max(6, Math.round(Az / colSpacing));
  const holeCols = (side: 1 | -1): { iA: number; lo: number; hi: number } => {
    const iA = side === 1 ? K / 4 : (3 * K) / 4;
    return { iA, lo: iA - hc, hi: iA + hc };
  };
  const loopsInfo: Array<{ side: 1 | -1; verts: Array<{ r: number; i: number; zq: number; hq: number }> }> = [];
  const inHole = new Uint8Array(rows * K);
  if (hasSleeves) {
    for (const side of [1, -1] as const) {
      const { iA, lo, hi } = holeCols(side);
      // zq = +1 hacia el frente. En el lado izquierdo +i = frente; en el derecho +i = espalda.
      const zqOf = (i: number): number => (side === 1 ? (i - iA) / hc : -(i - iA) / hc);
      const hqOf = (r: number): number => ((r - rP) / (rT - rP)) * 2 - 1;
      const verts: Array<{ r: number; i: number; zq: number; hq: number }> = [];
      // secuencia: abajo (espalda→frente), subida frontal, arriba (frente→espalda), bajada trasera
      const seq: Array<[number, number]> = [];
      const back = side === 1 ? lo : hi;
      const front = side === 1 ? hi : lo;
      const step = side === 1 ? 1 : -1;
      for (let i = back; i !== front; i += step) seq.push([rP, i]);
      for (let r = rP; r < rT; r++) seq.push([r, front]);
      for (let i = front; i !== back; i -= step) seq.push([rT, i]);
      for (let r = rT; r > rP; r--) seq.push([r, back]);
      for (const [r, i] of seq) verts.push({ r, i, zq: zqOf(i), hq: hqOf(r) });
      loopsInfo.push({ side, verts });
      for (let r = rP + 1; r < rT; r++) for (let i = lo + 1; i < hi; i++) inHole[r * K + i] = 1;
    }
  }

  // posiciones 3D del lazo: superelipse en un plano que pasa por el hombro (punta) y la axila
  const loopPos: V3[][] = [];
  const loopAngles: Float64Array[] = [];
  const arms: ArmRings[] = [];
  if (hasSleeves) {
    for (const li of loopsInfo) {
      const side = li.side;
      const iA = holeCols(side).iA;
      const tip: V3 = [side * plan.hwT, plan.yTip, tipZc];
      const pitLat = pitRing.pts[iA * 2 + 1]!;
      const pit: V3 = [pitLat, plan.yPitG, pitRing.zc - pitRing.pts[iA * 2]!];
      const center = mul3(add3(tip, pit), 0.5);
      const tHat = norm3(sub3(tip, pit));
      const At = len3(sub3(tip, pit)) / 2;
      const zHat: V3 = [0, 0, 1];
      const nOut = 3;
      const verts: V3[] = [];
      for (const v of li.verts) {
        const sc = 1 / Math.pow(Math.pow(Math.abs(v.zq), nOut) + Math.pow(Math.abs(v.hq), nOut), 1 / nOut);
        const zl = v.zq * sc * Az;
        const tl = v.hq * sc * At;
        verts.push(add3(center, add3(mul3(zHat, zl), mul3(tHat, tl))));
      }
      loopPos.push(verts);
      const arm = new ArmRings(field, side, new Float64Array(0));
      void arm;
    }
  }

  // nodos del torso
  for (let r = 0; r < rows; r++) {
    const hemExtra = r < 6 ? T * (1 - r / 6) : 0;
    for (let i = 0; i < K; i++) {
      if (inHole[r * K + i]) continue;
      const p = get(r, i);
      s.node[r * (K + 1) + i] = mesh.addNode(p[0], p[1], p[2], clear + hemExtra);
    }
    s.node[r * (K + 1) + K] = s.node[r * (K + 1)]!;
  }
  // los nodos de las neutras del dome: sin cambios
  const neckPt = (i: number): V3 => {
    const nk = plan.neck;
    const th = (2 * Math.PI * i) / K;
    const c = Math.cos(th),
      sn = Math.sin(th);
    const rho = superEllipseRadius(c, sn, c > 0 ? nk.bB : nk.bF, nk.aN, 2.2);
    const front = Math.max(0, -c);
    const y = mix(nk.yBack, nk.yCenter, smooth01(1 - Math.max(0, c))) + (nk.yFront - nk.yCenter) * Math.pow(front, 1.6);
    return [rho * sn, y, nk.zc - rho * c];
  };
  // C: cúpula hasta el escote (se coloca tras fijar el lazo, partiendo de la fila rT real)
  const loops: number[][] = [];
  const sleeves: Surface[] = [];
  if (hasSleeves) {
    loopsInfo.forEach((li, idx) => {
      const pos = loopPos[idx]!;
      const nodes: number[] = [];
      li.verts.forEach((v, j) => {
        const node = s.node[v.r * (K + 1) + v.i]!;
        mesh.setPos(node, pos[j]![0], pos[j]![1], pos[j]![2]);
        nodes.push(node);
        // la fila rT actualiza la rejilla de partida de la cúpula
        if (v.r === rT) put(rT, v.i, pos[j]!);
      });
      loops.push(nodes);
    });
  }
  const rowTopNode: V3[] = [];
  for (let i = 0; i < K; i++) rowTopNode.push(get(rT, i));
  for (let r = 1; r <= nC; r++) {
    const t = r / nC;
    for (let i = 0; i < K; i++) {
      const a = rowTopNode[i]!;
      const n = neckPt(i);
      const p: V3 = [mix(a[0], n[0], t), mix(a[1], n[1], t), mix(a[2], n[2], t)];
      s.node[(rT + r) * (K + 1) + i] = mesh.addNode(p[0], p[1], p[2], clear);
    }
    s.node[(rT + r) * (K + 1) + K] = s.node[(rT + r) * (K + 1)]!;
  }
  mesh.surfaces.push(s);

  // ---- mangas ----
  if (hasSleeves) {
    loopsInfo.forEach((li, idx) => {
      const side = li.side;
      const Lp = li.verts.length;
      const pos = loopPos[idx]!;
      const sleeve = buildSleeve(field, mesh, plan, side, pos, loops[idx]!, Lp);
      sleeves.push(sleeve);
    });
  }
  void bodyRadiiAt;
  void J;
  return { plan, torso: s, sleeves, rowA: nA, rowB: rT, rowC: rT + nC, loops };
}

/** Manga: tubo desde el lazo de la sisa hasta el puño. Devuelve la superficie (fila 0 = nodos del lazo). */
function buildSleeve(
  field: BodyField,
  mesh: GarmentMesh,
  plan: TopPlan,
  side: 1 | -1,
  loopPos: V3[],
  loopNodes: number[],
  Lp: number,
): Surface {
  const { clear, T, e } = plan;
  const sl = plan.sleeve;
  // ángulos de cada vértice del lazo alrededor del eje del brazo (u = frente, v = arriba-afuera), crecientes (CCW)
  const arm0 = new ArmRings(field, side, new Float64Array(0));
  const cJ = arm0.center(0);
  const angles = new Float64Array(Lp);
  for (let j = 0; j < Lp; j++) {
    const rel = sub3(loopPos[j]!, cJ);
    // quita la componente axial
    const ax = dot3(rel, arm0.a);
    const q = sub3(rel, mul3(arm0.a, ax));
    angles[j] = Math.atan2(dot3(q, arm0.v), dot3(q, arm0.u));
  }
  // hace crecientes los ángulos (desenvuelve)
  for (let j = 1; j < Lp; j++) {
    while (angles[j]! < angles[j - 1]!) angles[j] = angles[j]! + 2 * Math.PI;
  }
  const arm = new ArmRings(field, side, angles);
  // longitud: de la punta del hombro al puño a lo largo de la línea superior
  const tipPos = loopPos[Math.round(Lp * 0.5) % Lp]!;
  void tipPos;
  const sTip = dot3(sub3(loopPos.reduce((best, p) => (p[1] > best[1] ? p : best), loopPos[0]!), cJ), arm0.a);
  let sEnd = Math.max(0.08, sl.length + sTip);
  // número de filas con paso ≈ e
  const nS = Math.max(6, Math.ceil(sEnd / e));
  const cols = Lp + 1;
  const surf = newSurface(side === 1 ? 'sleeveL' : 'sleeveR', nS + 1, cols, { wrap: true });
  const sBlend = 0.11;
  const sValid = 0.1;
  const pts0 = new Float64Array(Lp * 2);
  const tmp = new Float64Array(Lp * 2);
  const rowPts: V3[][] = [];
  const buildRows = (): void => {
    rowPts.length = 0;
    for (let r = 0; r <= nS; r++) {
      const s = (sEnd * r) / nS;
      const c = arm.center(s);
      const hull = arm.hullAt(Math.max(s, sValid));
      polarToPoints(hull, angles, pts0);
      const P0 = perimeter2D(pts0);
      const tNorm = clamp01((s - sBlend) / Math.max(0.05, sEnd - sBlend));
      const ease = Math.max(clear, mix(sl.easeBicep, sl.easeCuff, smooth01(tNorm)));
      // menos holgura bajo la axila (lado interior, ψ≈3π/2) cerca del hombro
      const eVar = new Float64Array(Lp);
      const under = 1 - smooth01((s - 0.06) / 0.14);
      for (let j = 0; j < Lp; j++) {
        const cc = Math.cos(angles[j]! - (3 * Math.PI) / 2);
        eVar[j] = -ease * 0.75 * under * Math.pow(Math.max(0, cc), 2);
      }
      const target = P0 + 2 * Math.PI * ease;
      const eo = solveOffsetForPerimeter(pts0, target, tmp, eVar);
      const ring = offsetContour(pts0, eo, new Float64Array(Lp * 2), eVar);
      const w = r === 0 ? 0 : smooth01((s - (arm.keyStep * 0)) / sBlend);
      const row: V3[] = [];
      for (let j = 0; j < Lp; j++) {
        const q: V3 = add3(c, add3(mul3(arm.u, ring[j * 2]!), mul3(arm.v, ring[j * 2 + 1]!)));
        row.push([mix(loopPos[j]![0], q[0], w), mix(loopPos[j]![1], q[1], w), mix(loopPos[j]![2], q[2], w)]);
      }
      rowPts.push(row);
    }
  };
  buildRows();
  // ajusta sEnd para que la línea superior mida exactamente la longitud pedida
  const topIdx = (() => {
    let bi = 0;
    for (let j = 1; j < Lp; j++) if (loopPos[j]![1] > loopPos[bi]![1]) bi = j;
    return bi;
  })();
  for (let it = 0; it < 2; it++) {
    let L = 0;
    for (let r = 1; r <= nS; r++) L += len3(sub3(rowPts[r]![topIdx]!, rowPts[r - 1]![topIdx]!));
    sEnd = Math.max(0.05, sEnd * (sl.length / Math.max(L, 1e-6)));
    buildRows();
  }
  for (let r = 0; r <= nS; r++) {
    for (let j = 0; j < Lp; j++) {
      const id = r === 0 ? loopNodes[j]! : mesh.addNode(rowPts[r]![j]![0], rowPts[r]![j]![1], rowPts[r]![j]![2], clear + (r > nS - 5 ? T * 0.5 : 0));
      surf.node[r * cols + j] = id;
    }
    surf.node[r * cols + Lp] = surf.node[r * cols]!;
  }
  mesh.surfaces.push(surf);
  return surf;
}
