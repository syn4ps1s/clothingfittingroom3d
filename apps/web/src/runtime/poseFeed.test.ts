import { describe, expect, it } from 'vitest';
import type { PoseFrame, PoseProvider } from '@fitroom/shared';
import { PoseFeed } from './poseFeed';
import type { LoopHost } from './detectionLoop';

class FakeHost implements LoopHost {
  t = 0;
  private id = 1;
  private cbs = new Map<number, (t: number) => void>();
  raf(cb: (t: number) => void) {
    const i = this.id++;
    this.cbs.set(i, cb);
    return i;
  }
  caf(i: number) {
    this.cbs.delete(i);
  }
  now() {
    return this.t;
  }
  isHidden() {
    return false;
  }
  frame(dt: number) {
    this.t += dt;
    const cbs = [...this.cbs.values()];
    this.cbs.clear();
    cbs.forEach((c) => c(this.t));
  }
}

const frameOf = (ts: number): PoseFrame => ({
  timestampMs: ts,
  imageSize: { width: 1280, height: 720 },
  image: [],
  world: [],
  personCount: 1,
});

function fakeProvider(overrides: Partial<PoseProvider> = {}): PoseProvider & {
  disposed: boolean;
  stamps: number[];
} {
  const p = {
    name: 'fake',
    disposed: false,
    stamps: [] as number[],
    init: async () => {},
    detect(_s: object, ts: number) {
      p.stamps.push(ts);
      return frameOf(ts);
    },
    dispose() {
      p.disposed = true;
    },
    ...overrides,
  };
  return p;
}

const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('PoseFeed', () => {
  it('inicializa el proveedor, detecta a ≤30 Hz y reparte a todos los suscriptores', async () => {
    const host = new FakeHost();
    const provider = fakeProvider();
    const feed = new PoseFeed({
      createProvider: async () => provider,
      getSource: () => ({}),
      host,
    });
    const a: number[] = [];
    const b: number[] = [];
    feed.subscribe((e) => a.push(e.timestampMs));
    feed.subscribe((e) => b.push(e.timestampMs));
    await feed.start();
    expect(feed.state).toBe('running');
    for (let i = 0; i < 60; i++) host.frame(1000 / 60);
    expect(a.length).toBeGreaterThan(25);
    expect(a.length).toBeLessThan(32);
    expect(b.length).toBe(a.length);
  });

  it('timestamps estrictamente crecientes aunque el reloj no avance', async () => {
    const host = new FakeHost();
    const provider = fakeProvider();
    const feed = new PoseFeed({
      createProvider: async () => provider,
      getSource: () => ({}),
      timestampOf: () => 1000, // reloj congelado
      host,
    });
    await feed.start();
    for (let i = 0; i < 20; i++) host.frame(40);
    for (let i = 1; i < provider.stamps.length; i++) {
      expect(provider.stamps[i]!).toBeGreaterThan(provider.stamps[i - 1]!);
    }
  });

  it('sin fuente (vídeo aún no listo) no llama al proveedor', async () => {
    const host = new FakeHost();
    const provider = fakeProvider();
    let source: object | null = null;
    const feed = new PoseFeed({ createProvider: async () => provider, getSource: () => source, host });
    await feed.start();
    for (let i = 0; i < 10; i++) host.frame(40);
    expect(provider.stamps).toHaveLength(0);
    source = {};
    for (let i = 0; i < 4; i++) host.frame(40);
    expect(provider.stamps.length).toBeGreaterThan(0);
  });

  it('si detect lanza, entrega "sin persona" y avisa una sola vez; el bucle sigue vivo', async () => {
    const host = new FakeHost();
    const errors: unknown[] = [];
    let n = 0;
    const provider = fakeProvider({
      detect: () => {
        n++;
        throw new Error('sin fotograma');
      },
    });
    const events: (PoseFrame | null)[] = [];
    const feed = new PoseFeed({
      createProvider: async () => provider,
      getSource: () => ({}),
      host,
      onError: (e) => errors.push(e),
    });
    feed.subscribe((e) => events.push(e.frame));
    await feed.start();
    for (let i = 0; i < 20; i++) host.frame(40);
    expect(n).toBeGreaterThan(5);
    expect(events.every((f) => f === null)).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it('fallo al crear el proveedor → estado failed, sin lanzar', async () => {
    const host = new FakeHost();
    const errors: unknown[] = [];
    const feed = new PoseFeed({
      createProvider: async () => {
        throw new Error('modelo no disponible');
      },
      getSource: () => ({}),
      host,
      onError: (e) => errors.push(e),
    });
    await feed.start();
    expect(feed.state).toBe('failed');
    expect(errors).toHaveLength(1);
  });

  it('stop() durante la inicialización libera el proveedor al llegar', async () => {
    const host = new FakeHost();
    const provider = fakeProvider();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const feed = new PoseFeed({
      createProvider: async () => {
        await gate;
        return provider;
      },
      getSource: () => ({}),
      host,
    });
    const p = feed.start();
    feed.stop();
    release();
    await p;
    await tick();
    expect(provider.disposed).toBe(true);
    expect(feed.state).toBe('idle');
  });

  it('stop() libera el proveedor y detiene el bucle', async () => {
    const host = new FakeHost();
    const provider = fakeProvider();
    const feed = new PoseFeed({ createProvider: async () => provider, getSource: () => ({}), host });
    await feed.start();
    host.frame(40);
    feed.stop();
    const n = provider.stamps.length;
    for (let i = 0; i < 10; i++) host.frame(40);
    expect(provider.stamps.length).toBe(n);
    expect(provider.disposed).toBe(true);
  });

  it('start() doble no crea dos proveedores', async () => {
    const host = new FakeHost();
    let created = 0;
    const feed = new PoseFeed({
      createProvider: async () => {
        created++;
        return fakeProvider();
      },
      getSource: () => ({}),
      host,
    });
    await Promise.all([feed.start(), feed.start()]);
    expect(created).toBe(1);
  });
});
