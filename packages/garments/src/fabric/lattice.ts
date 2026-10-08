/**
 * Ajuste de periodos al tile para que patrones y tejidos encajen SIN costura.
 * Un tile físico mide `tileMm` milímetros; cualquier motivo periódico debe repetirse un número
 * ENTERO de veces dentro de él. Estas funciones eligen el entero más cercano y devuelven el
 * periodo efectivo (documentado en `FabricTextureInfo`).
 */

export interface PeriodFit {
  /** nº entero de repeticiones por tile (≥ 1) */
  readonly repeats: number;
  /** periodo pedido (mm) */
  readonly requestedMm: number;
  /** periodo efectivo = tileMm / repeats */
  readonly effectiveMm: number;
}

/** Divisor entero del tile más cercano al periodo pedido. `multipleOf` fuerza múltiplos (p. ej. 2 para half-drop). */
export function fitPeriod(tileMm: number, periodMm: number, multipleOf = 1): PeriodFit {
  const safe = Number.isFinite(periodMm) && periodMm > 0 ? periodMm : tileMm;
  const ideal = tileMm / safe;
  let repeats = Math.max(multipleOf, Math.round(ideal / multipleOf) * multipleOf);
  if (!Number.isFinite(repeats) || repeats < 1) repeats = Math.max(1, multipleOf);
  // límite superior razonable para no generar patrones sub-píxel
  repeats = Math.min(repeats, 4096);
  return { repeats, requestedMm: periodMm, effectiveMm: tileMm / repeats };
}

export interface StripeLatticeFit {
  /** coeficientes enteros: s = a·u + b·v (u,v en unidades de tile) → franjas = fract(s) */
  readonly a: number;
  readonly b: number;
  readonly requestedPeriodMm: number;
  readonly effectivePeriodMm: number;
  readonly requestedAngleDeg: number;
  readonly effectiveAngleDeg: number;
}

/**
 * Franjas con ángulo arbitrario que repiten sin costura: se usa s = a·u + b·v con (a, b) ENTEROS.
 * Ángulo = dirección de las franjas medida desde +u (0° = horizontales, 90° = verticales).
 * Se busca el par (a, b) que minimiza un coste combinado de error de ángulo y de periodo.
 */
export function fitStripeLattice(
  tileMm: number,
  periodMm: number,
  angleDeg: number,
): StripeLatticeFit {
  const ang = ((((angleDeg % 180) + 180) % 180) * Math.PI) / 180;
  // normal a las franjas: n = (−sin θ, cos θ) para franjas con dirección (cos θ, sin θ)
  const nx = -Math.sin(ang);
  const ny = Math.cos(ang);
  const safe = Number.isFinite(periodMm) && periodMm > 0 ? periodMm : tileMm;
  const idealK = tileMm / safe; // nº de franjas a lo largo de la normal
  const maxK = Math.min(64, Math.ceil(idealK) + 2);

  let best = { a: 0, b: 1, cost: Infinity };
  for (let a = -maxK; a <= maxK; a++) {
    for (let b = 0; b <= maxK; b++) {
      if (a === 0 && b === 0) continue;
      const k = Math.hypot(a, b);
      // dirección de la normal del candidato
      const cAng = Math.acos(Math.max(-1, Math.min(1, (a * nx + b * ny) / k)));
      const periodErr = Math.abs(Math.log(k / idealK));
      const cost = cAng * 2.5 + periodErr;
      if (cost < best.cost - 1e-12) best = { a, b, cost };
    }
  }
  const k = Math.hypot(best.a, best.b);
  // ángulo efectivo de las franjas: perpendicular a (a, b) → dirección (−b, a)
  let eff = (Math.atan2(best.a, -best.b) * 180) / Math.PI;
  eff = ((eff % 180) + 180) % 180;
  return {
    a: best.a,
    b: best.b,
    requestedPeriodMm: periodMm,
    effectivePeriodMm: tileMm / k,
    requestedAngleDeg: angleDeg,
    effectiveAngleDeg: eff,
  };
}

/** Redondea `n` al múltiplo de `unit` más cercano dentro de [unit, maxN] (si maxN < unit devuelve unit). */
export function roundToUnit(n: number, unit: number, maxN: number): number {
  const u = Math.max(1, Math.floor(unit));
  const hi = Math.max(u, Math.floor(maxN / u) * u);
  const r = Math.round(n / u) * u;
  return Math.min(hi, Math.max(u, r));
}
