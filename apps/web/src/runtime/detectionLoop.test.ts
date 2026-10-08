import { describe, expect, it } from 'vitest';
import { DetectionLoop, type LoopHost, type VideoFrameSource } from './detectionLoop';

/** Host determinista: rAF y reloj controlados por el test. */
class FakeHost implements LoopHost {
  t = 0;
  hidden = false;
  private nextId = 1;
  private rafs = new Map<number, (t: number) => void>();
  raf(cb: (t: number) => void) {
    const id = this.nextId++;
    this.rafs.set(id, cb);
    return id;
  }
  caf(id: number) {
    this.rafs.delete(id);
  }
  now() {
    return this.t;
  }
  isHidden() {
    return this.hidden;
  }
  get pendingRafs() {
    return this.rafs.size;
  }
  /** avanza el reloj y dispara los rAF pendientes */
  frame(dt: number) {
    this.t += dt;
    const cbs = [...this.rafs.values()];
    this.rafs.clear();
    for (const cb of cbs) cb(this.t);
  }
}

class FakeVideo implements VideoFrameSource {
  currentTime = 0;
  private nextId = 1;
  cbs = new Map<number, (now: number, meta: { mediaTime?: number }) => void>();
  requestVideoFrameCallback(cb: (now: number, meta: { mediaTime?: number }) => void) {
    const id = this.nextId++;
    this.cbs.set(id, cb);
    return id;
  }
  cancelVideoFrameCallback(id: number) {
    this.cbs.delete(id);
  }
  emit(now: number, mediaTime: number) {
    const cbs = [...this.cbs.values()];
    this.cbs.clear();
    for (const cb of cbs) cb(now, { mediaTime });
  }
}

describe('DetectionLoop', () => {
  it('con rAF (sin vídeo): detecta ≤30 Hz aunque el render vaya a 60 Hz', () => {
    const host = new FakeHost();
    let ticks = 0;
    const loop = new DetectionLoop({
      source: () => null,
      onTick: () => ticks++,
      host,
      adaptive: false,
    });
    loop.start();
    for (let i = 0; i < 120; i++) host.frame(1000 / 60); // 2 s a 60 Hz
    expect(ticks).toBeGreaterThanOrEqual(55);
    expect(ticks).toBeLessThanOrEqual(61);
    loop.stop();
  });

  it('con requestVideoFrameCallback: una cámara de 30 fps no cae a 15 Hz por jitter', () => {
    const host = new FakeHost();
    const video = new FakeVideo();
    let ticks = 0;
    const loop = new DetectionLoop({
      source: () => video,
      onTick: () => ticks++,
      host,
      adaptive: false,
    });
    loop.start();
    // 30 fps con jitter ±3 ms
    let t = 0;
    for (let i = 0; i < 90; i++) {
      t += 1000 / 30 + (i % 2 === 0 ? 3 : -3);
      host.t = t;
      video.emit(t, i * 0.0333);
    }
    expect(ticks).toBeGreaterThanOrEqual(85);
    expect(host.pendingRafs).toBe(0); // no usa rAF cuando hay rVFC
  });

  it('con una cámara de 60 fps detecta cada ~2 fotogramas (≈30 Hz)', () => {
    const host = new FakeHost();
    const video = new FakeVideo();
    let ticks = 0;
    const loop = new DetectionLoop({
      source: () => video,
      onTick: () => ticks++,
      host,
      adaptive: false,
    });
    loop.start();
    for (let i = 0; i < 120; i++) {
      const t = i * (1000 / 60);
      host.t = t;
      video.emit(t, i / 60);
    }
    expect(ticks).toBeGreaterThanOrEqual(58);
    expect(ticks).toBeLessThanOrEqual(62);
  });

  it('fallback rAF con vídeo sin rVFC: deduplica fotogramas repetidos por currentTime', () => {
    const host = new FakeHost();
    const video: VideoFrameSource = { currentTime: 0 };
    let ticks = 0;
    const loop = new DetectionLoop({
      source: () => video,
      onTick: () => ticks++,
      host,
      adaptive: false,
    });
    loop.start();
    for (let i = 0; i < 30; i++) host.frame(1000 / 60); // currentTime no cambia → nada nuevo
    expect(ticks).toBe(1); // sólo el primero (mediaTime 0 vs -1)
    (video as { currentTime: number }).currentTime = 1;
    for (let i = 0; i < 4; i++) host.frame(1000 / 60);
    expect(ticks).toBe(2);
  });

  it('se adapta si la detección es cara (intervalo ≈ 1.7× coste) y respeta el tope', () => {
    const host = new FakeHost();
    const loop = new DetectionLoop({
      source: () => null,
      onTick: () => {
        host.t += 40; // detección de 40 ms
      },
      host,
      maxIntervalMs: 100,
    });
    loop.start();
    for (let i = 0; i < 200; i++) host.frame(1000 / 60);
    expect(loop.costMs).toBeGreaterThan(30);
    expect(loop.intervalMs).toBeGreaterThan(60);
    expect(loop.intervalMs).toBeLessThanOrEqual(100);
  });

  it('no detecta con la pestaña oculta y retoma al volver', () => {
    const host = new FakeHost();
    let ticks = 0;
    const loop = new DetectionLoop({ source: () => null, onTick: () => ticks++, host });
    loop.start();
    host.hidden = true;
    for (let i = 0; i < 60; i++) host.frame(33);
    expect(ticks).toBe(0);
    host.hidden = false;
    for (let i = 0; i < 6; i++) host.frame(33);
    expect(ticks).toBeGreaterThan(0);
  });

  it('stop() cancela lo pendiente (rAF y rVFC) y no vuelve a llamar', () => {
    const host = new FakeHost();
    const video = new FakeVideo();
    let ticks = 0;
    const loop = new DetectionLoop({ source: () => video, onTick: () => ticks++, host });
    loop.start();
    loop.stop();
    expect(video.cbs.size).toBe(0);
    video.emit(100, 1);
    expect(ticks).toBe(0);
    const loop2 = new DetectionLoop({ source: () => null, onTick: () => ticks++, host });
    loop2.start();
    loop2.stop();
    expect(host.pendingRafs).toBe(0);
    expect(loop.isRunning).toBe(false);
  });

  it('un error en onTick no mata el bucle y se notifica', () => {
    const host = new FakeHost();
    const errors: unknown[] = [];
    let ticks = 0;
    const loop = new DetectionLoop({
      source: () => null,
      onTick: () => {
        ticks++;
        throw new Error('boom');
      },
      host,
      onError: (e) => errors.push(e),
    });
    loop.start();
    for (let i = 0; i < 20; i++) host.frame(40);
    expect(ticks).toBeGreaterThan(3);
    expect(errors.length).toBe(ticks);
  });

  it('start() es idempotente', () => {
    const host = new FakeHost();
    const loop = new DetectionLoop({ source: () => null, onTick: () => {}, host });
    loop.start();
    loop.start();
    expect(host.pendingRafs).toBe(1);
  });
});
