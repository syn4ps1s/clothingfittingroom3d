/**
 * Herramienta de desarrollo: ajusta los factores «circunferencia / ancho frontal de silueta» por nivel
 * contra las mallas de @fitroom/body (v1). NO forma parte del paquete en ejecución.
 *
 *   pnpm --filter @fitroom/pose exec tsx tools/calibrate-girth.ts
 *
 * Para cada cuerpo (estatura × IMC × constitución, con residuos individuales aleatorios con semilla) mide en
 * la malla, a las alturas que usa body para sus circunferencias, el ancho frontal EXACTO (extensión en X del
 * lazo central, sin brazos) y ajusta  C = (c0 + c1·(IMC − 22)) · ancho  por mínimos cuadrados.
 */
import { J, type Measurements, type Vec3 } from '@fitroom/shared';
import { buildBody, completeMeasurements, loopAreaXZ, loopPerimeter, measureBody, slicePlane } from '@fitroom/body';
import { gaussian, mulberry32 } from '../src/geom.js';
import { RESIDUAL_SIGMA, predictGirth, SEX_FACTOR } from '../src/anthropometry.js';

type Level = 'chest' | 'waist' | 'hip' | 'neck' | 'thigh';
const rows: Record<Level, { bmi: number; w: number; d: number; c: number; base: string }[]> = {
  chest: [],
  waist: [],
  hip: [],
  neck: [],
  thigh: [],
};

const rand = mulberry32(2026);
const bases = ['neutral', 'masculine', 'feminine'] as const;
const N = Number(process.env.N ?? 36);
for (let n = 0; n < N; n++) {
  const base = bases[n % 3]!;
  const H = 150 + Math.floor(rand() * 8) * 6.5; // 150..195
  const bmi = 17.5 + rand() * 19; // 17.5..36.5
  const W = bmi * (H / 100) ** 2;
  const s = SEX_FACTOR[base];
  const pert = (k: keyof typeof RESIDUAL_SIGMA, v: number): number => v + 0.8 * RESIDUAL_SIGMA[k] * gaussian(rand);
  const m: Measurements = completeMeasurements({
    heightCm: H,
    weightKg: W,
    bodyBase: base,
    chestCm: pert('chestCm', predictGirth('chestCm', H, bmi, s)),
    waistCm: pert('waistCm', predictGirth('waistCm', H, bmi, s)),
    hipCm: pert('hipCm', predictGirth('hipCm', H, bmi, s)),
    thighCm: pert('thighCm', predictGirth('thighCm', H, bmi, s)),
    neckCm: pert('neckCm', predictGirth('neckCm', H, bmi, s)),
  });
  let body;
  try {
    body = buildBody(m);
  } catch (e) {
    console.warn('skip', n, String(e).slice(0, 80));
    continue;
  }
  const ms = measureBody(body);
  const { positions, indices } = body.mesh;
  for (const lvl of ['chest', 'waist', 'hip', 'neck'] as const) {
    const y = ms.landmarks[lvl];
    const loops = slicePlane(positions, indices, [0, y, 0], [0, 1, 0]);
    let best: Float64Array | undefined;
    let ba = -1;
    for (const l of loops) {
      const a = Math.abs(loopAreaXZ(l));
      if (a > ba) {
        ba = a;
        best = l;
      }
    }
    if (!best) continue;
    let x0 = 1e9,
      x1 = -1e9,
      z0 = 1e9,
      z1 = -1e9;
    for (let i = 0; i < best.length; i += 3) {
      x0 = Math.min(x0, best[i]!);
      x1 = Math.max(x1, best[i]!);
      z0 = Math.min(z0, best[i + 2]!);
      z1 = Math.max(z1, best[i + 2]!);
    }
    rows[lvl].push({ bmi: W / (H / 100) ** 2, w: (x1 - x0) * 100, d: (z1 - z0) * 100, c: loopPerimeter(best) * 100, base });
  }
  // muslo: anchura = 2 × distancia del eje cadera→rodilla al borde EXTERIOR del lazo (media de ambos lados)
  const y = ms.landmarks.thigh;
  const loops = slicePlane(positions, indices, [0, y, 0], [0, 1, 0]);
  const jt = (j: number): Vec3 => body.skeleton.joints[j]!.position;
  for (const side of [1, -1] as const) {
    const hip = jt(side === 1 ? J.l_thigh : J.r_thigh);
    const knee = jt(side === 1 ? J.l_calf : J.r_calf);
    const t = (hip[1] - y) / (hip[1] - knee[1]);
    const axisX = hip[0] + (knee[0] - hip[0]) * t;
    let pick: Float64Array | undefined;
    let bd = 1e9;
    for (const l of loops) {
      let cx = 0;
      for (let i = 0; i < l.length; i += 3) cx += l[i]!;
      cx /= l.length / 3;
      if (Math.abs(cx - axisX) < bd) {
        bd = Math.abs(cx - axisX);
        pick = l;
      }
    }
    if (!pick) continue;
    let outer = side === 1 ? -1e9 : 1e9;
    for (let i = 0; i < pick.length; i += 3) outer = side === 1 ? Math.max(outer, pick[i]!) : Math.min(outer, pick[i]!);
    rows.thigh.push({ bmi: W / (H / 100) ** 2, w: 2 * Math.abs(outer - axisX) * 100, d: 0, c: loopPerimeter(pick) * 100, base });
  }
}

function fit(rs: { bmi: number; w: number; c: number }[]): { c0: number; c1: number; rmsCm: number; relSd: number; n: number } {
  // c/w = c0 + c1·(bmi − 22)  (mínimos cuadrados sobre la razón), residuo en cm sobre la circunferencia
  const n = rs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const r of rs) {
    const x = r.bmi - 22;
    const y = r.c / r.w;
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const c1 = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const c0 = (sy - c1 * sx) / n;
  let ss = 0, rel = 0;
  for (const r of rs) {
    const e = (c0 + c1 * (r.bmi - 22)) * r.w - r.c;
    ss += e * e;
    rel += (e / r.c) ** 2;
  }
  return { c0, c1, rmsCm: Math.sqrt(ss / n), relSd: Math.sqrt(rel / n), n };
}
for (const lvl of Object.keys(rows) as Level[]) {
  const f = fit(rows[lvl]);
  const dw = rows[lvl].filter((r) => r.d > 0).map((r) => r.d / r.w);
  const mdw = dw.length ? dw.reduce((a, b) => a + b, 0) / dw.length : NaN;
  console.log(
    `${lvl.padEnd(6)} c0=${f.c0.toFixed(3)} c1=${f.c1.toFixed(4)}  rms=${f.rmsCm.toFixed(2)} cm  rel=${(100 * f.relSd).toFixed(2)} %  n=${f.n}  mean d/w=${mdw.toFixed(2)}`,
  );
}
