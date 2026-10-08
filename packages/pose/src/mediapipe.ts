import type {
  PoseLandmarker,
  PoseLandmarkerOptions,
  PoseLandmarkerResult,
} from '@mediapipe/tasks-vision';
import {
  POSE_LANDMARK_COUNT,
  clamp,
  type ImageLandmark,
  type PoseFrame,
  type PoseProvider,
  type PoseSource,
  type SegmentationMask,
  type WorldLandmark,
} from '@fitroom/shared';

/**
 * Adaptador de MediaPipe Pose Landmarker (`@mediapipe/tasks-vision` 1.1.0) al puerto `PoseProvider`.
 *
 * Todo el procesamiento es on-device: el modelo (`.task`) y los WASM se piden SIEMPRE a las URLs de
 * `MediaPipeOptions` (mismo origen); ningún fotograma ni landmark sale del navegador.
 *
 * Diferencias con la API 0.10 que se verificaron contra `vision.d.ts` real de la 1.1.0:
 *  - `PoseLandmarkerResult` es una clase con `close()`; `landmarks`/`worldLandmarks` son
 *    `NormalizedLandmark[][]`/`Landmark[][]` (una lista por persona) con `visibility` y `presence?`.
 *  - Con callback, las máscaras sólo son válidas dentro del callback (se copian aquí).
 *  - Las máscaras de pose son de CONFIANZA (`Float32Array` 0..1), no de categoría.
 *  - `FilesetResolver.forVisionTasks(base)` elige solo la variante SIMD/no-SIMD del WASM.
 */

export interface MediaPipeOptions {
  /** URL del .task (p. ej. /models/pose_landmarker_lite.task) — mismo origen */
  readonly modelUrl: string;
  /** URL base de los WASM (p. ej. /wasm) — mismo origen */
  readonly wasmBaseUrl: string;
  readonly runningMode?: 'VIDEO' | 'IMAGE';
  readonly outputSegmentationMask?: boolean;
  /** `auto` (por defecto): GPU con caída automática a CPU. */
  readonly delegate?: 'auto' | 'GPU' | 'CPU';
  /** Personas a detectar (≥ 2 permite informar `personCount`). Por defecto 2. */
  readonly numPoses?: number;
  readonly minPoseDetectionConfidence?: number;
  readonly minPosePresenceConfidence?: number;
  readonly minTrackingConfidence?: number;
  /** Lado mayor máximo (px) de la máscara devuelta; se submuestrea si es más grande. Por defecto 256. */
  readonly maskMaxSide?: number;
  /** Se llama (una vez) si el delegado GPU falla y se continúa en CPU. */
  readonly onDelegateFallback?: (reason: unknown) => void;
  /** Se llama con cada error no fatal de `detect` (se devuelve `null` al llamante). */
  readonly onError?: (e: PoseProviderError) => void;
  /**
   * Bloquea (por defecto) cualquier `fetch` a otro origen mientras el proveedor está vivo.
   * `@mediapipe/tasks-vision` 1.1.0 envía telemetría de uso a `https://odml.pa.googleapis.com/v1/log`
   * (cada 60 s y al cerrar); esto la impide en origen — además de la CSP `connect-src 'self'`.
   */
  readonly blockExternalRequests?: boolean;
}

export type PoseProviderErrorCode =
  | 'invalid-options'
  | 'model-load-failed'
  | 'wasm-unsupported'
  | 'init-failed'
  | 'not-initialized'
  | 'detect-failed';

/** Error tipado del proveedor (nunca se propaga una excepción cruda de MediaPipe). */
export class PoseProviderError extends Error {
  readonly code: PoseProviderErrorCode;
  constructor(code: PoseProviderErrorCode, message: string, cause?: unknown) {
    super(`${code}: ${message}`, cause === undefined ? undefined : { cause });
    this.name = 'PoseProviderError';
    this.code = code;
  }
}

export interface MediaPipePoseProvider extends PoseProvider {
  /** Delegado en uso (`null` hasta que `init()` termina). */
  readonly delegate: 'GPU' | 'CPU' | null;
  /** Último error no fatal de `detect`. */
  readonly lastError: PoseProviderError | null;
  /** URLs externas cuya petición se bloqueó (p. ej. la telemetría de MediaPipe). */
  readonly blockedRequests: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// Conversión pura de resultados (testable en Node con resultados falsos)
// ---------------------------------------------------------------------------------------------

export interface RawLandmark {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly visibility?: number;
  readonly presence?: number;
}
export interface RawMask {
  readonly width: number;
  readonly height: number;
  getAsFloat32Array(): Float32Array;
  /** (opcional) lectura alternativa 0..255 si la de coma flotante vuelve vacía (GPU sin float) */
  getAsUint8Array?(): Uint8Array;
}
export interface RawPoseResult {
  readonly landmarks: readonly (readonly RawLandmark[])[];
  readonly worldLandmarks: readonly (readonly RawLandmark[])[];
  readonly segmentationMasks?: readonly RawMask[] | undefined;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

function landmarkVisibility(l: RawLandmark): number {
  const v = finite(l.visibility) ? clamp(l.visibility, 0, 1) : 0;
  return finite(l.presence) ? Math.min(v, clamp(l.presence, 0, 1)) : v;
}

/** Puntuación de «persona principal»: área del recuadro visible × centrado × visibilidad media. */
export function primaryPersonScore(lms: readonly RawLandmark[]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let visSum = 0;
  let n = 0;
  for (const l of lms) {
    if (!finite(l.x) || !finite(l.y)) continue;
    const v = landmarkVisibility(l);
    visSum += v;
    n++;
    if (v < 0.3) continue;
    minX = Math.min(minX, l.x);
    maxX = Math.max(maxX, l.x);
    minY = Math.min(minY, l.y);
    maxY = Math.max(maxY, l.y);
  }
  if (n === 0 || !(maxX >= minX)) return 0;
  const w = clamp(maxX, 0, 1) - clamp(minX, 0, 1);
  const h = clamp(maxY, 0, 1) - clamp(minY, 0, 1);
  const area = Math.max(w, 0) * Math.max(h, 0);
  const cx = (minX + maxX) / 2;
  const centered = 1 - Math.min(1, Math.abs(cx - 0.5) * 1.5);
  return area * (0.5 + 0.5 * centered) * (0.5 + 0.5 * (visSum / n));
}

export interface ConvertOptions {
  readonly maskMaxSide?: number;
}

/**
 * Convierte el resultado de MediaPipe en un `PoseFrame` del proyecto:
 *  - imagen sin espejar, tal cual (x,y normalizados; z relativa);
 *  - world: `X = x, Y = −y, Z = −z` (MediaPipe: y hacia abajo, z menor = más cerca de la cámara);
 *  - coordenadas no finitas ⇒ 0 con visibilidad 0 (el contrato nunca recibe NaN/Inf);
 *  - persona principal = mayor área visible / más centrada; `personCount` = personas detectadas.
 * Devuelve `null` si no hay ninguna persona con 33 landmarks.
 */
export function convertPoseResult(
  raw: RawPoseResult,
  imageSize: { readonly width: number; readonly height: number },
  timestampMs: number,
  opts: ConvertOptions = {},
): PoseFrame | null {
  const people: number[] = [];
  for (let k = 0; k < raw.landmarks.length; k++) {
    const lm = raw.landmarks[k];
    const wl = raw.worldLandmarks[k];
    if (lm && wl && lm.length >= POSE_LANDMARK_COUNT && wl.length >= POSE_LANDMARK_COUNT) {
      people.push(k);
    }
  }
  if (people.length === 0) return null;
  let best = people[0]!;
  if (people.length > 1) {
    let bestScore = -1;
    for (const k of people) {
      const s = primaryPersonScore(raw.landmarks[k]!);
      if (s > bestScore) {
        bestScore = s;
        best = k;
      }
    }
  }
  const lms = raw.landmarks[best]!;
  const wls = raw.worldLandmarks[best]!;
  const image: ImageLandmark[] = [];
  const world: WorldLandmark[] = [];
  for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
    const l = lms[i]!;
    const w = wls[i]!;
    const vis = finite(l.visibility) ? landmarkVisibility(l) : landmarkVisibility(w);
    const imgOk = finite(l.x) && finite(l.y) && finite(l.z);
    const wldOk = finite(w.x) && finite(w.y) && finite(w.z);
    image.push(
      imgOk
        ? { x: l.x, y: l.y, z: l.z, visibility: vis }
        : { x: 0, y: 0, z: 0, visibility: 0 },
    );
    world.push(
      wldOk
        ? { x: w.x, y: -w.y, z: -w.z, visibility: vis }
        : { x: 0, y: 0, z: 0, visibility: 0 },
    );
  }
  const maskRaw = raw.segmentationMasks?.[best];
  const mask = maskRaw ? convertMask(maskRaw, opts.maskMaxSide ?? 256) : undefined;
  return {
    timestampMs,
    imageSize,
    image,
    world,
    ...(mask ? { mask } : {}),
    personCount: people.length,
  };
}

/**
 * Máscara de confianza (Float32 0..1) → Uint8 0..255, submuestreada a `maxSide` como mucho.
 * Si la máscara llega vacía (todo 0) se prueba la lectura Uint8; si sigue vacía se devuelve `undefined`
 * (en SwiftShader/GL sin texturas float la lectura de máscaras GPU devuelve ceros): una máscara vacía
 * NO es «silueta de 0 píxeles», es «sin máscara», y el estimador usará los a priori.
 */
export function convertMask(raw: RawMask, maxSide: number): SegmentationMask | undefined {
  const w = raw.width;
  const h = raw.height;
  if (!(w > 0) || !(h > 0) || !Number.isInteger(w) || !Number.isInteger(h)) return undefined;
  let src: ArrayLike<number> = raw.getAsFloat32Array();
  let scale = 255;
  if (src.length < w * h) return undefined;
  if (!hasSignal(src, w * h) && typeof raw.getAsUint8Array === 'function') {
    const u8 = raw.getAsUint8Array();
    if (u8.length >= w * h && hasSignal(u8, w * h)) {
      src = u8;
      scale = 1;
    }
  }
  if (!hasSignal(src, w * h)) return undefined;
  const step = Math.max(1, Math.ceil(Math.max(w, h) / Math.max(8, maxSide)));
  const ow = Math.floor(w / step);
  const oh = Math.floor(h / step);
  const data = new Uint8Array(ow * oh);
  for (let y = 0; y < oh; y++) {
    const row = y * step * w;
    for (let x = 0; x < ow; x++) {
      const v = src[row + x * step]!;
      data[y * ow + x] = finite(v) ? Math.round(clamp(v * (scale === 255 ? 1 : 1 / 255), 0, 1) * 255) : 0;
    }
  }
  return { width: ow, height: oh, data };
}

function hasSignal(a: ArrayLike<number>, n: number): boolean {
  for (let i = 0; i < n; i += 7) if (a[i]! > 0) return true;
  return false;
}

/** Tamaño en píxeles de una fuente de imagen/vídeo del navegador (duck-typing, sin tocar el DOM). */
export function sourceSize(source: object): { width: number; height: number } {
  const s = source as Record<string, unknown>;
  const pick = (a: string, b: string): { width: number; height: number } | null => {
    const w = s[a];
    const h = s[b];
    return finite(w) && finite(h) && w > 0 && h > 0 ? { width: w, height: h } : null;
  };
  return (
    pick('videoWidth', 'videoHeight') ??
    pick('naturalWidth', 'naturalHeight') ??
    pick('displayWidth', 'displayHeight') ??
    pick('width', 'height') ?? { width: 1, height: 1 }
  );
}

// ---------------------------------------------------------------------------------------------
// Guardia de privacidad: sin peticiones a otros orígenes
// ---------------------------------------------------------------------------------------------

interface FetchGuard {
  refs: number;
  readonly original: typeof fetch;
  readonly blocked: string[];
  readonly wrapper: typeof fetch;
}
let fetchGuard: FetchGuard | null = null;

function requestUrl(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
  const u = (input as { url?: unknown } | null)?.url;
  return typeof u === 'string' ? u : null;
}

function isExternalUrl(raw: string): boolean {
  if (typeof location === 'undefined') return false;
  try {
    const u = new URL(raw, location.href);
    if (u.protocol === 'data:' || u.protocol === 'blob:') return false;
    return u.origin !== location.origin;
  } catch {
    return false;
  }
}

/** Instala (con cuenta de referencias) un `fetch` que rechaza peticiones a otros orígenes. */
function installFetchGuard(): { release: () => void; blocked: readonly string[] } {
  if (typeof globalThis.fetch !== 'function') return { release: () => undefined, blocked: [] };
  // si alguien sustituyó `fetch` después de instalar la guardia, se vuelve a envolver el actual
  if (!fetchGuard || globalThis.fetch !== fetchGuard.wrapper) {
    const original = globalThis.fetch;
    const blocked: string[] = [];
    const wrapper = function (this: unknown, input: Parameters<typeof fetch>[0], init?: RequestInit) {
      const url = requestUrl(input);
      if (guard.refs > 0 && url !== null && isExternalUrl(url)) {
        blocked.push(url);
        return Promise.reject(
          new TypeError(`petición externa bloqueada por @fitroom/pose (privacidad): ${url}`),
        );
      }
      return original.call(globalThis, input, init);
    } as typeof fetch;
    const guard: FetchGuard = { refs: 0, original, blocked, wrapper };
    fetchGuard = guard;
    globalThis.fetch = wrapper;
  }
  const g = fetchGuard;
  g.refs++;
  let released = false;
  return {
    blocked: g.blocked,
    release: () => {
      if (released) return;
      released = true;
      g.refs--;
      if (g.refs <= 0) {
        if (globalThis.fetch === g.wrapper) globalThis.fetch = g.original;
        if (fetchGuard === g) fetchGuard = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Proveedor
// ---------------------------------------------------------------------------------------------

type Delegate = 'GPU' | 'CPU';

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** ¿El texto del error apunta a que WebAssembly/SIMD no están disponibles o no se pueden compilar? */
const looksLikeWasmProblem = (e: unknown): boolean =>
  /wasm|webassembly|simd|compile|instantiate|CompileError|LinkError/i.test(
    `${e instanceof Error ? e.name : ''} ${errMsg(e)}`,
  );

export function createMediaPipePoseProvider(opts: MediaPipeOptions): MediaPipePoseProvider {
  const runningMode = opts.runningMode ?? 'VIDEO';
  const numPoses = Math.max(1, Math.floor(opts.numPoses ?? 2));
  const delegatePref = opts.delegate ?? 'auto';
  const maskMaxSide = opts.maskMaxSide ?? 256;

  let landmarker: PoseLandmarker | null = null;
  let activeDelegate: Delegate | null = null;
  let initPromise: Promise<void> | null = null;
  let disposed = false;
  let lastTs = -1;
  let lastError: PoseProviderError | null = null;
  let fallbackPending = false;
  let fallbackNotified = false;
  let releaseGuard: (() => void) | null = null;
  let blockedList: readonly string[] = [];
  // modelo y WASM resueltos en init (se reutilizan al reintentar en CPU)
  let modelBuffer: Uint8Array | null = null;
  let fileset: Awaited<ReturnType<typeof import('@mediapipe/tasks-vision').FilesetResolver.forVisionTasks>> | null =
    null;
  let visionModule: typeof import('@mediapipe/tasks-vision') | null = null;

  const notifyError = (e: PoseProviderError): void => {
    lastError = e;
    try {
      opts.onError?.(e);
    } catch {
      /* un callback del usuario nunca debe romper la detección */
    }
  };

  async function create(delegate: Delegate): Promise<PoseLandmarker> {
    if (!visionModule || !fileset || !modelBuffer) {
      throw new PoseProviderError('init-failed', 'estado interno incompleto');
    }
    const options: PoseLandmarkerOptions = {
      baseOptions: { modelAssetBuffer: modelBuffer, delegate },
      runningMode,
      numPoses,
      outputSegmentationMasks: opts.outputSegmentationMask === true,
      ...(opts.minPoseDetectionConfidence !== undefined
        ? { minPoseDetectionConfidence: opts.minPoseDetectionConfidence }
        : {}),
      ...(opts.minPosePresenceConfidence !== undefined
        ? { minPosePresenceConfidence: opts.minPosePresenceConfidence }
        : {}),
      ...(opts.minTrackingConfidence !== undefined
        ? { minTrackingConfidence: opts.minTrackingConfidence }
        : {}),
    };
    return visionModule.PoseLandmarker.createFromOptions(fileset, options);
  }

  async function doInit(): Promise<void> {
    if (typeof opts.modelUrl !== 'string' || opts.modelUrl.length === 0) {
      throw new PoseProviderError('invalid-options', 'modelUrl vacío');
    }
    if (typeof opts.wasmBaseUrl !== 'string' || opts.wasmBaseUrl.length === 0) {
      throw new PoseProviderError('invalid-options', 'wasmBaseUrl vacío');
    }
    if (typeof WebAssembly === 'undefined') {
      throw new PoseProviderError('wasm-unsupported', 'WebAssembly no está disponible');
    }
    if (opts.blockExternalRequests !== false && !releaseGuard) {
      const g = installFetchGuard();
      releaseGuard = g.release;
      blockedList = g.blocked;
    }

    // 1) modelo, desde el mismo origen
    try {
      const res = await fetch(opts.modelUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status} al pedir ${opts.modelUrl}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength < 1024) throw new Error(`modelo demasiado pequeño (${buf.byteLength} B)`);
      modelBuffer = buf;
    } catch (e) {
      throw new PoseProviderError('model-load-failed', errMsg(e), e);
    }

    // 2) código de MediaPipe (carga diferida: no pesa hasta que se enciende la cámara) y WASM
    try {
      visionModule = await import('@mediapipe/tasks-vision');
      fileset = await visionModule.FilesetResolver.forVisionTasks(opts.wasmBaseUrl);
    } catch (e) {
      throw new PoseProviderError(
        looksLikeWasmProblem(e) ? 'wasm-unsupported' : 'init-failed',
        errMsg(e),
        e,
      );
    }

    // 3) landmarker: GPU con caída automática a CPU
    const attempts: Delegate[] =
      delegatePref === 'auto' ? ['GPU', 'CPU'] : [delegatePref === 'GPU' ? 'GPU' : 'CPU'];
    let firstError: unknown = null;
    for (const d of attempts) {
      try {
        landmarker = await create(d);
        activeDelegate = d;
        if (d === 'CPU' && firstError !== null && !fallbackNotified) {
          fallbackNotified = true;
          opts.onDelegateFallback?.(firstError);
        }
        break;
      } catch (e) {
        firstError ??= e;
        if (d === attempts[attempts.length - 1]) {
          throw new PoseProviderError(
            looksLikeWasmProblem(e) ? 'wasm-unsupported' : 'init-failed',
            errMsg(e),
            e,
          );
        }
      }
    }
    if (disposed) closeLandmarker();
    // el modelo ya está dentro de MediaPipe: soltar nuestra copia salvo que haga falta reintentar
    if (activeDelegate === 'CPU') modelBuffer = null;
  }

  function closeLandmarker(): void {
    const lm = landmarker;
    landmarker = null;
    if (lm) {
      try {
        lm.close();
      } catch {
        /* cerrar es idempotente y no debe lanzar */
      }
    }
  }

  /** Reintenta en CPU tras un fallo del delegado GPU en `detect` (asíncrono; mientras tanto `null`). */
  function scheduleCpuFallback(reason: unknown): void {
    if (fallbackPending || disposed || activeDelegate === 'CPU') return;
    fallbackPending = true;
    void (async () => {
      try {
        closeLandmarker();
        const lm = await create('CPU');
        if (disposed) {
          lm.close();
          return;
        }
        landmarker = lm;
        activeDelegate = 'CPU';
        lastTs = -1;
        if (!fallbackNotified) {
          fallbackNotified = true;
          opts.onDelegateFallback?.(reason);
        }
      } catch (e) {
        notifyError(new PoseProviderError('init-failed', `caída a CPU fallida: ${errMsg(e)}`, e));
      } finally {
        fallbackPending = false;
      }
    })();
  }

  function detect(source: PoseSource, timestampMs: number): PoseFrame | null {
    if (disposed) return null;
    if (!initPromise || (!landmarker && !fallbackPending)) {
      throw new PoseProviderError('not-initialized', 'llama a init() y espera a que termine');
    }
    if (!landmarker) return null; // reiniciando en CPU
    // MediaPipe lanza si los timestamps no crecen estrictamente: se fuerza monotonía
    let ts = finite(timestampMs) ? Math.floor(timestampMs) : lastTs + 1;
    if (runningMode === 'VIDEO') {
      if (ts <= lastTs) ts = lastTs + 1;
    }
    const size = sourceSize(source);
    let frame: PoseFrame | null = null;
    try {
      const cb = (r: PoseLandmarkerResult): void => {
        frame = convertPoseResult(r as unknown as RawPoseResult, size, ts, { maskMaxSide });
      };
      const img = source as Parameters<PoseLandmarker['detect']>[0];
      if (runningMode === 'VIDEO') {
        landmarker.detectForVideo(img, ts, cb);
        lastTs = ts;
      } else {
        landmarker.detect(img, cb);
      }
    } catch (e) {
      notifyError(new PoseProviderError('detect-failed', errMsg(e), e));
      if (activeDelegate === 'GPU' && delegatePref === 'auto') scheduleCpuFallback(e);
      return null;
    }
    return frame;
  }

  return {
    name: 'mediapipe',
    get delegate() {
      return activeDelegate;
    },
    get lastError() {
      return lastError;
    },
    get blockedRequests() {
      return blockedList;
    },
    init(): Promise<void> {
      if (disposed) {
        return Promise.reject(new PoseProviderError('not-initialized', 'el proveedor fue liberado'));
      }
      initPromise ??= doInit().catch((e: unknown) => {
        initPromise = null; // permite reintentar
        releaseGuard?.();
        releaseGuard = null;
        throw e instanceof PoseProviderError
          ? e
          : new PoseProviderError('init-failed', errMsg(e), e);
      });
      return initPromise;
    },
    detect,
    dispose(): void {
      disposed = true;
      closeLandmarker(); // el cierre de MediaPipe intenta enviar telemetría: la guardia sigue activa
      releaseGuard?.();
      releaseGuard = null;
      modelBuffer = null;
      fileset = null;
      visionModule = null;
    },
  };
}
