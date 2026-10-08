import { describe, expect, it, vi } from 'vitest';
import { REFERENCE_MEASUREMENTS, type Measurements, type SwatchVariant } from '@fitroom/shared';
import {
  DOUBLE_FABRIC,
  DOUBLE_VARIANT,
  doubleBody,
  doubleEquipped,
  doubleTee,
  doubleTextures,
} from '../../mirror/dev/doubles';
import type { EquippedItem } from '../../contracts';
import { FittingEngine, type FittingSnapshot, type FittingRequest } from './engine';
import { CancelledError, type ExecJob, type Executor } from './executors';
import type { TaskOutput, TaskSpec } from './tasks';

interface Item {
  spec: TaskSpec;
  resolve: (o: TaskOutput) => void;
  reject: (e: unknown) => void;
  state: 'queued' | 'running' | 'done' | 'cancelled';
}

/** Ejecutor falso de un carril: modo manual (los tests deciden cuándo termina cada trabajo) o automático. */
class FakeExecutor implements Executor {
  readonly name = 'fake';
  readonly items: Item[] = [];
  manual = false;
  private running: Item | null = null;
  private readonly bodies = new Map<string, ReturnType<typeof doubleBody>>();

  get started(): TaskSpec[] {
    return this.items.filter((i) => i.state !== 'queued' && i.state !== 'cancelled').map((i) => i.spec);
  }
  get cancelled(): TaskSpec[] {
    return this.items.filter((i) => i.state === 'cancelled').map((i) => i.spec);
  }
  count(kind: TaskSpec['kind']): number {
    return this.items.filter((i) => i.spec.kind === kind).length;
  }

  submit(spec: TaskSpec): ExecJob {
    let item!: Item;
    const promise = new Promise<TaskOutput>((resolve, reject) => {
      item = { spec, resolve, reject, state: 'queued' };
    });
    promise.catch(() => {});
    this.items.push(item);
    queueMicrotask(() => this.pump());
    return {
      spec,
      promise,
      cancel: () => {
        if (item.state !== 'queued') return false;
        item.state = 'cancelled';
        item.reject(new CancelledError());
        return true;
      },
    };
  }

  private value(spec: TaskSpec): TaskOutput {
    switch (spec.kind) {
      case 'body': {
        const key = JSON.stringify(spec.measurements);
        let b = this.bodies.get(key);
        if (!b) {
          b = doubleBody(spec.measurements);
          this.bodies.set(key, b);
        }
        return { value: b, ms: 3 };
      }
      case 'garment': {
        const b = doubleBody(spec.measurements);
        const g = doubleTee(b, spec.def.slot);
        return { value: { ...g, sizeLabel: spec.sizeLabel }, ms: 7 };
      }
      case 'textures':
        return { value: doubleTextures(spec.variant), ms: 11 };
    }
  }

  private pump(): void {
    if (this.running) return;
    const next = this.items.find((i) => i.state === 'queued');
    if (!next) return;
    next.state = 'running';
    this.running = next;
    if (!this.manual) queueMicrotask(() => this.finish(next));
  }

  /** Termina el trabajo en curso (modo manual). */
  finish(item: Item | null = this.running): void {
    if (!item || item.state !== 'running') return;
    item.state = 'done';
    this.running = null;
    item.resolve(this.value(item.spec));
    queueMicrotask(() => this.pump());
  }

  dispose(): void {}
}

const M1: Measurements = REFERENCE_MEASUREMENTS.adultA;
const M2: Measurements = REFERENCE_MEASUREMENTS.adultB;

function item(over: Partial<EquippedItem> = {}, size = 'M'): EquippedItem {
  return { ...doubleEquipped('upper'), sizeLabel: size, ...over };
}

const flush = async (n = 30): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

function setup(maxBytes?: number) {
  const exec = new FakeExecutor();
  const engine = new FittingEngine(exec, maxBytes ? { maxBytes } : {});
  const snaps: FittingSnapshot[] = [];
  const watcher = engine.watch((s) => snaps.push(s));
  const req = (
    measurements: Measurements | null,
    equipped: EquippedItem[],
    textureSize: 512 | 1024 | 2048 = 512,
  ): FittingRequest => ({ measurements, equipped, textureSize });
  return { exec, engine, snaps, watcher, req, last: () => snaps[snaps.length - 1]! };
}

describe('FittingEngine', () => {
  it('sin medidas: idle', async () => {
    const t = setup();
    t.watcher.update(t.req(null, [item()]));
    await flush(2);
    expect(t.last().status).toBe('idle');
    expect(t.last().body).toBeNull();
    expect(t.exec.items).toHaveLength(0);
  });

  it('medidas inválidas: error claro, sin lanzar trabajos', async () => {
    const t = setup();
    t.watcher.update(t.req({ ...M1, heightCm: 20 }, [item()]));
    await flush(2);
    expect(t.last().status).toBe('error');
    expect(t.last().errorMessage).toMatch(/Medidas no válidas/);
    expect(t.exec.items).toHaveLength(0);
  });

  it('carga completa: loading → ready con cuerpo, prenda y tiempos', async () => {
    const t = setup();
    t.watcher.update(t.req(M1, [item()]));
    expect(t.last().status).toBe('loading');
    await flush();
    const s = t.last();
    expect(s.status).toBe('ready');
    expect(s.body).not.toBeNull();
    expect(s.garments).toHaveLength(1);
    expect(s.garments[0]!.textures.main.size).toBe(256);
    expect(s.timings.bodyMs).toBe(3);
    expect(s.timings.garmentMs).toEqual([7]);
    expect(s.timings.readyMs).toBeGreaterThanOrEqual(0);
    expect(s.timings.cacheMisses).toBe(3);
    expect(t.exec.count('body')).toBe(1);
    expect(t.exec.count('garment')).toBe(1);
    expect(t.exec.count('textures')).toBe(1);
  });

  it('la misma petición otra vez no genera nada nuevo y conserva la identidad de la prenda', async () => {
    const t = setup();
    t.watcher.update(t.req(M1, [item()]));
    await flush();
    const first = t.last().garments[0]!;
    const submitted = t.exec.items.length;
    t.watcher.update(t.req(M1, [item()]));
    await flush();
    expect(t.exec.items.length).toBe(submitted);
    expect(t.last().status).toBe('ready');
    expect(t.last().garments[0]).toBe(first);
    expect(t.last().timings.cacheHits).toBeGreaterThanOrEqual(2); // cuerpo + geometría (las texturas ya están en la prenda cargada)
    expect(t.last().timings.cacheMisses).toBe(0);
  });

  it('cambiar SÓLO la muestra de color regenera texturas, no cuerpo ni geometría', async () => {
    const t = setup();
    t.watcher.update(t.req(M1, [item()]));
    await flush();
    const geomBefore = t.last().garments[0]!.geometry;
    const bodyBefore = t.last().body;
    const variant2: SwatchVariant = { ...DOUBLE_VARIANT, id: 'double-red', color: '#a02030' };
    t.watcher.update(t.req(M1, [item({ variant: variant2 })]));
    await flush();
    expect(t.exec.count('body')).toBe(1);
    expect(t.exec.count('garment')).toBe(1);
    expect(t.exec.count('textures')).toBe(2);
    const g = t.last().garments[0]!;
    expect(g.geometry).toBe(geomBefore); // misma geometría (identidad)
    expect(t.last().body).toBe(bodyBefore);
    expect(g.item.variant.id).toBe('double-red');
  });

  it('cambiar de talla regenera la prenda pero reutiliza el cuerpo', async () => {
    const t = setup();
    t.watcher.update(t.req(M1, [item({}, 'M')]));
    await flush();
    t.watcher.update(t.req(M1, [item({}, 'L')]));
    await flush();
    expect(t.exec.count('body')).toBe(1);
    expect(t.exec.count('garment')).toBe(2);
    expect(t.exec.count('textures')).toBe(1); // las texturas no dependen de la talla
    expect(t.last().garments[0]!.item.sizeLabel).toBe('L');
  });

  it('volver a una talla ya vista sale de la caché (0 trabajos nuevos)', async () => {
    const t = setup();
    t.watcher.update(t.req(M1, [item({}, 'M')]));
    await flush();
    t.watcher.update(t.req(M1, [item({}, 'L')]));
    await flush();
    const n = t.exec.items.length;
    t.watcher.update(t.req(M1, [item({}, 'M')]));
    await flush();
    expect(t.exec.items.length).toBe(n);
    expect(t.last().garments[0]!.item.sizeLabel).toBe('M');
  });

  it('cambiar de medidas regenera cuerpo y prenda, y mantiene el par anterior hasta tener el nuevo', async () => {
    const t = setup();
    t.watcher.update(t.req(M1, [item()]));
    await flush();
    const oldBody = t.last().body;
    t.exec.manual = true;
    t.watcher.update(t.req(M2, [item()]));
    await flush(3);
    // mientras carga: sigue el par anterior, consistente
    expect(t.last().status).toBe('loading');
    expect(t.last().body).toBe(oldBody);
    expect(t.last().garments).toHaveLength(1);
    t.exec.manual = false;
    t.exec.finish();
    await flush();
    expect(t.last().status).toBe('ready');
    expect(t.last().body).not.toBe(oldBody);
    expect(t.last().body!.measurements.heightCm).toBe(M2.heightCm);
  });

  it('carrera: S→M→L rápido — sólo se publica L y los trabajos en cola obsoletos se cancelan', async () => {
    const t = setup();
    // calienta cuerpo+texturas
    t.watcher.update(t.req(M1, [item({}, 'S')]));
    await flush();
    t.exec.manual = true;
    const base = t.exec.items.length;
    t.watcher.update(t.req(M1, [item({}, 'M')]));
    await flush(2);
    t.watcher.update(t.req(M1, [item({}, 'L')]));
    t.watcher.update(t.req(M1, [item({}, 'XL')]));
    await flush(2);
    const newItems = t.exec.items.slice(base);
    expect(newItems.map((i) => (i.spec.kind === 'garment' ? i.spec.sizeLabel : i.spec.kind))).toEqual([
      'M',
      'L',
      'XL',
    ]);
    // M está en curso (no cancelable); L quedó en cola y nadie lo necesita → cancelado; XL sigue en cola
    expect(newItems[0]!.state).toBe('running');
    expect(newItems[1]!.state).toBe('cancelled');
    expect(newItems[2]!.state).toBe('queued');
    const publishedBefore = t.snaps.length;
    t.exec.manual = false;
    t.exec.finish(); // termina M (obsoleta)
    await flush();
    const labels = t.snaps.slice(publishedBefore).flatMap((s) => s.garments.map((g) => g.item.sizeLabel));
    expect(labels).not.toContain('M');
    expect(labels).not.toContain('L');
    expect(t.last().status).toBe('ready');
    expect(t.last().garments[0]!.item.sizeLabel).toBe('XL');
    // el resultado de M llegó tarde pero quedó en caché: volver a M no genera nada
    const n = t.exec.items.length;
    t.watcher.update(t.req(M1, [item({}, 'M')]));
    await flush();
    expect(t.exec.items.length).toBe(n);
    expect(t.last().garments[0]!.item.sizeLabel).toBe('M');
  });

  it('resultado tardío de una petición obsoleta no pisa a la vigente (orden inverso de llegada)', async () => {
    const t = setup();
    t.exec.manual = true;
    t.watcher.update(t.req(M1, [item({}, 'S')]));
    await flush(2);
    // cuerpo S en curso; llega petición nueva
    t.watcher.update(t.req(M1, [item({}, 'M')]));
    await flush(2);
    const seen: string[] = [];
    const unsub = t.watcher;
    void unsub;
    for (let i = 0; i < 12; i++) {
      t.exec.finish();
      await flush(2);
      seen.push(...t.last().garments.map((g) => g.item.sizeLabel));
    }
    expect(seen).not.toContain('S');
    expect(t.last().garments[0]!.item.sizeLabel).toBe('M');
  });

  it('quitar una prenda se refleja de inmediato; añadir otra mantiene la ya cargada', async () => {
    const t = setup();
    const top = item({});
    const jacket = item(
      { garment: { ...top.garment, id: 'double-outer', slot: 'outer' } },
      'M',
    );
    t.watcher.update(t.req(M1, [top]));
    await flush();
    const topLoaded = t.last().garments[0]!;
    t.exec.manual = true;
    t.watcher.update(t.req(M1, [top, jacket]));
    await flush(3);
    // mientras llega la chaqueta, la camiseta sigue mostrándose (misma identidad)
    expect(t.last().garments).toContain(topLoaded);
    t.exec.manual = false;
    t.exec.finish();
    await flush();
    expect(t.last().garments).toHaveLength(2);
    t.watcher.update(t.req(M1, []));
    await flush(2);
    expect(t.last().garments).toHaveLength(0);
    expect(t.last().body).not.toBeNull();
  });

  it('texturas progresivas: sirve 512 enseguida y mejora a la resolución final sin tocar la geometría', async () => {
    const t = setup();
    t.watcher.update(t.req(M1, [item()], 1024));
    await flush();
    expect(t.exec.count('textures')).toBe(2); // 512 y 1024
    const sizes = t.snaps
      .filter((s) => s.garments.length > 0)
      .map((s) => `${s.status}:${s.garments[0]!.textures.main.size}`);
    // el doble genera siempre 256, así que comprobamos la secuencia por tamaño pedido
    const sizesAsked = t.exec.items
      .filter((i) => i.spec.kind === 'textures')
      .map((i) => (i.spec.kind === 'textures' ? i.spec.size : 0));
    expect(sizesAsked).toEqual([512, 1024]);
    expect(sizes.length).toBeGreaterThan(0);
    const readySnaps = t.snaps.filter((s) => s.status === 'ready');
    expect(readySnaps.length).toBeGreaterThanOrEqual(1);
    const geoms = new Set(t.snaps.flatMap((s) => s.garments.map((g) => g.geometry)));
    expect(geoms.size).toBe(1);
    const mains = new Set(t.snaps.flatMap((s) => s.garments.map((g) => g.textures.main)));
    expect(mains.size).toBe(2); // rápida + final
  });

  it('un fallo en un trabajo publica error pero conserva lo que sí se pudo cargar', async () => {
    const exec = new FakeExecutor();
    const orig = exec.submit.bind(exec);
    exec.submit = (spec) => {
      if (spec.kind === 'garment') {
        const job = orig(spec);
        const item = exec.items[exec.items.length - 1]!;
        item.state = 'done';
        item.reject(new Error('geometría imposible'));
        return job;
      }
      return orig(spec);
    };
    const engine = new FittingEngine(exec);
    const snaps: FittingSnapshot[] = [];
    const w = engine.watch((s) => snaps.push(s));
    w.update({ measurements: M1, equipped: [item()], textureSize: 512 });
    await flush();
    const last = snaps[snaps.length - 1]!;
    expect(last.status).toBe('error');
    expect(last.errorMessage).toMatch(/geometría imposible/);
    expect(last.body).not.toBeNull();
    // un fallo no queda cacheado: reintentar vuelve a enviar el trabajo
    const n = exec.count('garment');
    w.update({ measurements: M1, equipped: [item()], textureSize: 512 });
    await flush();
    expect(exec.count('garment')).toBe(n + 1);
  });

  it('dispose() del observador libera interés (cancela lo pendiente) y no publica más', async () => {
    const t = setup();
    t.exec.manual = true;
    t.watcher.update(t.req(M1, [item()]));
    await flush(3);
    const n = t.snaps.length;
    t.watcher.dispose();
    expect(t.exec.cancelled.length).toBeGreaterThan(0); // garment + textures estaban en cola
    t.exec.manual = false;
    t.exec.finish();
    await flush();
    expect(t.snaps.length).toBe(n);
  });

  it('dos observadores comparten trabajos (un solo cuerpo) y cancelar uno no cancela lo del otro', async () => {
    const exec = new FakeExecutor();
    exec.manual = true;
    const engine = new FittingEngine(exec);
    const a: FittingSnapshot[] = [];
    const b: FittingSnapshot[] = [];
    const wa = engine.watch((s) => a.push(s));
    const wb = engine.watch((s) => b.push(s));
    wa.update({ measurements: M1, equipped: [item()], textureSize: 512 });
    wb.update({ measurements: M1, equipped: [item()], textureSize: 512 });
    await flush(3);
    expect(exec.count('body')).toBe(1);
    expect(exec.count('garment')).toBe(1);
    wa.dispose();
    expect(exec.cancelled).toHaveLength(0);
    exec.manual = false;
    exec.finish();
    await flush();
    expect(b[b.length - 1]!.status).toBe('ready');
  });

  it('LRU por bytes: expulsa resultados antiguos sin interés cuando se supera el tope', async () => {
    const t = setup(1_000_000); // ~1 MB: cabe poco
    t.watcher.update(t.req(M1, [item({}, 'S')]));
    await flush();
    t.watcher.update(t.req(M1, [item({}, 'M')]));
    await flush();
    t.watcher.update(t.req(M1, [item({}, 'L')]));
    await flush();
    expect(t.engine.counters.evicted).toBeGreaterThan(0);
    expect(t.engine.cacheBytes).toBeLessThanOrEqual(1_000_000 + 2_000_000);
    expect(t.last().status).toBe('ready');
  });

  it('dispose del motor limpia todo', async () => {
    const t = setup();
    t.watcher.update(t.req(M1, [item()]));
    await flush();
    t.engine.dispose();
    expect(t.engine.cacheSize).toBe(0);
    expect(t.engine.cacheBytes).toBe(0);
    expect(DOUBLE_FABRIC.id).toBeTruthy();
    vi.fn();
  });
});
