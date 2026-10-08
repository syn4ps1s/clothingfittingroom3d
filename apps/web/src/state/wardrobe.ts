import { GARMENT_SLOTS, type GarmentSlot } from '@fitroom/shared';

/** Prenda puesta en una ranura (sólo ids: el detalle sale del catálogo). */
export interface WornItem {
  readonly garmentId: string;
  readonly size: string;
  readonly variantId: string;
}

export type Worn = Readonly<Partial<Record<GarmentSlot, WornItem>>>;

export interface EquipResult {
  readonly worn: Worn;
  /** Ranuras que se han vaciado por incompatibilidad (para avisar: «se ha quitado…»). */
  readonly displaced: readonly GarmentSlot[];
}

/**
 * Reglas de capas:
 * - `upper` y `lower` conviven; `full` (vestido) ocupa ambas, por lo que expulsa a las dos.
 * - Ponerse `upper` o `lower` expulsa a `full`.
 * - `outer` va por encima de todo y no expulsa ni es expulsada.
 */
export function equip(worn: Worn, slot: GarmentSlot, item: WornItem): EquipResult {
  const next: Partial<Record<GarmentSlot, WornItem>> = { ...worn };
  const displaced: GarmentSlot[] = [];
  const clear = (s: GarmentSlot) => {
    if (next[s]) {
      delete next[s];
      displaced.push(s);
    }
  };
  if (slot === 'full') {
    clear('upper');
    clear('lower');
  } else if (slot === 'upper' || slot === 'lower') {
    clear('full');
  }
  next[slot] = item;
  return { worn: next, displaced };
}

export function unequip(worn: Worn, slot: GarmentSlot): Worn {
  if (!worn[slot]) return worn;
  const next: Partial<Record<GarmentSlot, WornItem>> = { ...worn };
  delete next[slot];
  return next;
}

/** Orden de render/lista: de dentro hacia fuera. */
export const LAYER_ORDER: readonly GarmentSlot[] = ['lower', 'upper', 'full', 'outer'];

export function wornEntries(worn: Worn): { slot: GarmentSlot; item: WornItem }[] {
  return LAYER_ORDER.flatMap((slot) => {
    const item = worn[slot];
    return item ? [{ slot, item }] : [];
  });
}

export function isSlot(value: string): value is GarmentSlot {
  return (GARMENT_SLOTS as readonly string[]).includes(value);
}

export function updateWorn(worn: Worn, slot: GarmentSlot, patch: Partial<WornItem>): Worn {
  const current = worn[slot];
  if (!current) return worn;
  return { ...worn, [slot]: { ...current, ...patch } };
}
