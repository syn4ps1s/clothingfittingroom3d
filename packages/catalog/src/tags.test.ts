import { describe, expect, it } from 'vitest';
import { CATALOG_TAGS, assessOccasion, formalityLabel, formalityOf } from './index.js';

const g = (...tags: string[]) => ({ tags });

describe('formalidad y ocasión', () => {
  it('formalityOf promedia las etiquetas de formalidad (0,5 si no hay)', () => {
    expect(formalityOf(g('casual'))).toBe(0);
    expect(formalityOf(g('casual', 'smart-casual'))).toBe(0.5);
    expect(formalityOf(g('formal', 'winter'))).toBe(2);
    expect(formalityOf(g('winter'))).toBe(0.5);
    expect(formalityOf(g('constructor', '__proto__'))).toBe(0.5);
  });

  it('formalityLabel redondea a la categoría más cercana', () => {
    expect(formalityLabel(0)).toBe('casual');
    expect(formalityLabel(1)).toBe('smart-casual');
    expect(formalityLabel(1.8)).toBe('formal');
  });

  it('un conjunto homogéneo puntúa más que uno con formalidades opuestas', () => {
    const coherent = assessOccasion([g('smart-casual', 'office'), g('smart-casual', 'office')]);
    const gap = assessOccasion([g('casual'), g('formal')]);
    expect(coherent.score).toBeGreaterThan(0.9);
    expect(gap.score).toBeLessThan(0.5);
    expect(gap.formalitySpread).toBe(2);
    expect(coherent.sharedOccasions).toEqual(['office']);
  });

  it('penaliza mezclar verano e invierno y ocasiones incompatibles', () => {
    const base = assessOccasion([g('casual', 'summer'), g('casual', 'all-season')]);
    const clash = assessOccasion([g('casual', 'summer'), g('casual', 'winter')]);
    expect(clash.seasonClash).toBe(true);
    expect(clash.score).toBeLessThan(base.score * 0.5);
    const conflict = assessOccasion([g('casual', 'beach'), g('casual', 'office')]);
    expect(conflict.occasionConflict).toBe(true);
    expect(conflict.score).toBeLessThan(0.6);
  });

  it('el vocabulario es cerrado y sin duplicados', () => {
    expect(new Set(CATALOG_TAGS).size).toBe(CATALOG_TAGS.length);
    for (const tag of CATALOG_TAGS) expect(tag).toMatch(/^[a-z][a-z-]*$/);
  });
});
