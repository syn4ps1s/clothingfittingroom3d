import type { PatternSpec } from '@fitroom/shared';
import { hexToLinear, mixRgb, scaleRgb, type RGB } from './color.js';
import { fitPeriod, fitStripeLattice } from './lattice.js';
import { hash01 } from './prng.js';
import type { FamilyContext, FamilyPlan, PatternFitInfo } from './types.js';

/**
 * Patrones (rayas, cuadros, lunares, espiga, flores) compuestos en el albedo.
 *
 * Todos son PERIÓDICOS en el tile: el periodo (mm) pedido por el `PatternSpec` se ajusta al divisor
 * entero más cercano del tamaño físico del tile (`tileCm·10`); el factor de escala resultante se aplica
 * también a anchos/radios para conservar las proporciones. Para rayas oblicuas se usa una red entera
 * `s = a·u + b·v`, de modo que el ángulo efectivo puede diferir ligeramente del pedido.
 * Los patrones "tejidos" (rayas/cuadros/espiga) se alinean a la rejilla de hilos del tejido; los
 * "estampados" (lunares/flores) son continuos y dejan ver el tejido debajo.
 */

export interface PatternBuild {
  readonly mask1: Float32Array | null;
  readonly mask2: Float32Array | null;
  readonly color2: RGB | null;
  readonly color3: RGB | null;
  readonly info: PatternFitInfo | null;
}

const NONE: PatternBuild = { mask1: null, mask2: null, color2: null, color3: null, info: null };

/** Mínimo de píxeles por periodo para evitar aliasing del patrón. */
const MIN_PX_PER_PERIOD = 4;

function clampRepeats(repeats: number, size: number, multipleOf = 1): number {
  const maxR = Math.max(multipleOf, Math.floor(size / MIN_PX_PER_PERIOD / multipleOf) * multipleOf);
  return Math.max(multipleOf, Math.min(repeats, maxR));
}

const sat = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export function buildPatternSteps(
  ctx: FamilyContext,
  plan: FamilyPlan,
  pattern: PatternSpec,
): PatternBuild {
  if (pattern.type === 'solid') return NONE;
  const S = ctx.size;
  const tileMm = ctx.fabric.tileCm * 10;
  const { T, H, R } = ctx.fields;
  const mask1 = new Float32Array(S * S);
  const grid = plan.grid;

  switch (pattern.type) {
    case 'stripes': {
      const periodMm = pattern.widthMm + pattern.gapMm;
      const fit = fitStripeLattice(tileMm, periodMm, pattern.angleDeg);
      // limitar a ≥ 4 px por periodo
      let a = fit.a;
      let b = fit.b;
      let k = Math.hypot(a, b);
      const maxK = S / MIN_PX_PER_PERIOD;
      if (k > maxK) {
        const f = maxK / k;
        a = Math.round(a * f);
        b = Math.round(b * f);
        if (a === 0 && b === 0) b = 1;
        k = Math.hypot(a, b);
      }
      const effPeriod = tileMm / k;
      const scale = effPeriod / periodMm;
      const duty = Math.min(0.95, Math.max(0.05, pattern.widthMm / periodMm));
      const snapU = grid && b === 0 ? grid.nu : 0; // franjas verticales → por hilo de urdimbre
      const snapV = grid && a === 0 ? grid.nv : 0; // franjas horizontales → por hilo de trama
      const edge = Math.max(1e-4, (k / S) * 0.8); // ~0.8 px en unidades de fase
      ctx.bands((y0, y1) => {
        for (let y = y0; y < y1; y++) {
          let v = (y + 0.5) / S;
          if (snapV) v = (Math.floor(v * snapV) + 0.5) / snapV;
          for (let x = 0; x < S; x++) {
            let u = (x + 0.5) / S;
            if (snapU) u = (Math.floor(u * snapU) + 0.5) / snapU;
            let s = a * u + b * v;
            s -= Math.floor(s);
            // franja centrada en fase 0.5
            const d = Math.abs(s - 0.5) - duty * 0.5;
            const cov = snapU || snapV ? (d < 0 ? 1 : 0) : sat(0.5 - d / edge);
            const i = y * S + x;
            mask1[i] = cov;
            R[i] = R[i]! + 0.02 * cov;
          }
        }
      });
      return {
        mask1,
        mask2: null,
        color2: hexToLinear(pattern.color2),
        color3: null,
        info: {
          type: 'stripes',
          requestedPeriodMm: periodMm,
          effectivePeriodMm: effPeriod,
          repeats: k,
          requestedAngleDeg: pattern.angleDeg,
          effectiveAngleDeg: fit.effectiveAngleDeg,
          scale,
        },
      };
    }

    case 'plaid': {
      const fit0 = fitPeriod(tileMm, pattern.sizeMm);
      const K = clampRepeats(fit0.repeats, S);
      const eff = tileMm / K;
      const mask2 = new Float32Array(S * S);
      const c2 = hexToLinear(pattern.color2);
      const c3: RGB = pattern.color3 ? hexToLinear(pattern.color3) : scaleRgb(c2, 0.32);
      // perfil 1D de una repetición: banda ancha (color2) + dos líneas finas (color3)
      const wide = (t: number, edge: number): number =>
        sat((t - 0.1) / edge + 0.5) * sat((0.42 - t) / edge + 0.5);
      const thin = (t: number, edge: number): number =>
        Math.max(
          sat((t - 0.595) / edge + 0.5) * sat((0.645 - t) / edge + 0.5),
          sat((t - 0.775) / edge + 0.5) * sat((0.805 - t) / edge + 0.5),
        );
      const snapU = grid ? grid.nu : 0;
      const snapV = grid ? grid.nv : 0;
      const edge = Math.max(1e-4, (K / S) * 0.8);
      ctx.bands((y0, y1) => {
        for (let y = y0; y < y1; y++) {
          let v = (y + 0.5) / S;
          if (snapV) v = (Math.floor(v * snapV) + 0.5) / snapV;
          let tv = v * K;
          tv -= Math.floor(tv);
          const wH = snapV ? (wide(tv, 1e-6) > 0.5 ? 1 : 0) : wide(tv, edge);
          const lH = snapV ? (thin(tv, 1e-6) > 0.5 ? 1 : 0) : thin(tv, edge);
          for (let x = 0; x < S; x++) {
            let u = (x + 0.5) / S;
            if (snapU) u = (Math.floor(u * snapU) + 0.5) / snapU;
            let tu = u * K;
            tu -= Math.floor(tu);
            const wV = snapU ? (wide(tu, 1e-6) > 0.5 ? 1 : 0) : wide(tu, edge);
            const lV = snapU ? (thin(tu, 1e-6) > 0.5 ? 1 : 0) : thin(tu, edge);
            const i = y * S + x;
            // las bandas son semitransparentes: al cruzarse se oscurecen/saturan (como en un tejido real)
            const m = sat(0.62 * wH + 0.62 * wV);
            mask1[i] = m;
            mask2[i] = Math.max(lH, lV);
            if (wH > 0.5 && wV > 0.5) T[i] = T[i]! * 0.9;
          }
        }
      });
      return {
        mask1,
        mask2,
        color2: c2,
        color3: c3,
        info: {
          type: 'plaid',
          requestedPeriodMm: pattern.sizeMm,
          effectivePeriodMm: eff,
          repeats: K,
          scale: eff / pattern.sizeMm,
        },
      };
    }

    case 'dots': {
      const fit0 = fitPeriod(tileMm, pattern.spacingMm, 2);
      const K = clampRepeats(fit0.repeats, S, 2);
      const eff = tileMm / K;
      const scale = eff / pattern.spacingMm;
      const rad = Math.min(pattern.radiusMm * scale, eff * 0.45) / tileMm; // en unidades de tile
      const spacing = 1 / K;
      ctx.bands((y0, y1) => {
        for (let y = y0; y < y1; y++) {
          const v = (y + 0.5) / S;
          for (let x = 0; x < S; x++) {
            const u = (x + 0.5) / S;
            const c = Math.floor(u * K);
            let best = 1e9;
            for (let dc = -1; dc <= 1; dc++) {
              const cc = c + dc;
              const cx = (cc + 0.5) * spacing;
              const par = ((cc % 2) + 2) % 2;
              const ofs = par * 0.5 * spacing;
              const rr = Math.round((v - ofs) / spacing - 0.5);
              for (let dr = -1; dr <= 0; dr++) {
                const cy = (rr + dr + 0.5) * spacing + ofs;
                const dx = u - cx;
                const dy = v - cy;
                const d = dx * dx + dy * dy;
                if (d < best) best = d;
              }
            }
            const cov = sat((rad - Math.sqrt(best)) * S + 0.5);
            const i = y * S + x;
            mask1[i] = cov;
            R[i] = R[i]! + 0.05 * cov;
            H[i] = H[i]! * (1 - 0.12 * cov);
          }
        }
      });
      return {
        mask1,
        mask2: null,
        color2: hexToLinear(pattern.color2),
        color3: null,
        info: {
          type: 'dots',
          requestedPeriodMm: pattern.spacingMm,
          effectivePeriodMm: eff,
          repeats: K,
          scale,
        },
      };
    }

    case 'herringbone': {
      const fit0 = fitPeriod(tileMm, pattern.sizeMm);
      const K = clampRepeats(fit0.repeats, S);
      const eff = tileMm / K;
      // el zigzag es diagonal: se dibuja continuo (con borde suavizado) en lugar de escalonado por hilo
      const snapU = 0;
      const snapV = 0;
      const edge = Math.max(1e-4, (K / S) * 0.9);
      ctx.bands((y0, y1) => {
        for (let y = y0; y < y1; y++) {
          let v = (y + 0.5) / S;
          if (snapV) v = (Math.floor(v * snapV) + 0.5) / snapV;
          for (let x = 0; x < S; x++) {
            let u = (x + 0.5) / S;
            if (snapU) u = (Math.floor(u * snapU) + 0.5) / snapU;
            const p = u * K;
            const w = Math.abs(p - Math.floor(p) - 0.5) * 2; // triángulo 0..1
            let s = v * K + w * 0.5;
            s -= Math.floor(s);
            const d = Math.abs(s - 0.5) - 0.25;
            const cov = snapU ? (d < 0 ? 1 : 0) : sat(0.5 - d / edge);
            mask1[y * S + x] = cov;
          }
        }
      });
      return {
        mask1,
        mask2: null,
        color2: hexToLinear(pattern.color2),
        color3: null,
        info: {
          type: 'herringbone',
          requestedPeriodMm: pattern.sizeMm,
          effectivePeriodMm: eff,
          repeats: K,
          scale: eff / pattern.sizeMm,
        },
      };
    }

    case 'floral': {
      const fit0 = fitPeriod(tileMm, pattern.scaleMm);
      const K = clampRepeats(fit0.repeats, S);
      const eff = tileMm / K;
      const mask2 = new Float32Array(S * S);
      const c2 = hexToLinear(pattern.color2);
      const c3: RGB = pattern.color3
        ? hexToLinear(pattern.color3)
        : mixRgb(scaleRgb(c2, 0.4), [0.1, 0.18, 0.06], 0.4);
      const cell = 1 / K;
      // parámetros de cada flor por celda (con envoltura)
      const flowers = new Float32Array(K * K * 10);
      for (let cy = 0; cy < K; cy++) {
        for (let cx = 0; cx < K; cx++) {
          const o = (cy * K + cx) * 10;
          flowers[o] = (cx + 0.5 + (hash01(ctx.seed, cx, cy, 81) - 0.5) * 0.34) * cell;
          flowers[o + 1] = (cy + 0.5 + (hash01(ctx.seed, cx, cy, 82) - 0.5) * 0.34) * cell;
          flowers[o + 2] = (0.3 + 0.08 * hash01(ctx.seed, cx, cy, 83)) * cell; // radio
          flowers[o + 3] = hash01(ctx.seed, cx, cy, 84) * Math.PI * 2; // rotación
          flowers[o + 4] = hash01(ctx.seed, cx, cy, 85) * Math.PI * 2; // rotación de hojas
          flowers[o + 5] = 0.85 + 0.3 * hash01(ctx.seed, cx, cy, 86);
          const lphi = flowers[o + 4]!;
          flowers[o + 6] = Math.cos(lphi - 1.1);
          flowers[o + 7] = Math.sin(lphi - 1.1);
          flowers[o + 8] = Math.cos(lphi + 1.1);
          flowers[o + 9] = Math.sin(lphi + 1.1);
        }
      }
      const aa = 1.1 / S;
      ctx.bands((y0, y1) => {
        for (let y = y0; y < y1; y++) {
          const v = (y + 0.5) / S;
          const cyBase = Math.floor(v * K);
          for (let x = 0; x < S; x++) {
            const u = (x + 0.5) / S;
            const cxBase = Math.floor(u * K);
            let petal = 0;
            let centre = 0;
            let leaf = 0;
            let shade = 1;
            for (let dy = -1; dy <= 1; dy++) {
              const cyy = cyBase + dy;
              const wy = ((cyy % K) + K) % K;
              for (let dx = -1; dx <= 1; dx++) {
                const cxx = cxBase + dx;
                const wx = ((cxx % K) + K) % K;
                const o = (wy * K + wx) * 10;
                // centro con el desplazamiento de envoltura aplicado
                const fx = flowers[o]! + (cxx - wx) * cell;
                const fy = flowers[o + 1]! + (cyy - wy) * cell;
                const rx = u - fx;
                const ry = v - fy;
                const r = flowers[o + 2]! * flowers[o + 5]!;
                const d2 = rx * rx + ry * ry;
                if (d2 > (r * 1.9) * (r * 1.9)) continue;
                const dist = Math.sqrt(d2);
                const ang = Math.atan2(ry, rx) - flowers[o + 3]!;
                // pétalos: borde radial con 5 lóbulos
                const lobe = Math.abs(Math.cos(2.5 * ang));
                const rho = r * (0.52 + 0.48 * Math.pow(lobe, 0.65));
                const pc = sat((rho - dist) / aa + 0.5);
                if (pc > petal) {
                  petal = pc;
                  shade = 0.8 + 0.28 * Math.min(1, dist / rho);
                }
                const cc = sat((0.2 * r - dist) / aa + 0.5);
                if (cc > centre) centre = cc;
                // hojas: dos elipses alargadas
                for (let side = 0; side < 2; side++) {
                  const ca = flowers[o + 6 + side * 2]!;
                  const sa = flowers[o + 7 + side * 2]!;
                  const along = (rx * ca + ry * sa) / (r * 1.7);
                  if (along > 0.05 && along < 1) {
                    const perp = (-rx * sa + ry * ca) / (r * 0.34);
                    const w = 1 - (along - 0.5) * (along - 0.5) * 4;
                    const lc = sat((w - Math.abs(perp)) / 0.35 + 0.5);
                    if (lc > leaf) leaf = lc;
                  }
                }
              }
            }
            const i = y * S + x;
            mask1[i] = petal;
            mask2[i] = Math.max(centre, leaf * (1 - petal));
            const cov = Math.max(petal, mask2[i]!);
            T[i] = T[i]! * (1 + (shade - 1) * petal);
            R[i] = R[i]! + 0.05 * cov;
            H[i] = H[i]! * (1 - 0.1 * cov);
          }
        }
      });
      return {
        mask1,
        mask2,
        color2: c2,
        color3: c3,
        info: {
          type: 'floral',
          requestedPeriodMm: pattern.scaleMm,
          effectivePeriodMm: eff,
          repeats: K,
          scale: eff / pattern.scaleMm,
        },
      };
    }
  }
}
