import type { GarmentMeshGroup } from '@fitroom/shared';
import { sampleSdfGrad } from './sdfGrid.js';
import type { BodyField } from './bodyField.js';
import { SLOT_NAMES, type GarmentMesh, type Surface } from './mesh.js';

export interface Emitted {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  /** nodo de cada vértice */
  vertNode: Uint32Array;
  /** superficie (índice) de cada vértice */
  vertSurface: Uint16Array;
  /** triángulo -> superficie */
  groups: GarmentMeshGroup[];
  /** nº de nodos */
  nodeCount: number;
}

const grad = new Float64Array(3);

/** Coste de estiramiento UV de una superficie: media de (ln anisotropía)² sobre sus celdas (triángulo A,D,B). */
function uvCost(P: Float64Array, s: Surface, U: Float64Array, V: Float64Array): number {
  let sum = 0;
  let cnt = 0;
  for (let r = 0; r + 1 < s.rows; r++)
    for (let c = 0; c + 1 < s.cols; c++) {
      if (!s.cellOn[r * (s.cols - 1) + c]) continue;
      const a = r * s.cols + c,
        b = a + 1,
        d = a + s.cols;
      const na = s.node[a]!,
        nb = s.node[b]!,
        nd = s.node[d]!;
      if (na < 0 || nb < 0 || nd < 0) continue;
      const p1x = P[nd * 3]! - P[na * 3]!,
        p1y = P[nd * 3 + 1]! - P[na * 3 + 1]!,
        p1z = P[nd * 3 + 2]! - P[na * 3 + 2]!;
      const p2x = P[nb * 3]! - P[na * 3]!,
        p2y = P[nb * 3 + 1]! - P[na * 3 + 1]!,
        p2z = P[nb * 3 + 2]! - P[na * 3 + 2]!;
      const du1 = U[d]! - U[a]!,
        dv1 = V[d]! - V[a]!,
        du2 = U[b]! - U[a]!,
        dv2 = V[b]! - V[a]!;
      const det = du1 * dv2 - du2 * dv1;
      if (Math.abs(det) < 1e-12) {
        sum += 9;
        cnt++;
        continue;
      }
      const sx = (p1x * dv2 - p2x * dv1) / det,
        sy = (p1y * dv2 - p2y * dv1) / det,
        sz = (p1z * dv2 - p2z * dv1) / det;
      const tx = (p2x * du1 - p1x * du2) / det,
        ty = (p2y * du1 - p1y * du2) / det,
        tz = (p2z * du1 - p1z * du2) / det;
      const A = sx * sx + sy * sy + sz * sz,
        B = sx * tx + sy * ty + sz * tz,
        C = tx * tx + ty * ty + tz * tz;
      const disc = Math.sqrt(Math.max(0, (A - C) * (A - C) + 4 * B * B));
      const l1 = 0.5 * (A + C + disc),
        l2 = Math.max(1e-18, 0.5 * (A + C - disc));
      const la = 0.5 * Math.log(l1 / l2);
      sum += la * la;
      cnt++;
    }
  return cnt ? sum / cnt : 0;
}

/** Decide si la superficie debe invertirse para que sus normales apunten fuera del cuerpo (votación con el SDF). */
function decideFlip(mesh: GarmentMesh, f: BodyField, s: Surface): boolean {
  let vote = 0;
  const P = mesh.pos.data;
  for (let r = 0; r + 1 < s.rows; r++)
    for (let c = 0; c + 1 < s.cols; c++) {
      const ci = r * (s.cols - 1) + c;
      if (!s.cellOn[ci]) continue;
      const a = s.node[r * s.cols + c]!,
        b = s.node[r * s.cols + c + 1]!,
        d = s.node[(r + 1) * s.cols + c]!;
      if (a < 0 || b < 0 || d < 0) continue;
      // normal de la quad con el orden por defecto: (A, D, B) -> (D-A) x (B-A)
      const ux = P[d * 3]! - P[a * 3]!,
        uy = P[d * 3 + 1]! - P[a * 3 + 1]!,
        uz = P[d * 3 + 2]! - P[a * 3 + 2]!;
      const vx = P[b * 3]! - P[a * 3]!,
        vy = P[b * 3 + 1]! - P[a * 3 + 1]!,
        vz = P[b * 3 + 2]! - P[a * 3 + 2]!;
      const nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx;
      const cx = (P[a * 3]! + P[b * 3]! + P[d * 3]!) / 3;
      const cy = (P[a * 3 + 1]! + P[b * 3 + 1]! + P[d * 3 + 1]!) / 3;
      const cz = (P[a * 3 + 2]! + P[b * 3 + 2]! + P[d * 3 + 2]!) / 3;
      const sd = sampleSdfGrad(f.sdf, cx, cy, cz, grad);
      const gl = Math.hypot(grad[0]!, grad[1]!, grad[2]!);
      if (gl < 1e-6) continue;
      // peso: más cerca del cuerpo, más fiable
      const w = 1 / (0.02 + Math.abs(sd));
      const dot = (nx * grad[0]! + ny * grad[1]! + nz * grad[2]!) / (gl * Math.hypot(nx, ny, nz) || 1);
      vote += dot * w;
    }
  const outwardExpected = !s.inner;
  return outwardExpected ? vote < 0 : vote > 0;
}

/**
 * Convierte las superficies en una malla de vértices/índices: vértices por celda, UV físicas (metros) por
 * longitud de arco, triángulos con la diagonal más corta y orientación hacia fuera, normales suaves soldadas por nodo.
 */
export function emitMesh(mesh: GarmentMesh, f: BodyField): Emitted {
  const P = mesh.pos.data;
  // 1) vértices: sólo los usados por alguna celda activa
  let vcount = 0;
  const used: Uint8Array[] = [];
  for (const s of mesh.surfaces) {
    const u = new Uint8Array(s.rows * s.cols);
    for (let r = 0; r + 1 < s.rows; r++)
      for (let c = 0; c + 1 < s.cols; c++) {
        if (!s.cellOn[r * (s.cols - 1) + c]) continue;
        const a = r * s.cols + c,
          b = a + 1,
          d = a + s.cols,
          e = d + 1;
        if (s.node[a]! < 0 || s.node[b]! < 0 || s.node[d]! < 0 || s.node[e]! < 0) {
          s.cellOn[r * (s.cols - 1) + c] = 0;
          continue;
        }
        u[a] = u[b] = u[d] = u[e] = 1;
      }
    used.push(u);
    s.vert = new Int32Array(s.rows * s.cols).fill(-1);
    for (let i = 0; i < u.length; i++) if (u[i]) s.vert[i] = vcount++;
  }
  const positions = new Float32Array(vcount * 3);
  const uvs = new Float32Array(vcount * 2);
  const vertNode = new Uint32Array(vcount);
  const vertSurface = new Uint16Array(vcount);
  // 2) posiciones y UV (en metros: uvMetersPerTile = 1)
  let vOff = 0;
  mesh.surfaces.forEach((s, si) => {
    const U = new Float64Array(s.rows * s.cols);
    const V = new Float64Array(s.rows * s.cols);
    const rowTotal = new Float64Array(s.rows);
    // longitud de arco acumulada por fila (fracción f) y total
    for (let r = 0; r < s.rows; r++) {
      let acc = 0;
      let prev = -1;
      for (let c = 0; c < s.cols; c++) {
        const n = s.node[r * s.cols + c]!;
        if (n < 0) continue;
        if (prev >= 0)
          acc += Math.hypot(P[n * 3]! - P[prev * 3]!, P[n * 3 + 1]! - P[prev * 3 + 1]!, P[n * 3 + 2]! - P[prev * 3 + 2]!);
        U[r * s.cols + c] = acc;
        prev = n;
      }
      rowTotal[r] = acc;
    }
    const Urow = Float64Array.from(U);
    if (s.wrap) {
      // u puede ser (A) la longitud de arco propia de cada fila (isométrica a lo largo de las filas pero con cizalla
      // si las filas encogen: cúpulas/conos) o (B) constante por columna tomada de la fila de perímetro mediano
      // (sin cizalla, comprimida donde la fila es corta). Se mezclan con el peso que minimice el estiramiento.
      const complete: number[] = [];
      for (let r = 0; r < s.rows; r++) {
        let ok = true;
        for (let c = 0; c < s.cols && ok; c++) if (s.node[r * s.cols + c]! < 0) ok = false;
        if (ok && rowTotal[r]! > 0) complete.push(r);
      }
      if (complete.length) {
        complete.sort((a, b) => rowTotal[a]! - rowTotal[b]!);
        const refRow = complete[complete.length >> 1]!;
        const Vcol = new Float64Array(s.rows * s.cols);
        for (let c = 0; c < s.cols; c++) {
          let acc = 0;
          let prev = -1;
          for (let r = 0; r < s.rows; r++) {
            const n = s.node[r * s.cols + c]!;
            if (n < 0) continue;
            if (prev >= 0)
              acc += Math.hypot(P[n * 3]! - P[prev * 3]!, P[n * 3 + 1]! - P[prev * 3 + 1]!, P[n * 3 + 2]! - P[prev * 3 + 2]!);
            Vcol[r * s.cols + c] = acc;
            prev = n;
          }
          if (s.vFromEnd) {
            for (let r = 0; r < s.rows; r++) if (s.node[r * s.cols + c]! >= 0) Vcol[r * s.cols + c] = acc - Vcol[r * s.cols + c]!;
          }
        }
        const Uref = new Float64Array(s.rows * s.cols);
        for (let r = 0; r < s.rows; r++)
          for (let c = 0; c < s.cols; c++) Uref[r * s.cols + c] = Urow[refRow * s.cols + c]!;
        let bestA = 0;
        let bestCost = Infinity;
        const Utry = new Float64Array(s.rows * s.cols);
        for (const alpha of [0, 0.25, 0.5, 0.75, 1]) {
          for (let i = 0; i < Utry.length; i++) Utry[i] = alpha * Urow[i]! + (1 - alpha) * Uref[i]!;
          const cost = uvCost(P, s, Utry, Vcol);
          if (cost < bestCost) {
            bestCost = cost;
            bestA = alpha;
          }
        }
        for (let i = 0; i < U.length; i++) U[i] = bestA * Urow[i]! + (1 - bestA) * Uref[i]!;
      }
    }
    for (let c = 0; c < s.cols; c++) {
      let acc = 0;
      let prev = -1;
      for (let r = 0; r < s.rows; r++) {
        const n = s.node[r * s.cols + c]!;
        if (n < 0) continue;
        if (prev >= 0)
          acc += Math.hypot(P[n * 3]! - P[prev * 3]!, P[n * 3 + 1]! - P[prev * 3 + 1]!, P[n * 3 + 2]! - P[prev * 3 + 2]!);
        V[r * s.cols + c] = acc;
        prev = n;
      }
    }
    if (s.vFromEnd) {
      for (let c = 0; c < s.cols; c++) {
        let total = 0;
        for (let r = 0; r < s.rows; r++) if (s.node[r * s.cols + c]! >= 0) total = Math.max(total, V[r * s.cols + c]!);
        for (let r = 0; r < s.rows; r++) if (s.node[r * s.cols + c]! >= 0) V[r * s.cols + c] = total - V[r * s.cols + c]!;
      }
    }
    let vmax = 0;
    let umax = 0;
    for (let i = 0; i < V.length; i++)
      if (used[si]![i]) {
        if (V[i]! > vmax) vmax = V[i]!;
        if (U[i]! > umax) umax = U[i]!;
      }
    // orientación de UV: el mapa no debe quedar en espejo visto desde fuera (voto con la diagonal por defecto)
    s.flip = decideFlip(mesh, f, s);
    let vote = 0;
    for (let r = 0; r + 1 < s.rows; r++)
      for (let c = 0; c + 1 < s.cols; c++) {
        if (!s.cellOn[r * (s.cols - 1) + c]) continue;
        const a = r * s.cols + c,
          b = a + 1,
          d = a + s.cols;
        // triángulo por defecto (A, D, B): det = (uD-uA)(vB-vA) - (uB-uA)(vD-vA)
        const det = (U[d]! - U[a]!) * (V[b]! - V[a]!) - (U[b]! - U[a]!) * (V[d]! - V[a]!);
        vote += s.flip ? -det : det;
      }
    const mirror = vote < 0;
    for (let i = 0; i < used[si]!.length; i++) {
      if (!used[si]![i]) continue;
      const v = s.vert[i]!;
      const n = s.node[i]!;
      positions[v * 3] = P[n * 3]!;
      positions[v * 3 + 1] = P[n * 3 + 1]!;
      positions[v * 3 + 2] = P[n * 3 + 2]!;
      uvs[v * 2] = (mirror ? umax - U[i]! : U[i]!) + s.uOffset;
      uvs[v * 2 + 1] = V[i]! + vOff + s.vOffset;
      vertNode[v] = n;
      vertSurface[v] = si;
    }
    vOff += vmax + 0.06;
  });
  // 3) triángulos por ranura
  const tris: number[][] = SLOT_NAMES.map(() => []);
  mesh.surfaces.forEach((s) => {
    for (let r = 0; r + 1 < s.rows; r++)
      for (let c = 0; c + 1 < s.cols; c++) {
        const ci = r * (s.cols - 1) + c;
        if (!s.cellOn[ci]) continue;
        const iA = r * s.cols + c,
          iB = iA + 1,
          iD = iA + s.cols,
          iC = iD + 1;
        const nA = s.node[iA]!,
          nB = s.node[iB]!,
          nC = s.node[iC]!,
          nD = s.node[iD]!;
        const dBD = (P[nB * 3]! - P[nD * 3]!) ** 2 + (P[nB * 3 + 1]! - P[nD * 3 + 1]!) ** 2 + (P[nB * 3 + 2]! - P[nD * 3 + 2]!) ** 2;
        const dAC = (P[nA * 3]! - P[nC * 3]!) ** 2 + (P[nA * 3 + 1]! - P[nC * 3 + 1]!) ** 2 + (P[nA * 3 + 2]! - P[nC * 3 + 2]!) ** 2;
        const vA = s.vert[iA]!,
          vB = s.vert[iB]!,
          vC = s.vert[iC]!,
          vD = s.vert[iD]!;
        const t = tris[s.cellSlot[ci]!]!;
        // orden por defecto (diagonal D–B): (A,D,B) (D,C,B); alternativa (diagonal A–C): (A,D,C) (A,C,B)
        const q = dBD <= dAC ? [vA, vD, vB, vD, vC, vB] : [vA, vD, vC, vA, vC, vB];
        if (s.flip) t.push(q[0]!, q[2]!, q[1]!, q[3]!, q[5]!, q[4]!);
        else t.push(...q);
      }
  });
  const groups: GarmentMeshGroup[] = [];
  let total = 0;
  for (const t of tris) total += t.length;
  const indices = new Uint32Array(total);
  let off = 0;
  tris.forEach((t, slot) => {
    if (t.length === 0) return;
    indices.set(t, off);
    groups.push({ start: off, count: t.length, slot: SLOT_NAMES[slot]! });
    off += t.length;
  });
  // 4) normales suaves soldadas por nodo (área ponderada)
  const nodeN = new Float64Array(mesh.nodeCount * 3);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]!,
      b = indices[t + 1]!,
      c = indices[t + 2]!;
    const ax = positions[a * 3]!,
      ay = positions[a * 3 + 1]!,
      az = positions[a * 3 + 2]!;
    const e1x = positions[b * 3]! - ax,
      e1y = positions[b * 3 + 1]! - ay,
      e1z = positions[b * 3 + 2]! - az;
    const e2x = positions[c * 3]! - ax,
      e2y = positions[c * 3 + 1]! - ay,
      e2z = positions[c * 3 + 2]! - az;
    const nx = e1y * e2z - e1z * e2y,
      ny = e1z * e2x - e1x * e2z,
      nz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) {
      const n = vertNode[v]!;
      nodeN[n * 3] = nodeN[n * 3]! + nx;
      nodeN[n * 3 + 1] = nodeN[n * 3 + 1]! + ny;
      nodeN[n * 3 + 2] = nodeN[n * 3 + 2]! + nz;
    }
  }
  const normals = new Float32Array(vcount * 3);
  for (let v = 0; v < vcount; v++) {
    const n = vertNode[v]!;
    let x = nodeN[n * 3]!,
      y = nodeN[n * 3 + 1]!,
      z = nodeN[n * 3 + 2]!;
    const l = Math.hypot(x, y, z);
    if (l > 1e-20) {
      x /= l;
      y /= l;
      z /= l;
    } else {
      x = 0;
      y = 1;
      z = 0;
    }
    normals[v * 3] = x;
    normals[v * 3 + 1] = y;
    normals[v * 3 + 2] = z;
  }
  return { positions, normals, uvs, indices, vertNode, vertSurface, groups, nodeCount: mesh.nodeCount };
}
