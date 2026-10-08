import type { CameraController, CameraStatus } from '../contracts';
import {
  CAMERA_MESSAGES,
  PREFERRED_VIDEO_CONSTRAINTS,
  RELAXED_VIDEO_CONSTRAINTS,
  classifyCameraError,
  errorNameOf,
  type ClassifiedCameraError,
} from './cameraErrors';

/** Subconjunto de `navigator.mediaDevices` que usamos (facilita simularlo en pruebas). */
export interface MediaDevicesLike {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices?(): Promise<readonly Pick<MediaDeviceInfo, 'kind'>[]>;
  addEventListener?(type: 'devicechange', listener: () => void): void;
  removeEventListener?(type: 'devicechange', listener: () => void): void;
}

/** Entorno inyectable: en producción es el navegador; en tests, dobles. */
export interface CameraEnv {
  getMediaDevices(): MediaDevicesLike | undefined;
  isSecureContext(): boolean;
  createVideo(): HTMLVideoElement;
  readonly doc: Pick<Document, 'addEventListener' | 'removeEventListener'> & {
    readonly hidden: boolean;
  };
  readonly win: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** Tiempo máximo (ms) esperando a que el vídeo tenga dimensiones tras `play()`. */
  readonly metadataTimeoutMs: number;
}

export function browserCameraEnv(): CameraEnv {
  return {
    getMediaDevices: () =>
      typeof navigator !== 'undefined' ? (navigator.mediaDevices ?? undefined) : undefined,
    isSecureContext: () => typeof window !== 'undefined' && window.isSecureContext === true,
    createVideo: () => document.createElement('video'),
    doc: document,
    win: window,
    metadataTimeoutMs: 8000,
  };
}

interface CameraState {
  readonly status: CameraStatus;
  readonly video: HTMLVideoElement | null;
  readonly errorMessage?: string;
  readonly errorName?: string;
}

/** Extensión aditiva del contrato: `errorName` conserva `error.name` para depuración. */
export interface CameraSnapshot extends CameraController {
  readonly errorName?: string;
}

/**
 * Gestor de la cámara independiente de React (testeable en Node/jsdom).
 *
 * Garantías:
 *  - `start()` es idempotente (llamadas concurrentes comparten la misma promesa) y NUNCA rechaza:
 *    el resultado se lee en `status`.
 *  - `stop()` detiene TODAS las pistas, libera el `<video>` y funciona también durante `requesting`
 *    (la pista que llegue tarde se detiene al instante).
 *  - Sin grabación, sin `MediaRecorder`, sin red: el flujo sólo alimenta el `<video>` local.
 */
export class CameraManager {
  private state: CameraState = { status: 'idle', video: null };
  private snap: CameraSnapshot;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private pending: Promise<void> | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private attached = false;

  constructor(private readonly env: CameraEnv = browserCameraEnv()) {
    this.snap = this.buildSnapshot();
  }

  // ---- API estable para useSyncExternalStore ----

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): CameraSnapshot => this.snap;

  // ---- Ciclo de vida ----

  /** Instala los escuchas globales (visibilidad, pagehide, devicechange). Idempotente. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.env.doc.addEventListener('visibilitychange', this.onVisibility);
    this.env.win.addEventListener('pagehide', this.onPageHide);
    this.env.getMediaDevices()?.addEventListener?.('devicechange', this.onDeviceChange);
  }

  /** Detiene la cámara y quita todos los escuchas (desmontaje del componente). */
  detach(): void {
    this.release('idle');
    if (!this.attached) return;
    this.attached = false;
    this.env.doc.removeEventListener('visibilitychange', this.onVisibility);
    this.env.win.removeEventListener('pagehide', this.onPageHide);
    this.env.getMediaDevices()?.removeEventListener?.('devicechange', this.onDeviceChange);
  }

  /** Debe llamarse desde un gesto del usuario. Idempotente y sin rechazos. */
  readonly start = (): Promise<void> => {
    if (this.state.status === 'ready') return Promise.resolve();
    if (this.pending) return this.pending;
    this.attach();
    const gen = ++this.generation;
    this.setState({ status: 'requesting', video: null });
    const run = this.open(gen).finally(() => {
      if (this.pending === run) this.pending = null;
    });
    this.pending = run;
    return run;
  };

  readonly stop = (): void => {
    this.release('idle');
  };

  // ---- Implementación ----

  private async open(gen: number): Promise<void> {
    const env = this.env;
    if (!env.isSecureContext()) {
      this.fail(gen, {
        status: 'insecure-context',
        message: CAMERA_MESSAGES.insecure,
        errorName: 'InsecureContext',
        retryRelaxed: false,
      });
      return;
    }
    const md = env.getMediaDevices();
    if (!md || typeof md.getUserMedia !== 'function') {
      this.fail(gen, {
        status: 'unavailable',
        message: CAMERA_MESSAGES.noMediaDevices,
        errorName: 'NoMediaDevices',
        retryRelaxed: false,
      });
      return;
    }

    let stream: MediaStream;
    try {
      stream = await this.requestStream(md, gen);
    } catch (err) {
      this.fail(gen, classifyCameraError(err));
      return;
    }

    if (gen !== this.generation) {
      // stop() (o un nuevo start) ocurrió mientras esperábamos el permiso: liberar la pista tardía.
      stopStream(stream);
      return;
    }

    this.stream = stream;
    try {
      const video = await this.bindVideo(stream, gen);
      if (gen !== this.generation) return; // stop() durante play(): release() ya limpió
      this.setState({ status: 'ready', video });
    } catch (err) {
      if (gen !== this.generation) return;
      const name = errorNameOf(err);
      this.releaseResources();
      const classified: ClassifiedCameraError =
        name === 'MetadataTimeout'
          ? {
              status: 'error',
              message: CAMERA_MESSAGES.timeout,
              errorName: name,
              retryRelaxed: false,
            }
          : name === 'NotAllowedError' || name === 'AbortError' || name === 'NotSupportedError'
            ? {
                status: 'error',
                message: CAMERA_MESSAGES.playFailed,
                errorName: name,
                retryRelaxed: false,
              }
            : classifyCameraError(err);
      this.setState({
        status: classified.status,
        video: null,
        errorMessage: classified.message,
        errorName: classified.errorName,
      });
    }
  }

  /** getUserMedia con constraints preferidas y UN reintento relajado si falló por no-encontrado/overconstrained. */
  private async requestStream(md: MediaDevicesLike, gen: number): Promise<MediaStream> {
    try {
      return await md.getUserMedia(PREFERRED_VIDEO_CONSTRAINTS);
    } catch (err) {
      const c = classifyCameraError(err);
      if (!c.retryRelaxed || gen !== this.generation) throw err;
      return await md.getUserMedia(RELAXED_VIDEO_CONSTRAINTS);
    }
  }

  private async bindVideo(stream: MediaStream, gen: number): Promise<HTMLVideoElement> {
    const video = this.env.createVideo();
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.srcObject = stream;
    this.video = video;

    for (const track of stream.getVideoTracks()) {
      track.onended = () => this.onTrackEnded(gen);
    }

    await video.play();
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      await this.waitForDimensions(video);
    }
    return video;
  }

  private waitForDimensions(video: HTMLVideoElement): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const done = (err?: Error) => {
        clearTimeout(timer);
        video.removeEventListener('loadedmetadata', check);
        video.removeEventListener('resize', check);
        if (err) reject(err);
        else resolve();
      };
      const check = () => {
        if (video.videoWidth > 0 && video.videoHeight > 0) done();
      };
      const timer = setTimeout(() => {
        const e = new Error('El vídeo no obtuvo dimensiones a tiempo');
        e.name = 'MetadataTimeout';
        done(e);
      }, this.env.metadataTimeoutMs);
      video.addEventListener('loadedmetadata', check);
      video.addEventListener('resize', check);
      check();
    });
  }

  private onTrackEnded(gen: number): void {
    if (gen !== this.generation) return;
    this.release('error', CAMERA_MESSAGES.disconnected, 'TrackEnded');
    void this.refreshAvailability();
  }

  private readonly onVisibility = (): void => {
    const stream = this.stream;
    const video = this.video;
    if (!stream || !video) return;
    const hidden = this.env.doc.hidden;
    for (const t of stream.getVideoTracks()) t.enabled = !hidden;
    if (hidden) {
      video.pause();
    } else {
      video.play().catch(() => {
        /* el navegador puede rechazar play() si la pestaña vuelve a ocultarse; el siguiente evento reintenta */
      });
    }
  };

  private readonly onPageHide = (): void => {
    this.release('idle');
  };

  private readonly onDeviceChange = (): void => {
    void this.refreshAvailability();
  };

  /** Mira si hay cámaras: 'unavailable' → 'idle' si aparece una; 'ready' → 'unavailable' si desaparecen todas. */
  private async refreshAvailability(): Promise<void> {
    const md = this.env.getMediaDevices();
    if (!md?.enumerateDevices) return;
    let hasCamera: boolean;
    try {
      const devices = await md.enumerateDevices();
      hasCamera = devices.some((d) => d.kind === 'videoinput');
    } catch {
      return;
    }
    const status = this.state.status;
    if (status === 'unavailable' && hasCamera && !this.pending) {
      this.setState({ status: 'idle', video: null });
    } else if ((status === 'ready' || status === 'error') && !hasCamera) {
      this.release('unavailable', CAMERA_MESSAGES.unavailable, 'NotFoundError');
    }
  }

  private fail(gen: number, c: ClassifiedCameraError): void {
    if (gen !== this.generation) return; // la petición ya fue cancelada por stop()
    this.releaseResources();
    this.setState({
      status: c.status,
      video: null,
      errorMessage: c.message,
      errorName: c.errorName,
    });
  }

  /** Detiene pistas y libera el <video>, invalida cualquier start() en vuelo y fija el estado final. */
  private release(
    status: Exclude<CameraStatus, 'requesting' | 'ready'>,
    message?: string,
    errorName?: string,
  ): void {
    this.generation++;
    this.pending = null;
    this.releaseResources();
    const next: CameraState =
      message !== undefined
        ? { status, video: null, errorMessage: message, errorName }
        : { status, video: null };
    if (
      next.status !== this.state.status ||
      next.video !== this.state.video ||
      next.errorMessage !== this.state.errorMessage
    ) {
      this.setState(next);
    }
  }

  private releaseResources(): void {
    const stream = this.stream;
    const video = this.video;
    this.stream = null;
    this.video = null;
    if (stream) {
      for (const t of stream.getTracks()) t.onended = null;
      stopStream(stream);
    }
    if (video) {
      try {
        video.pause();
      } catch {
        /* elemento ya liberado */
      }
      video.srcObject = null;
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        /* jsdom no implementa load() */
      }
    }
  }

  private setState(next: CameraState): void {
    this.state = next;
    this.snap = this.buildSnapshot();
    for (const l of [...this.listeners]) l();
  }

  private buildSnapshot(): CameraSnapshot {
    const s = this.state;
    return {
      status: s.status,
      video: s.status === 'ready' ? s.video : null,
      errorMessage: s.errorMessage,
      errorName: s.errorName,
      start: this.start,
      stop: this.stop,
    };
  }
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* pista ya detenida */
    }
  }
}
