import type { WorldCapsule } from '@fitroom/shared';

/** Campos por cápsula en el banco (Float64 para no perder precisión en los tests de distancia). */
export const CAP_STRIDE = 16;
/** Máximo de cápsulas válidas por paso (un cuerpo trae ~20). Las sobrantes se ignoran. */
export const MAX_CAPSULES = 120;
/** Distancia coordenada máxima admitida (m) */
const COORD_LIMIT = 1e5;
const RADIUS_LIMIT = 1e4;

/**
 * Banco de cápsulas del fotograma. Se rellena SIN asignar memoria en cada paso. Cada cápsula guarda:
 *  [0..2] a · [3..5] (b − a) · [6] 1/|b−a|² (0 si a≈b) · [7] R = radio + margen · [8] R² ·
 *  [9] R² con tolerancia (umbral de "dentro") · [10..12] min AABB inflado por R · [13..15] max AABB.
 * Las cápsulas degeneradas (NaN/Inf, radio ≤ 0, radio absurdo) se descartan y se cuentan.
 */
export class CapsuleBank {
  readonly data = new Float64Array(MAX_CAPSULES * CAP_STRIDE);
  count = 0;
  skipped = 0;

  prepare(capsules: readonly WorldCapsule[], margin: number): void {
    const d = this.data;
    let c = 0;
    let skipped = 0;
    const len = capsules.length;
    for (let i = 0; i < len; i++) {
      const cap = capsules[i];
      if (c >= MAX_CAPSULES) {
        skipped += len - i;
        break;
      }
      const a = cap?.a;
      const b = cap?.b;
      if (!a || !b) {
        skipped++;
        continue;
      }
      const ax = a[0],
        ay = a[1],
        az = a[2],
        bx = b[0],
        by = b[1],
        bz = b[2],
        r = cap.radius;
      if (
        !(
          Math.abs(ax) < COORD_LIMIT &&
          Math.abs(ay) < COORD_LIMIT &&
          Math.abs(az) < COORD_LIMIT &&
          Math.abs(bx) < COORD_LIMIT &&
          Math.abs(by) < COORD_LIMIT &&
          Math.abs(bz) < COORD_LIMIT &&
          r > 0 &&
          r < RADIUS_LIMIT
        )
      ) {
        skipped++;
        continue;
      }
      const o = c * CAP_STRIDE;
      const abx = bx - ax,
        aby = by - ay,
        abz = bz - az;
      const l2 = abx * abx + aby * aby + abz * abz;
      const R = r + margin;
      d[o] = ax;
      d[o + 1] = ay;
      d[o + 2] = az;
      d[o + 3] = abx;
      d[o + 4] = aby;
      d[o + 5] = abz;
      d[o + 6] = l2 > 1e-12 ? 1 / l2 : 0;
      d[o + 7] = R;
      d[o + 8] = R * R;
      d[o + 9] = R * R * (1 - 1e-5);
      d[o + 10] = Math.min(ax, bx) - R;
      d[o + 11] = Math.min(ay, by) - R;
      d[o + 12] = Math.min(az, bz) - R;
      d[o + 13] = Math.max(ax, bx) + R;
      d[o + 14] = Math.max(ay, by) + R;
      d[o + 15] = Math.max(az, bz) + R;
      c++;
    }
    this.count = c;
    this.skipped = skipped;
  }
}
