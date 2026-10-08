import {
  J,
  clamp,
  lerp,
  q,
  v3,
  type CameraIntrinsics,
  type Measurements,
  type Quat,
  type RestSkeleton,
  type SegmentationMask,
  type Vec3,
} from '@fitroom/shared';
import { cameraScales, sanitizeCamera } from './camera.js';
import { TORSO_DEPTH_RATIO } from './calibration.js';

/**
 * Siluetas sintéticas para probar el estimador de medidas sin cámara.
 *
 * - `renderCapsuleMask`: silueta aproximada de un cuerpo (tronco elíptico + cápsulas cónicas).
 * - `rasterizeMeshMask`: silueta de una malla triangulada cualquiera (p. ej. el cuerpo de
 *   @fitroom/body ya skinneado y llevado a espacio cámara) — la «verdad» independiente del estimador.
 *
 * Ambas devuelven máscaras de 0..255 con antialiasing, en imagen SIN espejar (fila 0 = arriba).
 */

interface Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  readonly focalPx: number;
  readonly scales: ReturnType<typeof cameraScales>;
}

function makeRaster(camera: CameraIntrinsics, width: number, height: number): Raster {
  const scales = cameraScales(sanitizeCamera(camera));
  return {
    width,
    height,
    data: new Uint8Array(width * height),
    focalPx: height / 2 / scales.tanY,
    scales,
  };
}

/** Proyección a píxeles (x a la derecha, y hacia abajo) y escala px/m a esa profundidad. */
function toPixel(r: Raster, p: Vec3): { x: number; y: number; s: number } {
  const depth = Math.max(-p[2], 0.05);
  const s = r.focalPx / depth;
  return { x: r.width / 2 + p[0] * s, y: r.height / 2 - p[1] * s, s };
}

function put(r: Raster, ix: number, iy: number, cov: number): void {
  const i = iy * r.width + ix;
  const v = Math.round(clamp(cov, 0, 1) * 255);
  if (v > r.data[i]!) r.data[i] = v;
}

/** Cápsula cónica en espacio cámara: extremos `a`,`b` con radios `ra`,`rb` (m). */
function capsule(r: Raster, a: Vec3, b: Vec3, ra: number, rb: number): void {
  const pa = toPixel(r, a);
  const pb = toPixel(r, b);
  const rpa = ra * pa.s;
  const rpb = rb * pb.s;
  const x0 = Math.max(0, Math.floor(Math.min(pa.x - rpa, pb.x - rpb) - 1));
  const x1 = Math.min(r.width - 1, Math.ceil(Math.max(pa.x + rpa, pb.x + rpb) + 1));
  const y0 = Math.max(0, Math.floor(Math.min(pa.y - rpa, pb.y - rpb) - 1));
  const y1 = Math.min(r.height - 1, Math.ceil(Math.max(pa.y + rpa, pb.y + rpb) + 1));
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const len2 = dx * dx + dy * dy;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5 - pa.x;
      const py = y + 0.5 - pa.y;
      const t = len2 > 1e-12 ? clamp((px * dx + py * dy) / len2, 0, 1) : 0;
      const dist = Math.hypot(px - t * dx, py - t * dy);
      const rad = lerp(rpa, rpb, t);
      const cov = rad - dist + 0.5;
      if (cov > 0) put(r, x, y, cov);
    }
  }
}

/**
 * Tira del tronco: segmentos con extremos planos y semi-anchura (horizontal en imagen) variable.
 * `hw` en metros (semi-extensión visible en el eje X de la imagen).
 */
function strip(r: Raster, a: Vec3, b: Vec3, hwA: number, hwB: number): void {
  const pa = toPixel(r, a);
  const pb = toPixel(r, b);
  const wa = hwA * pa.s;
  const wb = hwB * pb.s;
  const x0 = Math.max(0, Math.floor(Math.min(pa.x - wa, pb.x - wb) - 1));
  const x1 = Math.min(r.width - 1, Math.ceil(Math.max(pa.x + wa, pb.x + wb) + 1));
  const y0 = Math.max(0, Math.floor(Math.min(pa.y, pb.y) - 1));
  const y1 = Math.min(r.height - 1, Math.ceil(Math.max(pa.y, pb.y) + 1));
  const dy = pb.y - pa.y;
  if (Math.abs(dy) < 1e-6) return;
  for (let y = y0; y <= y1; y++) {
    const t = (y + 0.5 - pa.y) / dy;
    if (t < 0 || t > 1) continue;
    const cx = lerp(pa.x, pb.x, t);
    const hw = lerp(wa, wb, t);
    const xa = Math.max(0, Math.floor(cx - hw - 1));
    const xb = Math.min(r.width - 1, Math.ceil(cx + hw + 1));
    for (let x = xa; x <= xb; x++) {
      const cov = hw - Math.abs(x + 0.5 - cx) + 0.5;
      if (cov > 0) put(r, x, y, cov);
    }
  }
}

/** Semi-ejes (m) de la sección elíptica de circunferencia C (cm) y razón profundidad/ancho. */
export function ellipseAxes(circumferenceCm: number, depthRatio: number): { a: number; b: number } {
  const c = circumferenceCm / 100;
  // Euler: C ≈ 2π·sqrt((a²+b²)/2) con b = ratio·a
  const a = (c / (2 * Math.PI)) * Math.sqrt(2 / (1 + depthRatio * depthRatio));
  return { a, b: depthRatio * a };
}

export interface CapsuleMaskInput {
  readonly rest: RestSkeleton;
  readonly measurements: Measurements;
  /** Posiciones y rotaciones FK (espacio cámara) de los 21 joints. */
  readonly fkPositions: readonly Vec3[];
  readonly fkRotations: readonly Quat[];
  readonly camera: CameraIntrinsics;
  readonly width: number;
  readonly height: number;
}

/** Silueta aproximada del cuerpo a partir del esqueleto posado y las medidas. */
export function renderCapsuleMask(inp: CapsuleMaskInput): SegmentationMask {
  const { rest, measurements: m, fkPositions: P, fkRotations: R } = inp;
  const r = makeRaster(
    inp.camera,
    Math.max(8, Math.round(inp.width)),
    Math.max(8, Math.round(inp.height)),
  );
  const H = rest.height;
  const j = (n: number): Vec3 => P[n]!;
  const dirOf = (n: number, local: Vec3): Vec3 => q.rotate(R[n]!, local);

  // ---- tronco: tira entre estaciones a lo largo de pelvis→spine→chest→neck --------------------
  const hip = ellipseAxes(m.hipCm, TORSO_DEPTH_RATIO.hip);
  const waist = ellipseAxes(m.waistCm, TORSO_DEPTH_RATIO.waist);
  const chest = ellipseAxes(m.chestCm, TORSO_DEPTH_RATIO.chest);
  const neckR = m.neckCm / 100 / (2 * Math.PI);
  const shoulderHalf = m.shoulderWidthCm / 200;
  const restY = (n: number): number => rest.joints[n]!.position[1];
  // nodos: [joint, semi-eje lateral a, semi-eje profundidad b]
  const crotch = v3.add(j(J.pelvis), dirOf(J.pelvis, [0, -0.095 * H, 0]));
  const stations: { p: Vec3; rot: Quat; a: number; b: number }[] = [
    { p: crotch, rot: R[J.pelvis]!, a: hip.a * 0.92, b: hip.b * 0.92 },
    { p: j(J.pelvis), rot: R[J.pelvis]!, a: hip.a, b: hip.b },
    { p: j(J.spine), rot: R[J.spine]!, a: waist.a, b: waist.b },
    { p: j(J.chest), rot: R[J.chest]!, a: chest.a, b: chest.b },
    {
      p: v3.add(j(J.chest), dirOf(J.chest, [0, (restY(J.neck) - restY(J.chest)) * 0.55, 0])),
      rot: R[J.chest]!,
      a: shoulderHalf * 0.92,
      b: chest.b * 0.8,
    },
    { p: j(J.neck), rot: R[J.chest]!, a: neckR * 1.5, b: neckR * 1.3 },
  ];
  const halfExtentX = (rot: Quat, a: number, b: number): number => {
    const lat = q.rotate(rot, [1, 0, 0]);
    const dep = q.rotate(rot, [0, 0, 1]);
    return Math.hypot(a * lat[0], b * dep[0]);
  };
  for (let k = 0; k + 1 < stations.length; k++) {
    const s0 = stations[k]!;
    const s1 = stations[k + 1]!;
    strip(r, s0.p, s1.p, halfExtentX(s0.rot, s0.a, s0.b), halfExtentX(s1.rot, s1.a, s1.b));
  }

  // ---- cuello y cabeza ------------------------------------------------------------------------
  capsule(r, j(J.neck), j(J.head), neckR, neckR);
  const hA = v3.add(j(J.head), dirOf(J.head, [0, 0.045 * H, 0.004 * H]));
  const hB = v3.add(j(J.head), dirOf(J.head, [0, 0.085 * H, 0.004 * H]));
  capsule(r, hA, hB, 0.046 * H, 0.046 * H);

  // ---- brazos ---------------------------------------------------------------------------------
  for (const [ua, fa, hd] of [
    [J.l_upper_arm, J.l_forearm, J.l_hand],
    [J.r_upper_arm, J.r_forearm, J.r_hand],
  ] as const) {
    capsule(r, j(ua), j(ua), 0.034 * H, 0.034 * H); // deltoides
    capsule(r, j(ua), j(fa), 0.027 * H, 0.021 * H);
    capsule(r, j(fa), j(hd), 0.021 * H, 0.016 * H);
    // la mano continúa la dirección del antebrazo
    const fdir = v3.normalize(v3.sub(j(hd), j(fa)));
    capsule(r, j(hd), v3.add(j(hd), v3.scale(fdir, 0.1 * H)), 0.017 * H, 0.012 * H);
  }

  // ---- piernas --------------------------------------------------------------------------------
  const thighR = m.thighCm / 100 / (2 * Math.PI);
  for (const [th, ca, ft, to] of [
    [J.l_thigh, J.l_calf, J.l_foot, J.l_toes],
    [J.r_thigh, J.r_calf, J.r_foot, J.r_toes],
  ] as const) {
    capsule(r, j(th), j(ca), thighR, 0.034 * H);
    capsule(r, j(ca), j(ft), 0.04 * H, 0.022 * H);
    capsule(r, j(ft), j(to), 0.024 * H, 0.02 * H);
  }
  return { width: r.width, height: r.height, data: r.data };
}

export interface MeshMaskInput {
  /** xyz por vértice en espacio cámara (m). */
  readonly positions: Float32Array | readonly number[];
  readonly indices: Uint32Array | readonly number[];
  readonly camera: CameraIntrinsics;
  readonly width: number;
  readonly height: number;
  /** supermuestreo por eje para el antialiasing (por defecto 3) */
  readonly supersample?: number;
}

/** Rasteriza la silueta de una malla (sin z-buffer: unión de triángulos). */
export function rasterizeMeshMask(inp: MeshMaskInput): SegmentationMask {
  const ss = Math.max(1, Math.floor(inp.supersample ?? 3));
  const W = Math.max(8, Math.round(inp.width));
  const Hh = Math.max(8, Math.round(inp.height));
  const r = makeRaster(inp.camera, W * ss, Hh * ss);
  const pos = inp.positions;
  const n = Math.floor(pos.length / 3);
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = toPixel(r, [pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!]);
    px[i] = p.x;
    py[i] = p.y;
  }
  const hi = new Uint8Array(r.width * r.height);
  const idx = inp.indices;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t]!;
    const b = idx[t + 1]!;
    const c = idx[t + 2]!;
    if (a >= n || b >= n || c >= n) continue;
    const x0 = Math.max(0, Math.floor(Math.min(px[a]!, px[b]!, px[c]!)));
    const x1 = Math.min(r.width - 1, Math.ceil(Math.max(px[a]!, px[b]!, px[c]!)));
    const y0 = Math.max(0, Math.floor(Math.min(py[a]!, py[b]!, py[c]!)));
    const y1 = Math.min(r.height - 1, Math.ceil(Math.max(py[a]!, py[b]!, py[c]!)));
    const area = (px[b]! - px[a]!) * (py[c]! - py[a]!) - (px[c]! - px[a]!) * (py[b]! - py[a]!);
    if (Math.abs(area) < 1e-9) continue;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const qx = x + 0.5;
        const qy = y + 0.5;
        const w0 = ((px[b]! - qx) * (py[c]! - qy) - (px[c]! - qx) * (py[b]! - qy)) / area;
        const w1 = ((px[c]! - qx) * (py[a]! - qy) - (px[a]! - qx) * (py[c]! - qy)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) hi[y * r.width + x] = 255;
      }
    }
  }
  // reducción por promedio de bloques
  const out = new Uint8Array(W * Hh);
  const norm = 1 / (ss * ss);
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let dy = 0; dy < ss; dy++) {
        const row = (y * ss + dy) * r.width + x * ss;
        for (let dx = 0; dx < ss; dx++) s += hi[row + dx]!;
      }
      out[y * W + x] = Math.round(s * norm);
    }
  }
  return { width: W, height: Hh, data: out };
}
