/**
 * Geometría del parquet en espiga sobre una rejilla de celdas de lado 1 (ancho de tablilla), con tablillas de L×1.
 * Cadena diagonal: H(k) = [Lk, Lk+L)×{Lk}, V(k) = {Lk+L}×[Lk, Lk+L); cadenas contiguas desplazadas (1,−1).
 * El patrón es periódico en una baldosa cuadrada de 2L×2L celdas, así que la textura es tileable.
 */
export interface Plank {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly horizontal: boolean;
}

export function herringbonePlanks(L: number): Plank[] {
  const planks: Plank[] = [];
  const period = 2 * L;
  // Clases de equivalencia módulo la baldosa: basta k = 0 y m ∈ [0, 2L) (4L tablillas por baldosa).
  for (let m = 0; m < period; m++) {
    const x = m;
    const y = -m;
    planks.push({ x, y, w: L, h: 1, horizontal: true });
    planks.push({ x: x + L, y, w: 1, h: L, horizontal: false });
  }
  return planks;
}

/** Cuántas veces queda cubierta cada celda de la baldosa (debe ser 1 en todas). */
export function coverage(L: number): number[][] {
  const n = 2 * L;
  const grid = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const wrap = (v: number) => ((v % n) + n) % n;
  for (const p of herringbonePlanks(L)) {
    for (let dx = 0; dx < p.w; dx++) {
      for (let dy = 0; dy < p.h; dy++) {
        grid[wrap(p.y + dy)]![wrap(p.x + dx)]!++;
      }
    }
  }
  return grid;
}
