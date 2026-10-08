import { J } from '@fitroom/shared';
import { clampN, pchip } from './geom.js';
import { torsoGirthCm } from './measure.js';
import type { BodyDims } from './dims.js';

/**
 * Corrección fina de circunferencias sobre la malla ya generada. La discretización de la rejilla y el suavizado
 * introducen errores de ≈ ±1 % en secciones pequeñas o con curvatura alta (cuello) y pérdidas en el pecho; se
 * miden pecho/cintura/cadera/cuello con el MISMO corte de plano que `measureBody` y se aplica un escalado radial
 * suave (respecto al eje del cuerpo) que lleva cada perímetro exactamente al valor pedido.
 * Sólo se mueven vértices del tronco/pelvis (huesos pelvis, spine, chest y muslos por encima de la entrepierna) y,
 * para el cuello, los del hueso neck/head en su altura: nunca brazos ni piernas.
 */
export function correctGirths(
  dims: BodyDims,
  positions: Float32Array,
  indices: Uint32Array,
  dominant: Uint8Array,
): { applied: Record<string, number> } {
  const { lm, H } = dims;
  const applied: Record<string, number> = {};
  const rings: { name: string; y: number; target: number; z: number }[] = [
    { name: 'hip', y: lm.hip, target: dims.hipC * 100, z: 0 },
    { name: 'waist', y: lm.waist, target: dims.waistC * 100, z: 0 },
    { name: 'chest', y: lm.chest, target: dims.chestC * 100, z: 0 },
  ];
  const ys: number[] = [lm.crotch - 0.03 * H];
  const gs: number[] = [1];
  for (const r of rings) {
    const got = torsoGirthCm(positions, indices, r.y, r.z);
    const g = got > 0 ? clampN(r.target / got, 0.9, 1.1) : 1;
    applied[r.name] = g;
    ys.push(r.y);
    gs.push(g);
  }
  // por encima del pecho el factor decae a 1 al llegar a la axila alta
  ys.push(lm.chest + 0.06 * H);
  gs.push(1);
  const f = pchip(ys, gs);
  const neckY = lm.neck;
  const gNeckRaw = torsoGirthCm(positions, indices, neckY, 0.006 * H);
  const gNeck = gNeckRaw > 0 ? clampN(dims.neckC * 100 / gNeckRaw, 0.9, 1.1) : 1;
  applied.neck = gNeck;
  const nz = 0.006 * H;
  const nwin = 0.014 * H;
  const crotch = lm.crotch;
  const yLo = ys[0]!;
  const yHi = ys[ys.length - 1]!;
  for (let v = 0; v < positions.length / 3; v++) {
    const y = positions[v * 3 + 1]!;
    const d = dominant[v]!;
    if (y > yLo && y < yHi) {
      const torso =
        d === J.pelvis ||
        d === J.spine ||
        d === J.chest ||
        ((d === J.l_thigh || d === J.r_thigh) && y > crotch);
      if (torso) {
        const g = f(y);
        positions[v * 3] = positions[v * 3]! * g;
        positions[v * 3 + 2] = positions[v * 3 + 2]! * g;
        continue;
      }
    }
    if ((d === J.neck || d === J.head) && Math.abs(y - neckY) < 2.5 * nwin) {
      const w = Math.exp(-0.5 * ((y - neckY) / nwin) ** 2);
      const g = 1 + (gNeck - 1) * w;
      positions[v * 3] = positions[v * 3]! * g;
      positions[v * 3 + 2] = nz + (positions[v * 3 + 2]! - nz) * g;
    }
  }
  return { applied };
}
