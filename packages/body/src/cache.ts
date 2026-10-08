/** Caché LRU mínima y determinista (el orden de expulsión sólo depende de la secuencia de accesos). */
export class LruCache<V> {
  private readonly map = new Map<string, V>();
  constructor(private maxEntries: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  setCapacity(n: number): void {
    this.maxEntries = Math.max(1, Math.floor(n));
    this.set('__noop__', undefined as unknown as V);
    this.map.delete('__noop__');
  }
}
