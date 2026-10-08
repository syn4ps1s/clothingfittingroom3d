import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { GARMENT_SLOTS, type GarmentSlot } from '@fitroom/shared';
import { equip, unequip, updateWorn, wornEntries, type Worn, type WornItem } from './wardrobe';

const item = (id: string): WornItem => ({ garmentId: id, size: 'M', variantId: 'v1' });

describe('capas y ranuras', () => {
  it('superior e inferior conviven', () => {
    const a = equip({}, 'upper', item('tee'));
    const b = equip(a.worn, 'lower', item('jeans'));
    expect(Object.keys(b.worn).sort()).toEqual(['lower', 'upper']);
    expect(b.displaced).toEqual([]);
  });

  it('un vestido expulsa superior e inferior', () => {
    const worn = equip(equip({}, 'upper', item('tee')).worn, 'lower', item('jeans')).worn;
    const r = equip(worn, 'full', item('dress'));
    expect(Object.keys(r.worn)).toEqual(['full']);
    expect([...r.displaced].sort()).toEqual(['lower', 'upper']);
  });

  it('ponerse una camiseta expulsa el vestido', () => {
    const r = equip(equip({}, 'full', item('dress')).worn, 'upper', item('tee'));
    expect(r.worn.full).toBeUndefined();
    expect(r.displaced).toEqual(['full']);
  });

  it('exterior convive con todo y no expulsa nada', () => {
    const worn = equip(equip({}, 'full', item('dress')).worn, 'outer', item('coat'));
    expect(Object.keys(worn.worn).sort()).toEqual(['full', 'outer']);
    expect(worn.displaced).toEqual([]);
  });

  it('reemplazar en la misma ranura no cuenta como expulsión', () => {
    const r = equip(equip({}, 'upper', item('tee')).worn, 'upper', item('shirt'));
    expect(r.worn.upper?.garmentId).toBe('shirt');
    expect(r.displaced).toEqual([]);
  });

  it('quitar y actualizar son inmutables', () => {
    const worn: Worn = { upper: item('tee') };
    const removed = unequip(worn, 'upper');
    expect(removed).toEqual({});
    expect(worn.upper).toBeDefined();
    expect(unequip(worn, 'lower')).toBe(worn);
    expect(updateWorn(worn, 'upper', { size: 'L' }).upper?.size).toBe('L');
    expect(updateWorn(worn, 'lower', { size: 'L' })).toBe(worn);
  });

  it('propiedad: nunca coexisten vestido y (superior o inferior)', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...GARMENT_SLOTS), { maxLength: 30 }), (slots) => {
        let worn: Worn = {};
        slots.forEach((slot: GarmentSlot, i) => {
          worn = equip(worn, slot, item(`g${i}`)).worn;
          expect(Boolean(worn.full) && (Boolean(worn.upper) || Boolean(worn.lower))).toBe(false);
        });
      }),
    );
  });

  it('orden de capas de dentro hacia fuera', () => {
    const worn: Worn = { outer: item('c'), upper: item('t'), lower: item('j') };
    expect(wornEntries(worn).map((e) => e.slot)).toEqual(['lower', 'upper', 'outer']);
  });
});
