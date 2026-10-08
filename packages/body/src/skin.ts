import { J, JOINT_COUNT, type Vec3 } from '@fitroom/shared';
import { BIG } from './geom.js';
import type { BodyField } from './field.js';
import type { Adjacency } from './meshops.js';

export interface SkinResult {
  /** 4 índices de joint por vértice */
  readonly indices: Uint16Array;
  /** 4 pesos por vértice (suman 1) */
  readonly weights: Float32Array;
}

const smooth01 = (t: number): number => {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
};

/**
 * Pesos del tronco como función de la altura: pelvis → columna (spine) → tórax (chest), con transiciones suaves
 * entre las articulaciones (como un esqueleto lineal con interpolación suavizada).
 */
function torsoWeights(y: number, P: readonly Vec3[], out: Float64Array): void {
  const yP = P[J.pelvis]![1];
  const yS = P[J.spine]![1];
  const yC = P[J.chest]![1];
  if (y <= yP) out[J.pelvis]! += 1;
  else if (y < yS) {
    const t = smooth01((y - yP) / (yS - yP));
    out[J.pelvis]! += 1 - t;
    out[J.spine]! += t;
  } else if (y < yC) {
    const t = smooth01((y - yS) / (yC - yS));
    out[J.spine]! += 1 - t;
    out[J.chest]! += t;
  } else out[J.chest]! += 1;
}

/** Influencias dispersas por vértice durante el cálculo (se conservan las 8 mayores). */
const K_SPARSE = 8;

/**
 * Pesos LBS (4 influencias) a partir del propio campo de distancia: cada vértice reparte su peso entre las
 * primitivas cuya superficie tiene cerca (softmax de −distancia/τ), y cada primitiva pertenece a un hueso. Así
 * los pliegues (axila, ingle, codo, rodilla) tienen transiciones suaves sin «fugas» entre partes separadas
 * por aire (la mano no hereda peso del muslo). Después se suaviza sobre la topología de la malla.
 */
export function computeSkin(
  field: BodyField,
  positions: Float32Array,
  adj: Adjacency,
  smoothIterations = 2,
): SkinResult {
  const n = positions.length / 3;
  const prims = field.prims;
  const P = field.dims.P;
  const d = new Float64Array(prims.length);
  const acc = new Float64Array(JOINT_COUNT);
  const tor = new Float64Array(JOINT_COUNT);
  const bufJ = [new Uint8Array(n * K_SPARSE), new Uint8Array(n * K_SPARSE)];
  const bufW = [new Float32Array(n * K_SPARSE), new Float32Array(n * K_SPARSE)];
  let cur = 0;
  let sj = bufJ[0]!;
  let sw = bufW[0]!;
  let tj = bufJ[1]!;
  let tw = bufW[1]!;

  /** Extrae las K_SPARSE mayores de `acc` (normalizadas a suma 1) hacia (outJ, outW) en la posición v. */
  const extract = (v: number, outJ: Uint8Array, outW: Float32Array, sum: number): void => {
    const base = v * K_SPARSE;
    let cnt = 0;
    let total = 0;
    for (let j = 0; j < JOINT_COUNT; j++) {
      const w = acc[j]!;
      if (w <= 1e-5) continue;
      // inserción ordenada descendente
      let k = cnt < K_SPARSE ? cnt : K_SPARSE - 1;
      if (cnt === K_SPARSE && w <= outW[base + K_SPARSE - 1]!) continue;
      while (k > 0 && w > outW[base + k - 1]!) {
        outW[base + k] = outW[base + k - 1]!;
        outJ[base + k] = outJ[base + k - 1]!;
        k--;
      }
      outW[base + k] = w;
      outJ[base + k] = j;
      if (cnt < K_SPARSE) cnt++;
    }
    for (let k = 0; k < cnt; k++) total += outW[base + k]!;
    const inv = total > 0 ? 1 / total : 0;
    for (let k = 0; k < cnt; k++) outW[base + k] = outW[base + k]! * inv;
    for (let k = cnt; k < K_SPARSE; k++) {
      outW[base + k] = 0;
      outJ[base + k] = 0;
    }
    if (cnt === 0) {
      outJ[base] = J.pelvis;
      outW[base] = 1;
    }
    void sum;
  };

  for (let v = 0; v < n; v++) {
    const x = positions[v * 3]!;
    const y = positions[v * 3 + 1]!;
    const z = positions[v * 3 + 2]!;
    field.evalPrims(x, y, z, d);
    let dmin = Infinity;
    for (let i = 0; i < d.length; i++) if (d[i]! < dmin) dmin = d[i]!;
    acc.fill(0);
    let torsoS = 0;
    for (let i = 0; i < prims.length; i++) {
      const di = d[i]!;
      if (di >= BIG) continue;
      const s = Math.exp(-(di - dmin) / prims[i]!.tau);
      if (s < 1e-4) continue;
      const bone = prims[i]!.bone;
      if (bone >= 0) acc[bone]! += s;
      else torsoS += s;
    }
    if (torsoS > 0) {
      tor.fill(0);
      torsoWeights(y, P, tor);
      for (let j = 0; j < JOINT_COUNT; j++) acc[j] = acc[j]! + torsoS * tor[j]!;
    }
    extract(v, sj, sw, 0);
  }
  // suavizado sobre la malla (sobre las influencias dispersas)
  const { offsets, neighbors } = adj;
  for (let it = 0; it < smoothIterations; it++) {
    for (let v = 0; v < n; v++) {
      acc.fill(0);
      const s = offsets[v]!;
      const e = offsets[v + 1]!;
      const cnt = e - s;
      const base = v * K_SPARSE;
      for (let k = 0; k < K_SPARSE; k++) acc[sj[base + k]!]! += 0.5 * sw[base + k]!;
      if (cnt > 0) {
        const wn = 0.5 / cnt;
        for (let q = s; q < e; q++) {
          const nb = neighbors[q]! * K_SPARSE;
          for (let k = 0; k < K_SPARSE; k++) acc[sj[nb + k]!]! += wn * sw[nb + k]!;
        }
      } else for (let k = 0; k < K_SPARSE; k++) acc[sj[base + k]!]! += 0.5 * sw[base + k]!;
      extract(v, tj, tw, 0);
    }
    cur = 1 - cur;
    sj = bufJ[cur]!;
    sw = bufW[cur]!;
    tj = bufJ[1 - cur]!;
    tw = bufW[1 - cur]!;
  }
  // 4 mayores influencias, renormalizadas (ya están ordenadas descendentemente)
  const indices = new Uint16Array(n * 4);
  const weights = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) {
    const base = v * K_SPARSE;
    let sum = sw[base]! + sw[base + 1]! + sw[base + 2]! + sw[base + 3]!;
    if (!(sum > 0)) {
      indices[v * 4] = J.pelvis;
      weights[v * 4] = 1;
      continue;
    }
    for (let k = 0; k < 4; k++) {
      const w = sw[base + k]! / sum;
      weights[v * 4 + k] = w;
      indices[v * 4 + k] = w > 0 ? sj[base + k]! : 0;
    }
    // la suma en float32 puede desviarse ~1e-7: absorberlo en el mayor
    sum = weights[v * 4]! + weights[v * 4 + 1]! + weights[v * 4 + 2]! + weights[v * 4 + 3]!;
    weights[v * 4] = weights[v * 4]! + (1 - sum);
  }
  return { indices, weights };
}
