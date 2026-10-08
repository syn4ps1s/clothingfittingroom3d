import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LM, POSE_LANDMARK_COUNT } from '@fitroom/shared';
import {
  PoseProviderError,
  convertMask,
  convertPoseResult,
  createMediaPipePoseProvider,
  primaryPersonScore,
  sourceSize,
  type RawLandmark,
  type RawPoseResult,
} from './mediapipe.js';

const mp = vi.hoisted(() => ({
  forVisionTasks: vi.fn(),
  createFromOptions: vi.fn(),
}));
vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: mp.forVisionTasks },
  PoseLandmarker: { createFromOptions: mp.createFromOptions },
}));

const person = (cx: number, top: number, bottom: number, vis = 0.9): RawLandmark[] =>
  Array.from({ length: POSE_LANDMARK_COUNT }, (_, i) => ({
    x: cx + ((i % 5) - 2) * 0.02,
    y: top + ((bottom - top) * i) / (POSE_LANDMARK_COUNT - 1),
    z: -0.1 * (i % 3),
    visibility: vis,
  }));
const world = (): RawLandmark[] =>
  Array.from({ length: POSE_LANDMARK_COUNT }, (_, i) => ({
    x: 0.01 * i,
    y: 0.5 - 0.03 * i, // MediaPipe: y hacia abajo
    z: 0.02 * i - 0.1, // MediaPipe: z menor = más cerca de la cámara
    visibility: 0.8,
  }));

describe('convertPoseResult', () => {
  const size = { width: 640, height: 480 };

  it('convierte world a la convención del proyecto (X=x, Y=−y, Z=−z) y deja image sin tocar', () => {
    const lms = person(0.5, 0.1, 0.9);
    const w = world();
    const f = convertPoseResult({ landmarks: [lms], worldLandmarks: [w] }, size, 1234)!;
    expect(f.timestampMs).toBe(1234);
    expect(f.imageSize).toEqual(size);
    expect(f.personCount).toBe(1);
    for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
      expect(f.image[i]).toEqual({ x: lms[i]!.x, y: lms[i]!.y, z: lms[i]!.z, visibility: 0.9 });
      expect(f.world[i]!.x).toBe(w[i]!.x);
      expect(f.world[i]!.y).toBe(-w[i]!.y);
      expect(f.world[i]!.z).toBe(-w[i]!.z);
    }
    // cabeza (índice 0) arriba y hombros a la altura correcta en el sistema del proyecto
    expect(f.world[0]!.y).toBeGreaterThan(f.world[32]!.y === 0 ? -1 : -2);
  });

  it('elige la persona principal (mayor área y más centrada) e informa personCount', () => {
    const small = person(0.85, 0.3, 0.5);
    const big = person(0.5, 0.05, 0.95);
    const f = convertPoseResult(
      { landmarks: [small, big, person(0.1, 0.4, 0.6)], worldLandmarks: [world(), world(), world()] },
      size,
      0,
    )!;
    expect(f.personCount).toBe(3);
    expect(f.image[LM.nose]!.x).toBeCloseTo(big[0]!.x, 9);
    expect(primaryPersonScore(big)).toBeGreaterThan(primaryPersonScore(small));
  });

  it('0 personas, listas cortas o desalineadas ⇒ null; ignora poses incompletas', () => {
    expect(convertPoseResult({ landmarks: [], worldLandmarks: [] }, size, 0)).toBeNull();
    expect(convertPoseResult({ landmarks: [person(0.5, 0, 1).slice(0, 10)], worldLandmarks: [world()] }, size, 0)).toBeNull();
    expect(convertPoseResult({ landmarks: [person(0.5, 0, 1)], worldLandmarks: [] }, size, 0)).toBeNull();
    const f = convertPoseResult(
      { landmarks: [person(0.5, 0, 1).slice(0, 5), person(0.5, 0, 1)], worldLandmarks: [world(), world()] },
      size,
      0,
    )!;
    expect(f.personCount).toBe(1);
  });

  it('NaN/Inf/undefined ⇒ 0 con visibilidad 0; presence limita la visibilidad; 100 personas', () => {
    const bad = person(0.5, 0.1, 0.9).map((l, i) =>
      i === 3 ? { ...l, x: NaN } : i === 4 ? { ...l, visibility: undefined } : i === 5 ? { ...l, presence: 0.1 } : l,
    ) as RawLandmark[];
    const w = world().map((l, i) => (i === 6 ? { ...l, y: Infinity } : l));
    const f = convertPoseResult({ landmarks: [bad], worldLandmarks: [w] }, size, 5)!;
    expect(f.image[3]).toEqual({ x: 0, y: 0, z: 0, visibility: 0 });
    expect(f.image[4]!.visibility).toBeCloseTo(0.8, 9); // sin visibilidad en imagen se usa la de world
    expect(f.image[5]!.visibility).toBeCloseTo(0.1, 9);
    expect(f.world[6]).toEqual({ x: 0, y: 0, z: 0, visibility: 0 });
    for (const l of [...f.image, ...f.world]) expect(Number.isFinite(l.x + l.y + l.z + l.visibility)).toBe(true);
    const crowd = Array.from({ length: 100 }, (_, k) => person(0.01 * k, 0.1, 0.1 + 0.008 * k));
    const c = convertPoseResult({ landmarks: crowd, worldLandmarks: crowd.map(world) }, size, 0)!;
    expect(c.personCount).toBe(100);
  });

  it('visibilidades fuera de rango se acotan a [0,1]', () => {
    const lms = person(0.5, 0.1, 0.9).map((l, i) => ({ ...l, visibility: i % 2 ? 7 : -3 }));
    const f = convertPoseResult({ landmarks: [lms], worldLandmarks: [world()] }, size, 0)!;
    for (const l of f.image) expect(l.visibility === 0 || l.visibility === 1).toBe(true);
  });

  it('máscara: float 0..1 → 0..255, submuestreada; vacía ⇒ ausente', () => {
    const w = 512;
    const h = 384;
    const data = new Float32Array(w * h).fill(0.5);
    const mask = { width: w, height: h, getAsFloat32Array: () => data };
    const m = convertMask(mask, 256)!;
    expect(Math.max(m.width, m.height)).toBeLessThanOrEqual(256);
    expect(m.data.length).toBe(m.width * m.height);
    expect(m.data[0]).toBe(128);
    // máscara vacía en float pero con lectura Uint8 válida
    const u8 = new Uint8Array(w * h).fill(200);
    const m2 = convertMask(
      { width: w, height: h, getAsFloat32Array: () => new Float32Array(w * h), getAsUint8Array: () => u8 },
      512,
    )!;
    expect(m2.data[0]).toBe(200);
    expect(convertMask({ width: w, height: h, getAsFloat32Array: () => new Float32Array(w * h) }, 256)).toBeUndefined();
    expect(convertMask({ width: 0, height: 5, getAsFloat32Array: () => new Float32Array(0) }, 256)).toBeUndefined();
    expect(convertMask({ width: 4, height: 4, getAsFloat32Array: () => new Float32Array(3) }, 256)).toBeUndefined();
    const withNaN = new Float32Array(16).fill(NaN);
    withNaN[0] = 1;
    expect(convertMask({ width: 4, height: 4, getAsFloat32Array: () => withNaN }, 256)!.data[1]).toBe(0);
    const raw: RawPoseResult = {
      landmarks: [person(0.5, 0.1, 0.9)],
      worldLandmarks: [world()],
      segmentationMasks: [mask],
    };
    expect(convertPoseResult(raw, size, 0, { maskMaxSide: 64 })!.mask!.width).toBeLessThanOrEqual(64);
  });

  it('sourceSize reconoce vídeo, imagen, canvas, VideoFrame y desconocidos', () => {
    expect(sourceSize({ videoWidth: 640, videoHeight: 480 })).toEqual({ width: 640, height: 480 });
    expect(sourceSize({ naturalWidth: 512, naturalHeight: 256 })).toEqual({ width: 512, height: 256 });
    expect(sourceSize({ displayWidth: 100, displayHeight: 50 })).toEqual({ width: 100, height: 50 });
    expect(sourceSize({ width: 30, height: 20 })).toEqual({ width: 30, height: 20 });
    expect(sourceSize({})).toEqual({ width: 1, height: 1 });
    expect(sourceSize({ videoWidth: 0, videoHeight: 0, width: 7, height: 9 })).toEqual({ width: 7, height: 9 });
  });
});

// -------------------------------------------------------------------------------------------------

interface FakeLandmarker {
  detectForVideo: ReturnType<typeof vi.fn>;
  detect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  stamps: number[];
}

const okResult = (): RawPoseResult => ({
  landmarks: [person(0.5, 0.1, 0.9)],
  worldLandmarks: [world()],
});

function fakeLandmarker(opts: { throwOnDetect?: boolean } = {}): FakeLandmarker {
  const stamps: number[] = [];
  const fl: FakeLandmarker = {
    stamps,
    detectForVideo: vi.fn((_img: unknown, ts: number, cb: (r: RawPoseResult) => void) => {
      if (opts.throwOnDetect) throw new Error('Packet timestamp mismatch');
      if (stamps.length && ts <= stamps[stamps.length - 1]!) throw new Error('Packet timestamp mismatch');
      stamps.push(ts);
      cb(okResult());
    }),
    detect: vi.fn((_img: unknown, cb: (r: RawPoseResult) => void) => cb(okResult())),
    close: vi.fn(),
  };
  return fl;
}

const modelBytes = new Uint8Array(4096).fill(1);
const okFetch = (): Promise<Response> =>
  Promise.resolve(new Response(modelBytes, { status: 200 }));

describe('createMediaPipePoseProvider (con MediaPipe simulado)', () => {
  const baseOpts = { modelUrl: '/models/m.task', wasmBaseUrl: '/wasm' };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mp.forVisionTasks.mockReset().mockResolvedValue({ wasmLoaderPath: 'l', wasmBinaryPath: 'b' });
    mp.createFromOptions.mockReset();
    vi.stubGlobal('fetch', vi.fn(okFetch));
    vi.stubGlobal('location', { href: 'http://localhost:5173/', origin: 'http://localhost:5173' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it('opciones inválidas ⇒ error tipado invalid-options', async () => {
    await expect(createMediaPipePoseProvider({ ...baseOpts, modelUrl: '' }).init()).rejects.toMatchObject({
      name: 'PoseProviderError',
      code: 'invalid-options',
    });
    await expect(createMediaPipePoseProvider({ ...baseOpts, wasmBaseUrl: '' }).init()).rejects.toBeInstanceOf(
      PoseProviderError,
    );
  });

  it('modelo no cargable (HTTP 404, red caída, demasiado pequeño) ⇒ model-load-failed', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('no', { status: 404 }))));
    await expect(createMediaPipePoseProvider(baseOpts).init()).rejects.toMatchObject({ code: 'model-load-failed' });
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(createMediaPipePoseProvider(baseOpts).init()).rejects.toMatchObject({ code: 'model-load-failed' });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(new Uint8Array(10), { status: 200 }))));
    await expect(createMediaPipePoseProvider(baseOpts).init()).rejects.toMatchObject({ code: 'model-load-failed' });
  });

  it('WASM no soportado ⇒ wasm-unsupported; otros fallos ⇒ init-failed', async () => {
    mp.forVisionTasks.mockRejectedValue(new Error('WebAssembly.instantiate(): CompileError'));
    await expect(createMediaPipePoseProvider(baseOpts).init()).rejects.toMatchObject({ code: 'wasm-unsupported' });
    mp.forVisionTasks.mockReset().mockResolvedValue({});
    mp.createFromOptions.mockRejectedValue(new Error('algo raro'));
    await expect(createMediaPipePoseProvider({ ...baseOpts, delegate: 'CPU' }).init()).rejects.toMatchObject({
      code: 'init-failed',
    });
    mp.createFromOptions.mockRejectedValue(new Error('wasm module could not be instantiated'));
    await expect(createMediaPipePoseProvider({ ...baseOpts, delegate: 'CPU' }).init()).rejects.toMatchObject({
      code: 'wasm-unsupported',
    });
  });

  it('GPU falla en la creación ⇒ cae a CPU automáticamente y lo notifica una vez', async () => {
    const fl = fakeLandmarker();
    mp.createFromOptions
      .mockRejectedValueOnce(new Error('WebGL no disponible'))
      .mockResolvedValueOnce(fl);
    const onDelegateFallback = vi.fn();
    const p = createMediaPipePoseProvider({ ...baseOpts, onDelegateFallback });
    await p.init();
    expect(p.delegate).toBe('CPU');
    expect(onDelegateFallback).toHaveBeenCalledTimes(1);
    expect(mp.createFromOptions.mock.calls[0]![1].baseOptions.delegate).toBe('GPU');
    expect(mp.createFromOptions.mock.calls[1]![1].baseOptions.delegate).toBe('CPU');
    expect(p.detect({ videoWidth: 4, videoHeight: 3 }, 10)!.personCount).toBe(1);
    p.dispose();
  });

  it('opciones pasadas a MediaPipe: numPoses 2, VIDEO, máscara opcional, umbrales', async () => {
    mp.createFromOptions.mockResolvedValue(fakeLandmarker());
    const p = createMediaPipePoseProvider({
      ...baseOpts,
      delegate: 'CPU',
      outputSegmentationMask: true,
      minPoseDetectionConfidence: 0.6,
      minTrackingConfidence: 0.4,
      minPosePresenceConfidence: 0.3,
    });
    await p.init();
    const o = mp.createFromOptions.mock.calls[0]![1];
    expect(o.numPoses).toBe(2);
    expect(o.runningMode).toBe('VIDEO');
    expect(o.outputSegmentationMasks).toBe(true);
    expect(o.minPoseDetectionConfidence).toBe(0.6);
    expect(o.minTrackingConfidence).toBe(0.4);
    expect(o.minPosePresenceConfidence).toBe(0.3);
    expect(o.baseOptions.modelAssetBuffer).toBeInstanceOf(Uint8Array);
    p.dispose();
  });

  it('init es idempotente (una sola carga) y reintentable tras un fallo', async () => {
    mp.createFromOptions.mockResolvedValue(fakeLandmarker());
    const p = createMediaPipePoseProvider({ ...baseOpts, delegate: 'CPU' });
    await Promise.all([p.init(), p.init()]);
    expect(mp.forVisionTasks).toHaveBeenCalledTimes(1);
    p.dispose();
    await expect(p.init()).rejects.toBeInstanceOf(PoseProviderError);

    mp.forVisionTasks.mockReset().mockRejectedValueOnce(new Error('red')).mockResolvedValue({});
    const q = createMediaPipePoseProvider({ ...baseOpts, delegate: 'CPU' });
    await expect(q.init()).rejects.toBeInstanceOf(PoseProviderError);
    await q.init();
    expect(q.delegate).toBe('CPU');
    q.dispose();
  });

  it('detect: antes de init lanza error tipado; tras dispose devuelve null; dispose idempotente', async () => {
    const fl = fakeLandmarker();
    mp.createFromOptions.mockResolvedValue(fl);
    const p = createMediaPipePoseProvider({ ...baseOpts, delegate: 'CPU' });
    expect(() => p.detect({}, 1)).toThrowError(PoseProviderError);
    await p.init();
    expect(p.detect({}, 1)).not.toBeNull();
    p.dispose();
    p.dispose();
    expect(fl.close).toHaveBeenCalledTimes(1);
    expect(p.detect({}, 2)).toBeNull();
  });

  it('timestamps monótonos: repetidos, hacia atrás o NaN no hacen lanzar a MediaPipe', async () => {
    const fl = fakeLandmarker();
    mp.createFromOptions.mockResolvedValue(fl);
    const p = createMediaPipePoseProvider({ ...baseOpts, delegate: 'CPU' });
    await p.init();
    for (const ts of [100, 100, 100.7, 90, 200, NaN, Infinity, 150.2, 300]) {
      expect(p.detect({}, ts)).not.toBeNull();
    }
    for (let i = 1; i < fl.stamps.length; i++) expect(fl.stamps[i]!).toBeGreaterThan(fl.stamps[i - 1]!);
    expect(fl.stamps.every(Number.isInteger)).toBe(true);
    expect(p.lastError).toBeNull();
    p.dispose();
  });

  it('excepciones de MediaPipe en detect ⇒ null + lastError tipado + onError (sin lanzar)', async () => {
    mp.createFromOptions.mockResolvedValue(fakeLandmarker({ throwOnDetect: true }));
    const onError = vi.fn();
    const p = createMediaPipePoseProvider({ ...baseOpts, delegate: 'CPU', onError });
    await p.init();
    expect(p.detect({}, 10)).toBeNull();
    expect(p.lastError).toBeInstanceOf(PoseProviderError);
    expect(p.lastError!.code).toBe('detect-failed');
    expect(onError).toHaveBeenCalledTimes(1);
    // un callback de usuario que lanza no rompe
    const q = createMediaPipePoseProvider({
      ...baseOpts,
      delegate: 'CPU',
      onError: () => {
        throw new Error('boom');
      },
    });
    mp.createFromOptions.mockResolvedValue(fakeLandmarker({ throwOnDetect: true }));
    await q.init();
    expect(q.detect({}, 1)).toBeNull();
    p.dispose();
    q.dispose();
  });

  it('GPU falla en detect ⇒ reinicia en CPU en segundo plano y vuelve a detectar', async () => {
    const gpu = fakeLandmarker({ throwOnDetect: true });
    const cpu = fakeLandmarker();
    mp.createFromOptions.mockResolvedValueOnce(gpu).mockResolvedValueOnce(cpu);
    const onDelegateFallback = vi.fn();
    const p = createMediaPipePoseProvider({ ...baseOpts, onDelegateFallback });
    await p.init();
    expect(p.delegate).toBe('GPU');
    expect(p.detect({}, 1)).toBeNull();
    // mientras se reinicia devuelve null sin lanzar
    expect(p.detect({}, 2)).toBeNull();
    await vi.waitFor(() => expect(p.delegate).toBe('CPU'));
    expect(gpu.close).toHaveBeenCalled();
    expect(onDelegateFallback).toHaveBeenCalledTimes(1);
    expect(p.detect({}, 3)).not.toBeNull();
    p.dispose();
  });

  it('modo IMAGE usa detect()', async () => {
    const fl = fakeLandmarker();
    mp.createFromOptions.mockResolvedValue(fl);
    const p = createMediaPipePoseProvider({ ...baseOpts, delegate: 'CPU', runningMode: 'IMAGE' });
    await p.init();
    expect(p.detect({ naturalWidth: 10, naturalHeight: 5 }, 5)!.imageSize).toEqual({ width: 10, height: 5 });
    expect(fl.detect).toHaveBeenCalledTimes(1);
    expect(fl.detectForVideo).not.toHaveBeenCalled();
    p.dispose();
  });

  it('guardia de privacidad: bloquea fetch a otros orígenes mientras vive y se restaura al liberar', async () => {
    mp.createFromOptions.mockResolvedValue(fakeLandmarker());
    const inner = vi.fn(okFetch);
    vi.stubGlobal('fetch', inner);
    const before = globalThis.fetch;
    const p = createMediaPipePoseProvider({ ...baseOpts, delegate: 'CPU' });
    await p.init();
    expect(globalThis.fetch).not.toBe(before);
    await expect(fetch('https://odml.pa.googleapis.com/v1/log', { method: 'POST' })).rejects.toThrow(/bloqueada/);
    await expect(fetch(new URL('https://example.com/x'))).rejects.toThrow();
    await expect(fetch(new Request('https://example.com/y'))).rejects.toThrow();
    await expect(fetch('/models/other.task')).resolves.toBeInstanceOf(Response);
    await expect(fetch('data:text/plain,hola')).resolves.toBeDefined();
    expect(p.blockedRequests).toEqual([
      'https://odml.pa.googleapis.com/v1/log',
      'https://example.com/x',
      'https://example.com/y',
    ]);
    p.dispose();
    expect(globalThis.fetch).toBe(before);
    // sin guardia: opt-out explícito
    const q = createMediaPipePoseProvider({ ...baseOpts, delegate: 'CPU', blockExternalRequests: false });
    await q.init();
    expect(globalThis.fetch).toBe(before);
    q.dispose();
  });
});
