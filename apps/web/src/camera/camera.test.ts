import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraManager, type CameraEnv, type MediaDevicesLike } from './cameraManager';
import { classifyCameraError } from './cameraErrors';

// ---------- Dobles ----------

class FakeTrack {
  stopped = false;
  enabled = true;
  onended: (() => void) | null = null;
  kind = 'video';
  stop() {
    this.stopped = true;
  }
  fireEnded() {
    this.onended?.();
  }
}

class FakeStream {
  readonly tracks: FakeTrack[];
  constructor(n = 1) {
    this.tracks = Array.from({ length: n }, () => new FakeTrack());
  }
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks;
  }
}

class FakeVideo extends EventTarget {
  muted = false;
  defaultMuted = false;
  playsInline = false;
  autoplay = false;
  srcObject: unknown = null;
  videoWidth = 1280;
  videoHeight = 720;
  paused = true;
  playImpl: () => Promise<void> = () => {
    this.paused = false;
    return Promise.resolve();
  };
  attrs = new Map<string, string>();
  pauseCalls = 0;
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  play() {
    return this.playImpl();
  }
  pause() {
    this.paused = true;
    this.pauseCalls++;
  }
  load() {}
}

function domError(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

interface Harness {
  manager: CameraManager;
  gum: ReturnType<typeof vi.fn>;
  videos: FakeVideo[];
  streams: FakeStream[];
  env: CameraEnv & { hiddenFlag: { value: boolean } };
  devices: { kinds: string[] };
  fireDocument(type: string): void;
  fireWindow(type: string): void;
  fireDeviceChange(): void;
  md: MediaDevicesLike & { listeners: Set<() => void> };
}

function makeHarness(opts: { secure?: boolean; noMediaDevices?: boolean } = {}): Harness {
  const videos: FakeVideo[] = [];
  const streams: FakeStream[] = [];
  const docTarget = new EventTarget();
  const winTarget = new EventTarget();
  const hiddenFlag = { value: false };
  const devices = { kinds: ['videoinput'] };
  const gum = vi.fn(async () => {
    const s = new FakeStream();
    streams.push(s);
    return s as unknown as MediaStream;
  });
  const listeners = new Set<() => void>();
  const md = {
    getUserMedia: gum,
    enumerateDevices: async () => devices.kinds.map((kind) => ({ kind }) as MediaDeviceInfo),
    addEventListener: (_t: 'devicechange', l: () => void) => listeners.add(l),
    removeEventListener: (_t: 'devicechange', l: () => void) => listeners.delete(l),
    listeners,
  };
  const env = {
    getMediaDevices: () => (opts.noMediaDevices ? undefined : (md as MediaDevicesLike)),
    isSecureContext: () => opts.secure ?? true,
    createVideo: () => {
      const v = new FakeVideo();
      videos.push(v);
      return v as unknown as HTMLVideoElement;
    },
    doc: Object.defineProperty(docTarget, 'hidden', {
      get: () => hiddenFlag.value,
    }) as unknown as CameraEnv['doc'],
    win: winTarget as unknown as CameraEnv['win'],
    metadataTimeoutMs: 50,
    hiddenFlag,
  };
  return {
    manager: new CameraManager(env),
    gum,
    videos,
    streams,
    env,
    devices,
    md,
    fireDocument: (t) => docTarget.dispatchEvent(new Event(t)),
    fireWindow: (t) => winTarget.dispatchEvent(new Event(t)),
    fireDeviceChange: () => listeners.forEach((l) => l()),
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('classifyCameraError', () => {
  it.each([
    ['NotAllowedError', 'denied', false],
    ['PermissionDeniedError', 'denied', false],
    ['SecurityError', 'insecure-context', false],
    ['NotFoundError', 'unavailable', true],
    ['DevicesNotFoundError', 'unavailable', true],
    ['OverconstrainedError', 'unavailable', true],
    ['NotReadableError', 'error', false],
    ['TrackStartError', 'error', false],
    ['AbortError', 'error', false],
    ['TypeError', 'error', false],
  ])('%s → %s (retryRelaxed=%s)', (name, status, retry) => {
    const c = classifyCameraError(domError(name));
    expect(c.status).toBe(status);
    expect(c.retryRelaxed).toBe(retry);
    expect(c.message.length).toBeGreaterThan(10);
  });

  it('tolera valores lanzados que no son Error', () => {
    for (const v of [undefined, null, 42, 'boom', {}, { name: 7 }]) {
      expect(classifyCameraError(v).status).toBe('error');
    }
  });
});

describe('CameraManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('camino feliz: pide las constraints correctas y publica un <video> muted/playsInline', async () => {
    const h = makeHarness();
    expect(h.manager.getSnapshot().status).toBe('idle');
    const p = h.manager.start();
    expect(h.manager.getSnapshot().status).toBe('requesting');
    await p;
    const snap = h.manager.getSnapshot();
    expect(snap.status).toBe('ready');
    expect(snap.video).toBe(h.videos[0]);
    expect(h.gum).toHaveBeenCalledTimes(1);
    expect(h.gum).toHaveBeenCalledWith({
      video: {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
    const v = h.videos[0]!;
    expect(v.muted).toBe(true);
    expect(v.playsInline).toBe(true);
    expect(v.attrs.get('playsinline')).toBe('');
    expect(v.srcObject).toBe(h.streams[0]);
  });

  it('start() es idempotente: dos llamadas concurrentes comparten petición; tras ready no repite', async () => {
    const h = makeHarness();
    const a = h.manager.start();
    const b = h.manager.start();
    expect(a).toBe(b);
    await Promise.all([a, b]);
    await h.manager.start();
    expect(h.gum).toHaveBeenCalledTimes(1);
    expect(h.videos).toHaveLength(1);
    expect(h.manager.getSnapshot().status).toBe('ready');
  });

  it('stop() detiene TODAS las pistas, libera el <video> y vuelve a idle', async () => {
    const h = makeHarness();
    await h.manager.start();
    const stream = h.streams[0]!;
    stream.tracks.push(new FakeTrack()); // varias pistas
    const video = h.videos[0]!;
    h.manager.stop();
    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
    expect(video.srcObject).toBeNull();
    expect(video.paused).toBe(true);
    const snap = h.manager.getSnapshot();
    expect(snap.status).toBe('idle');
    expect(snap.video).toBeNull();
  });

  it('stop() durante requesting: la pista que llega tarde se detiene y el estado queda idle', async () => {
    const h = makeHarness();
    let resolveGum!: (s: MediaStream) => void;
    h.gum.mockImplementationOnce(
      () =>
        new Promise<MediaStream>((r) => {
          resolveGum = r;
        }),
    );
    const p = h.manager.start();
    expect(h.manager.getSnapshot().status).toBe('requesting');
    h.manager.stop();
    expect(h.manager.getSnapshot().status).toBe('idle');
    const late = new FakeStream(2);
    resolveGum(late as unknown as MediaStream);
    await p;
    expect(late.tracks.every((t) => t.stopped)).toBe(true);
    expect(h.manager.getSnapshot().status).toBe('idle');
    expect(h.videos).toHaveLength(0);
  });

  it('stop() + start() inmediato: la petición antigua no pisa a la nueva', async () => {
    const h = makeHarness();
    const resolvers: ((s: MediaStream) => void)[] = [];
    h.gum.mockImplementation(
      () =>
        new Promise<MediaStream>((r) => {
          resolvers.push(r);
        }),
    );
    const p1 = h.manager.start();
    h.manager.stop();
    const p2 = h.manager.start();
    expect(p2).not.toBe(p1);
    const s1 = new FakeStream();
    const s2 = new FakeStream();
    resolvers[1]!(s2 as unknown as MediaStream);
    resolvers[0]!(s1 as unknown as MediaStream);
    await Promise.all([p1, p2]);
    expect(s1.tracks[0]!.stopped).toBe(true);
    expect(s2.tracks[0]!.stopped).toBe(false);
    expect(h.manager.getSnapshot().status).toBe('ready');
  });

  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'insecure-context'],
    ['NotReadableError', 'error'],
    ['AbortError', 'error'],
    ['TypeError', 'error'],
  ])('error %s → estado %s con mensaje claro, sin pistas colgadas', async (name, status) => {
    const h = makeHarness();
    h.gum.mockRejectedValueOnce(domError(name));
    await h.manager.start();
    const snap = h.manager.getSnapshot();
    expect(snap.status).toBe(status);
    expect(snap.errorMessage).toBeTruthy();
    expect(snap.video).toBeNull();
    expect(h.gum).toHaveBeenCalledTimes(1); // sin reintento para estos
  });

  it('NotFoundError reintenta UNA vez con constraints relajadas y, si falla, → unavailable', async () => {
    const h = makeHarness();
    h.gum.mockRejectedValue(domError('NotFoundError'));
    await h.manager.start();
    expect(h.manager.getSnapshot().status).toBe('unavailable');
    expect(h.gum).toHaveBeenCalledTimes(2);
    expect(h.gum.mock.calls[1]![0]).toEqual({ video: true, audio: false });
  });

  it('OverconstrainedError: el reintento relajado puede tener éxito', async () => {
    const h = makeHarness();
    h.gum.mockRejectedValueOnce(domError('OverconstrainedError'));
    await h.manager.start();
    expect(h.manager.getSnapshot().status).toBe('ready');
    expect(h.gum).toHaveBeenCalledTimes(2);
    expect(h.gum.mock.calls[1]![0]).toEqual({ video: true, audio: false });
  });

  it('el reintento relajado también puede ser denegado', async () => {
    const h = makeHarness();
    h.gum.mockRejectedValueOnce(domError('OverconstrainedError'));
    h.gum.mockRejectedValueOnce(domError('NotAllowedError'));
    await h.manager.start();
    expect(h.manager.getSnapshot().status).toBe('denied');
  });

  it('contexto no seguro → insecure-context sin llamar a getUserMedia', async () => {
    const h = makeHarness({ secure: false });
    await h.manager.start();
    expect(h.manager.getSnapshot().status).toBe('insecure-context');
    expect(h.gum).not.toHaveBeenCalled();
  });

  it('sin navigator.mediaDevices (contexto seguro) → unavailable', async () => {
    const h = makeHarness({ noMediaDevices: true });
    await h.manager.start();
    const snap = h.manager.getSnapshot();
    expect(snap.status).toBe('unavailable');
    expect(snap.errorMessage).toBeTruthy();
  });

  it('tras un error se puede reintentar con start()', async () => {
    const h = makeHarness();
    h.gum.mockRejectedValueOnce(domError('NotAllowedError'));
    await h.manager.start();
    expect(h.manager.getSnapshot().status).toBe('denied');
    await h.manager.start();
    expect(h.manager.getSnapshot().status).toBe('ready');
  });

  it('si play() falla, libera la pista y notifica error', async () => {
    const h = makeHarness();
    const orig = h.env.createVideo;
    h.env.createVideo = () => {
      const v = orig() as unknown as FakeVideo;
      v.playImpl = () => Promise.reject(domError('NotAllowedError'));
      return v as unknown as HTMLVideoElement;
    };
    await h.manager.start();
    expect(h.manager.getSnapshot().status).toBe('error');
    expect(h.streams[0]!.tracks[0]!.stopped).toBe(true);
  });

  it('si el vídeo nunca obtiene dimensiones, agota el tiempo → error y libera', async () => {
    const h = makeHarness();
    const orig = h.env.createVideo;
    h.env.createVideo = () => {
      const v = orig() as unknown as FakeVideo;
      v.videoWidth = 0;
      v.videoHeight = 0;
      return v as unknown as HTMLVideoElement;
    };
    const p = h.manager.start();
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(h.manager.getSnapshot().status).toBe('error');
    expect(h.streams[0]!.tracks[0]!.stopped).toBe(true);
  });

  it('espera loadedmetadata si las dimensiones llegan después de play()', async () => {
    const h = makeHarness();
    const orig = h.env.createVideo;
    let created!: FakeVideo;
    h.env.createVideo = () => {
      created = orig() as unknown as FakeVideo;
      created.videoWidth = 0;
      created.videoHeight = 0;
      return created as unknown as HTMLVideoElement;
    };
    const p = h.manager.start();
    await flush();
    expect(h.manager.getSnapshot().status).toBe('requesting');
    created.videoWidth = 640;
    created.videoHeight = 480;
    created.dispatchEvent(new Event('loadedmetadata'));
    await p;
    expect(h.manager.getSnapshot().status).toBe('ready');
  });

  it('visibilitychange: pausa y desactiva pistas al ocultarse; reanuda al volver', async () => {
    const h = makeHarness();
    await h.manager.start();
    const video = h.videos[0]!;
    const track = h.streams[0]!.tracks[0]!;
    h.env.hiddenFlag.value = true;
    h.fireDocument('visibilitychange');
    expect(video.paused).toBe(true);
    expect(track.enabled).toBe(false);
    expect(h.manager.getSnapshot().status).toBe('ready'); // sigue "ready": sólo en pausa
    h.env.hiddenFlag.value = false;
    h.fireDocument('visibilitychange');
    await flush();
    expect(track.enabled).toBe(true);
    expect(video.paused).toBe(false);
  });

  it('pagehide detiene la cámara', async () => {
    const h = makeHarness();
    await h.manager.start();
    h.fireWindow('pagehide');
    expect(h.streams[0]!.tracks[0]!.stopped).toBe(true);
    expect(h.manager.getSnapshot().status).toBe('idle');
  });

  it('track.onended (cámara desenchufada) → error y todo liberado', async () => {
    const h = makeHarness();
    await h.manager.start();
    h.streams[0]!.tracks[0]!.fireEnded();
    const snap = h.manager.getSnapshot();
    expect(snap.status).toBe('error');
    expect(snap.errorMessage).toMatch(/desconect/);
    expect(snap.video).toBeNull();
    expect(h.streams[0]!.tracks[0]!.stopped).toBe(true);
  });

  it('track.onended sin más cámaras → unavailable', async () => {
    const h = makeHarness();
    await h.manager.start();
    h.devices.kinds = [];
    h.streams[0]!.tracks[0]!.fireEnded();
    await flush();
    expect(h.manager.getSnapshot().status).toBe('unavailable');
  });

  it('devicechange: unavailable → idle cuando aparece una cámara', async () => {
    const h = makeHarness();
    h.manager.attach();
    h.devices.kinds = [];
    h.gum.mockRejectedValue(domError('NotFoundError'));
    await h.manager.start();
    expect(h.manager.getSnapshot().status).toBe('unavailable');
    h.devices.kinds = ['videoinput'];
    h.fireDeviceChange();
    await flush();
    expect(h.manager.getSnapshot().status).toBe('idle');
  });

  it('devicechange con la cámara activa que desaparece → unavailable y pistas detenidas', async () => {
    const h = makeHarness();
    await h.manager.start();
    h.devices.kinds = ['audioinput'];
    h.fireDeviceChange();
    await flush();
    expect(h.manager.getSnapshot().status).toBe('unavailable');
    expect(h.streams[0]!.tracks[0]!.stopped).toBe(true);
  });

  it('detach() (desmontaje) detiene la cámara y quita TODOS los escuchas', async () => {
    const h = makeHarness();
    await h.manager.start();
    expect(h.md.listeners.size).toBe(1);
    h.manager.detach();
    expect(h.streams[0]!.tracks[0]!.stopped).toBe(true);
    expect(h.md.listeners.size).toBe(0);
    // tras detach, los eventos globales ya no hacen nada
    h.fireWindow('pagehide');
    h.fireDocument('visibilitychange');
    expect(h.manager.getSnapshot().status).toBe('idle');
  });

  it('StrictMode: attach → detach → attach no deja escuchas duplicados', () => {
    const h = makeHarness();
    h.manager.attach();
    h.manager.detach();
    h.manager.attach();
    expect(h.md.listeners.size).toBe(1);
    h.manager.detach();
    expect(h.md.listeners.size).toBe(0);
  });

  it('notifica a los suscriptores en cada cambio y el snapshot es estable entre cambios', async () => {
    const h = makeHarness();
    const seen: string[] = [];
    const unsub = h.manager.subscribe(() => seen.push(h.manager.getSnapshot().status));
    const before = h.manager.getSnapshot();
    expect(h.manager.getSnapshot()).toBe(before);
    await h.manager.start();
    expect(seen).toEqual(['requesting', 'ready']);
    unsub();
    h.manager.stop();
    expect(seen).toEqual(['requesting', 'ready']);
  });

  it('privacidad: el módulo no usa MediaRecorder ni red', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.dirname(new URL(import.meta.url).pathname);
    for (const f of ['cameraManager.ts', 'cameraErrors.ts', 'useCamera.ts']) {
      const src = fs
        .readFileSync(path.join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(src).not.toMatch(/MediaRecorder|fetch\(|XMLHttpRequest|WebSocket|sendBeacon/);
    }
  });
});
