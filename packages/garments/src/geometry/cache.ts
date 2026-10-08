import type { BodyModel, GarmentDefinition } from '@fitroom/shared';

/** Caché LRU simple (Map conserva el orden de inserción). */
export class Lru<V> {
  private readonly map = new Map<string, V>();
  constructor(private cap: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, v: V): void {
    this.map.delete(key);
    this.map.set(key, v);
    while (this.map.size > this.cap) {
      const first = this.map.keys().next().value as string | undefined;
      if (first === undefined) break;
      this.map.delete(first);
    }
  }
  clear(): void {
    this.map.clear();
  }
  setCapacity(n: number): void {
    this.cap = Math.max(1, n | 0);
    this.set('', undefined as unknown as V);
    this.map.delete('');
  }
  get size(): number {
    return this.map.size;
  }
}

/** Hash FNV-1a de una cadena (32 bits) en hex. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Clave de caché: id de prenda + talla + hash de medidas del cuerpo + hash de la definición relevante. */
export function garmentCacheKey(def: GarmentDefinition, sizeLabel: string, body: BodyModel): string {
  const m = body.measurements;
  const mh = hashString(JSON.stringify(m));
  const size = def.sizes.find((s) => s.label.toUpperCase() === sizeLabel.trim().toUpperCase());
  const dh = hashString(
    JSON.stringify([def.template, def.fit, def.slot, def.fabricId, def.params ?? null, size?.garment ?? null]),
  );
  return `${def.id}|${sizeLabel.trim().toUpperCase()}|${mh}|${dh}`;
}
