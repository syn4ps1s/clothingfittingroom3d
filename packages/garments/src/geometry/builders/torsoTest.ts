import { type BodyModel } from '@fitroom/shared';
import { getBodyField } from '../core/bodyField.js';
import { GarmentMesh, newSurface } from '../core/mesh.js';
import { TorsoSlices } from '../core/slices.js';
import { radiiToPoints, offsetContour, solveOffsetForPerimeter, perimeter2D } from '../core/ring.js';
import { emitMesh } from '../core/emit.js';
import { buildAdjacency, pushOutAndSpread } from '../core/relax.js';

export function torsoTest(body: BodyModel, chestC: number, hemC: number, yHem: number, yTop: number) {
  const field = getBodyField(body);
  const K = 160;
  const sl = new TorsoSlices(field, K);
  const mesh = new GarmentMesh();
  const e = 0.0075;
  const rows = Math.ceil((yTop - yHem) / e) + 1;
  const s = newSurface('torso', rows, K + 1, { wrap: true });
  const tmp = new Float64Array(K * 2);
  const T = 0.0009;
  const clear = T / 2 + 0.001;
  for (let r = 0; r < rows; r++) {
    const y = yHem + ((yTop - yHem) * r) / (rows - 1);
    const sc = sl.interp(y);
    const tH = Math.min(1, Math.max(0, (y - yHem) / 0.5));
    const target = hemC + (chestC - hemC) * tH;
    const eff = Math.max(target, sc.pBody + 2 * Math.PI * clear);
    // mezcla entre contorno del cuerpo y su envolvente según la holgura disponible
    const h = Math.min(1, Math.max(0, 1 - (eff - sc.pBody) / Math.max(1e-6, sc.pHull - sc.pBody)));
    const mix = new Float64Array(K);
    for (let i = 0; i < K; i++) mix[i] = sc.hull[i]! + (sc.body[i]! - sc.hull[i]!) * h;
    const pts = radiiToPoints(mix);
    const pm = perimeter2D(pts);
    const target2 = Math.max(eff, pm + 2 * Math.PI * clear);
    const eo = solveOffsetForPerimeter(pts, target2, tmp);
    const off = offsetContour(pts, eo, new Float64Array(K * 2));
    for (let i = 0; i <= K; i++) {
      const ii = i % K;
      const a = off[ii * 2]!, b = off[ii * 2 + 1]!;
      // u = -z, v = +x
      s.node[r * (K + 1) + i] = mesh.addNode(b, y, sc.zc - a, clear);
    }
    // el último nodo duplica al primero
    s.node[r * (K + 1) + K] = s.node[r * (K + 1)]!;
  }
  mesh.surfaces.push(s);
  const adj = buildAdjacency(mesh);
  pushOutAndSpread(mesh, field, adj);
  return emitMesh(mesh, field);
}
