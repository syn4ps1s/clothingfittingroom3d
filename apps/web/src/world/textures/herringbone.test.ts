import { describe, expect, it } from 'vitest';
import { coverage, herringbonePlanks } from './herringbone';

describe('parquet en espiga', () => {
  it.each([3, 4, 5, 6])('L=%i: la baldosa 2L×2L queda cubierta exactamente una vez (tileable)', (L) => {
    const grid = coverage(L);
    for (const row of grid) for (const c of row) expect(c).toBe(1);
  });

  it('genera tablillas de L×1 en ambas orientaciones', () => {
    const planks = herringbonePlanks(4);
    expect(planks.some((p) => p.horizontal && p.w === 4 && p.h === 1)).toBe(true);
    expect(planks.some((p) => !p.horizontal && p.w === 1 && p.h === 4)).toBe(true);
  });
});
