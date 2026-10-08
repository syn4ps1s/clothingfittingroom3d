import { LM, clamp, type PoseFrame, type SegmentationMask } from '@fitroom/shared';
import { cleanVis, median } from './geom.js';
import { LEVELS } from './calibration.js';

/**
 * Anchos frontales de silueta a la altura de cada nivel anatómico (pecho, cintura, cadera, cuello, muslo),
 * medidos en la máscara de segmentación y convertidos a centímetros con la escala px/m de los propios
 * landmarks (independiente de los intrínsecos de la cámara).
 *
 * Supuestos (documentados en ACCURACY.md): persona de frente, de pie, brazos separados del tronco (A-pose),
 * cámara a la altura aproximada del torso, ropa ajustada o normal.
 */

const VIS_MIN = 0.5;
const INSIDE = 128;

export interface SilhouetteWidths {
  /** px por metro a la profundidad del cuerpo */
  readonly pxPerM: number;
  readonly chestCm?: number;
  readonly waistCm?: number;
  readonly hipCm?: number;
  /** anchura mínima del cuello en su ventana */
  readonly neckCm?: number;
  /** anchura de UN muslo (2 × distancia del eje cadera→rodilla al borde exterior) */
  readonly thighCm?: number;
  /** ¿se vieron los brazos separados del tronco en los niveles de pecho y cintura? */
  readonly armsClear: boolean;
  /** nº de niveles medidos */
  readonly levels: number;
}

interface Pt {
  readonly x: number;
  readonly y: number;
}

/** Valor de la máscara en (col, fila) enteras; 0 fuera de rango. */
function at(m: SegmentationMask, col: number, row: number): number {
  if (col < 0 || row < 0 || col >= m.width || row >= m.height) return 0;
  return m.data[row * m.width + col]!;
}

/**
 * Bordes (en px, coordenadas continuas con el centro del píxel i en i+0.5) del tramo contiguo de la
 * máscara que contiene `x0` en la fila `row`. Interpola linealmente el cruce de umbral (antialiasing).
 */
export function runEdges(
  m: SegmentationMask,
  row: number,
  x0: number,
  searchRadius = 0.04,
): { left: number; right: number } | null {
  if (row < 0 || row >= m.height) return null;
  let start = Math.floor(x0);
  if (at(m, start, row) < INSIDE) {
    // buscar el píxel «dentro» más cercano al eje
    const r = Math.max(2, Math.round(searchRadius * m.width));
    let found = -1;
    for (let d = 1; d <= r; d++) {
      if (at(m, start + d, row) >= INSIDE) {
        found = start + d;
        break;
      }
      if (at(m, start - d, row) >= INSIDE) {
        found = start - d;
        break;
      }
    }
    if (found < 0) return null;
    start = found;
  }
  let i = start;
  while (i > 0 && at(m, i - 1, row) >= INSIDE) i--;
  let j = start;
  while (j < m.width - 1 && at(m, j + 1, row) >= INSIDE) j++;
  const cross = (inside: number, outside: number): number => {
    const vi = at(m, inside, row);
    const vo = at(m, outside, row);
    return vi > vo ? (vi - INSIDE) / (vi - vo) : 0.5;
  };
  const left = i > 0 ? i + 0.5 - cross(i, i - 1) : 0;
  const right = j < m.width - 1 ? j + 0.5 + cross(j, j + 1) : m.width;
  return { left, right };
}

/** Distancia desde `x0` hasta el borde exterior (dirección `dir` = ±1) del tramo que lo contiene. */
function outerDistance(m: SegmentationMask, row: number, x0: number, dir: 1 | -1): number | null {
  if (row < 0 || row >= m.height) return null;
  const start = Math.floor(x0);
  if (at(m, start, row) < INSIDE) return null;
  let i = start;
  while (i >= 0 && i < m.width && at(m, i + dir, row) >= INSIDE) i += dir;
  if (i + dir < 0 || i + dir >= m.width) return null; // el borde de la imagen no es un borde de silueta
  const vi = at(m, i, row);
  const vo = at(m, i + dir, row);
  const f = vi > vo ? (vi - INSIDE) / (vi - vo) : 0.5;
  const edge = i + 0.5 + dir * f;
  return Math.abs(edge - x0);
}

export interface LevelAnchors {
  /** fracciones de estatura (ascendentes) y su fila normalizada (0 arriba) */
  readonly frac: readonly number[];
  readonly y: readonly number[];
}

/** Anclas «fracción de estatura → fila de imagen» a partir de los landmarks visibles. */
export function levelAnchors(frame: PoseFrame): LevelAnchors | null {
  const im = frame.image;
  const vis = (i: number): number => cleanVis(frame.world[i]?.visibility ?? im[i]?.visibility);
  const yOf = (...idx: number[]): number | null => {
    const ys = idx
      .filter((i) => vis(i) >= VIS_MIN && Number.isFinite(im[i]?.y))
      .map((i) => im[i]!.y);
    return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
  };
  const pts: [number, number | null][] = [
    [0.008, yOf(LM.l_heel, LM.r_heel, LM.l_foot_index, LM.r_foot_index)],
    [0.039, yOf(LM.l_ankle, LM.r_ankle)],
    [0.285, yOf(LM.l_knee, LM.r_knee)],
    [0.53, yOf(LM.l_hip, LM.r_hip)],
    [0.818, yOf(LM.l_shoulder, LM.r_shoulder)],
    [0.927, yOf(LM.l_ear, LM.r_ear)],
  ];
  const ok = pts.filter((p): p is [number, number] => p[1] !== null);
  if (ok.length < 2) return null;
  return { frac: ok.map((p) => p[0]), y: ok.map((p) => p[1]) };
}

/** Fila normalizada del nivel `frac` (interpolación/extrapolación lineal por tramos). */
export function rowOfLevel(a: LevelAnchors, frac: number): number {
  const n = a.frac.length;
  let i = 0;
  while (i < n - 2 && frac > a.frac[i + 1]!) i++;
  const f0 = a.frac[i]!;
  const f1 = a.frac[i + 1]!;
  const t = (frac - f0) / (f1 - f0);
  return a.y[i]! + (a.y[i + 1]! - a.y[i]!) * t;
}

/**
 * px por metro en la imagen a la profundidad del cuerpo: mediana (ponderada por longitud) de
 * longitud-en-píxeles / (escala·longitud-world-en-el-plano-de-imagen) de los segmentos del cuerpo.
 */
export function estimatePxPerMeter(frame: PoseFrame, scaleK: number, maskW: number, maskH: number): number | null {
  const im = frame.image;
  const w = frame.world;
  const vis = (i: number): number => cleanVis(w[i]?.visibility ?? im[i]?.visibility);
  const segs: [number, number][] = [
    [LM.l_hip, LM.l_knee],
    [LM.r_hip, LM.r_knee],
    [LM.l_knee, LM.l_ankle],
    [LM.r_knee, LM.r_ankle],
    [LM.l_shoulder, LM.l_hip],
    [LM.r_shoulder, LM.r_hip],
    [LM.l_shoulder, LM.l_elbow],
    [LM.r_shoulder, LM.r_elbow],
    [LM.l_shoulder, LM.r_shoulder],
    [LM.l_hip, LM.r_hip],
  ];
  const ratios: number[] = [];
  const weights: number[] = [];
  for (const [a, b] of segs) {
    if (vis(a) < VIS_MIN || vis(b) < VIS_MIN) continue;
    const pa = im[a]!;
    const pb = im[b]!;
    const wa = w[a]!;
    const wb = w[b]!;
    if (![pa.x, pa.y, pb.x, pb.y, wa.x, wa.y, wb.x, wb.y].every(Number.isFinite)) continue;
    const planar = scaleK * Math.hypot(wa.x - wb.x, wa.y - wb.y);
    if (planar < 0.1) continue;
    const px = Math.hypot((pa.x - pb.x) * maskW, (pa.y - pb.y) * maskH);
    ratios.push(px / planar);
    weights.push(planar);
  }
  if (ratios.length < 2) return null;
  // mediana ponderada
  const order = ratios.map((_, i) => i).sort((i, j) => ratios[i]! - ratios[j]!);
  const total = weights.reduce((s, x) => s + x, 0);
  let acc = 0;
  for (const i of order) {
    acc += weights[i]!;
    if (acc >= total / 2) return ratios[i]!;
  }
  return median(ratios);
}

/**
 * Anchos de silueta a los niveles de pecho, cintura, cadera, cuello y muslo.
 * `scaleK` = factor world→métrico (estatura declarada), `heightM` = estatura declarada.
 * Devuelve `null` sin máscara, o si no se puede fijar la escala o las filas.
 */
export function measureSilhouette(
  frame: PoseFrame,
  scaleK: number,
  heightM: number,
): SilhouetteWidths | null {
  const m = frame.mask;
  if (!m || m.width < 8 || m.height < 8 || m.data.length < m.width * m.height) return null;
  const im = frame.image;
  const pxPerM = estimatePxPerMeter(frame, scaleK, m.width, m.height);
  if (!pxPerM || !(pxPerM > 5) || !Number.isFinite(pxPerM)) return null;
  const anchors = levelAnchors(frame);
  if (!anchors) return null;
  const px = (i: number): Pt => ({ x: im[i]!.x * m.width, y: im[i]!.y * m.height });
  const vis = (i: number): number => cleanVis(frame.world[i]?.visibility ?? im[i]?.visibility);

  // eje del tronco (px): de los hombros a las caderas
  const shMid: Pt = { x: (px(LM.l_shoulder).x + px(LM.r_shoulder).x) / 2, y: (px(LM.l_shoulder).y + px(LM.r_shoulder).y) / 2 };
  const hipsOk = vis(LM.l_hip) >= VIS_MIN && vis(LM.r_hip) >= VIS_MIN;
  const hipMid: Pt = hipsOk
    ? { x: (px(LM.l_hip).x + px(LM.r_hip).x) / 2, y: (px(LM.l_hip).y + px(LM.r_hip).y) / 2 }
    : { x: shMid.x, y: shMid.y + 0.3 * m.height };
  const axisX = (row: number): number => {
    const dy = hipMid.y - shMid.y;
    const t = Math.abs(dy) > 1e-6 ? (row - shMid.y) / dy : 0;
    return shMid.x + (hipMid.x - shMid.x) * clamp(t, -0.5, 1.6);
  };

  // radio de brazo (px) para detectar fusión brazo-tronco
  const armR = 0.026 * heightM * pxPerM;
  const armX = (side: 'l' | 'r', row: number): number | null => {
    const s = side === 'l' ? [LM.l_shoulder, LM.l_elbow, LM.l_wrist] : [LM.r_shoulder, LM.r_elbow, LM.r_wrist];
    for (let k = 0; k + 1 < s.length; k++) {
      if (vis(s[k]!) < VIS_MIN || vis(s[k + 1]!) < VIS_MIN) continue;
      const a = px(s[k]!);
      const b = px(s[k + 1]!);
      if ((row - a.y) * (row - b.y) <= 0 && Math.abs(b.y - a.y) > 1e-6) {
        return a.x + ((b.x - a.x) * (row - a.y)) / (b.y - a.y);
      }
    }
    return null;
  };

  let armsClear = true;
  let levels = 0;
  const torsoWidthCm = (frac: number): number | undefined => {
    const row = Math.round(rowOfLevel(anchors, frac) * m.height - 0.5);
    const edges = runEdges(m, row, axisX(row + 0.5));
    if (!edges) return undefined;
    let { left, right } = edges;
    for (const side of ['l', 'r'] as const) {
      const xa = armX(side, row + 0.5);
      if (xa === null) continue;
      const isLeftOfAxis = xa < axisX(row + 0.5);
      // brazo pegado al lado del tronco: su borde exterior es el borde de la silueta
      if (isLeftOfAxis && xa > left - 0.6 * armR && xa < left + 2.4 * armR) {
        left = Math.max(left, xa + armR);
        armsClear = false;
      } else if (!isLeftOfAxis && xa < right + 0.6 * armR && xa > right - 2.4 * armR) {
        right = Math.min(right, xa - armR);
        armsClear = false;
      }
    }
    const w = (right - left) / pxPerM;
    levels++;
    return w > 0.05 && w < 0.9 ? 100 * w : undefined;
  };

  const chest = torsoWidthCm(LEVELS.chest);
  const waist = torsoWidthCm(LEVELS.waist);
  const hip = torsoWidthCm(LEVELS.hip);

  // cuello: anchura mínima en una ventana de ±0.025·H alrededor de su nivel, sobre el eje hombros→orejas
  let neck: number | undefined;
  {
    const earsOk = vis(LM.l_ear) >= 0.3 || vis(LM.r_ear) >= 0.3;
    const earMid: Pt = earsOk
      ? {
          x: ([LM.l_ear, LM.r_ear].filter((i) => vis(i) >= 0.3).reduce((s, i) => s + px(i).x, 0)) /
            [LM.l_ear, LM.r_ear].filter((i) => vis(i) >= 0.3).length,
          y: ([LM.l_ear, LM.r_ear].filter((i) => vis(i) >= 0.3).reduce((s, i) => s + px(i).y, 0)) /
            [LM.l_ear, LM.r_ear].filter((i) => vis(i) >= 0.3).length,
        }
      : px(LM.nose);
    const r0 = Math.round(rowOfLevel(anchors, LEVELS.neck - 0.025) * m.height - 0.5);
    const r1 = Math.round(rowOfLevel(anchors, LEVELS.neck + 0.025) * m.height - 0.5);
    let best = Infinity;
    for (let row = Math.min(r0, r1); row <= Math.max(r0, r1); row++) {
      const t = (row + 0.5 - shMid.y) / (earMid.y - shMid.y || 1);
      const x0 = shMid.x + (earMid.x - shMid.x) * clamp(t, 0, 1);
      const e = runEdges(m, row, x0, 0.02);
      if (!e) continue;
      const w = (e.right - e.left) / pxPerM;
      if (w > 0.06 && w < 0.22) best = Math.min(best, w);
    }
    if (Number.isFinite(best)) {
      neck = 100 * best;
      levels++;
    }
  }

  // muslo: 2 × distancia del eje cadera→rodilla al borde exterior, a la altura del nivel de muslo
  let thigh: number | undefined;
  {
    const row = Math.round(rowOfLevel(anchors, LEVELS.thigh) * m.height - 0.5);
    const ws: number[] = [];
    for (const [h, k] of [
      [LM.l_hip, LM.l_knee],
      [LM.r_hip, LM.r_knee],
    ] as const) {
      if (vis(h) < VIS_MIN || vis(k) < VIS_MIN) continue;
      const a = px(h);
      const b = px(k);
      if (Math.abs(b.y - a.y) < 1e-6) continue;
      const t = (row + 0.5 - a.y) / (b.y - a.y);
      if (t < -0.2 || t > 1.1) continue;
      const x = a.x + (b.x - a.x) * t;
      const outward: 1 | -1 = x < axisX(row + 0.5) ? -1 : 1;
      const d = outerDistance(m, row, x, outward);
      if (d !== null) ws.push((2 * d) / pxPerM);
    }
    if (ws.length > 0) {
      const w = ws.reduce((s, x) => s + x, 0) / ws.length;
      if (w > 0.08 && w < 0.4) {
        thigh = 100 * w;
        levels++;
      }
    }
  }

  return {
    pxPerM,
    ...(chest !== undefined ? { chestCm: chest } : {}),
    ...(waist !== undefined ? { waistCm: waist } : {}),
    ...(hip !== undefined ? { hipCm: hip } : {}),
    ...(neck !== undefined ? { neckCm: neck } : {}),
    ...(thigh !== undefined ? { thighCm: thigh } : {}),
    armsClear,
    levels,
  };
}
