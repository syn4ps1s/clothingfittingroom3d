import type { CameraStatus } from '../contracts';

/** Resultado de clasificar un error de `getUserMedia` (o de la reproducción del vídeo). */
export interface ClassifiedCameraError {
  readonly status: Exclude<CameraStatus, 'idle' | 'requesting' | 'ready'>;
  readonly message: string;
  /** `error.name` original, útil para depurar sin exponer detalles al usuario. */
  readonly errorName: string;
  /** Si tiene sentido reintentar una vez con constraints relajadas (sin resolución/fps ideales). */
  readonly retryRelaxed: boolean;
}

/** Mensajes en español (idioma por defecto del producto); la UI puede mostrar los suyos según `status`. */
export const CAMERA_MESSAGES = {
  denied:
    'Has bloqueado el acceso a la cámara. Permítelo en los ajustes del navegador (icono del candado) y vuelve a intentarlo.',
  unavailable: 'No se ha encontrado ninguna cámara en este dispositivo.',
  insecure:
    'La cámara sólo está disponible en conexiones seguras (https) o en localhost. Abre la aplicación desde una dirección segura.',
  noMediaDevices: 'Este navegador no permite acceder a la cámara.',
  notReadable:
    'No se puede usar la cámara: otra aplicación o pestaña la está usando, o el sistema la ha bloqueado. Ciérrala e inténtalo de nuevo.',
  aborted: 'El acceso a la cámara se interrumpió. Inténtalo de nuevo.',
  disconnected: 'La cámara se ha desconectado o ha dejado de enviar imagen.',
  playFailed: 'La cámara se abrió pero el vídeo no pudo reproducirse.',
  timeout: 'La cámara tarda demasiado en responder. Revisa que no esté en uso por otra aplicación.',
  generic: 'No se pudo iniciar la cámara por un error inesperado.',
} as const;

/** Extrae `name` de cualquier valor lanzado (DOMException, Error, objeto suelto, string). */
export function errorNameOf(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err) {
    const n = (err as { name?: unknown }).name;
    if (typeof n === 'string' && n.length > 0) return n;
  }
  return 'UnknownError';
}

/**
 * Clasifica un error de `getUserMedia` por `error.name` (no por el texto, que varía entre navegadores).
 *  - NotAllowedError / PermissionDeniedError → denied
 *  - SecurityError → insecure-context (política de permisos / origen no seguro)
 *  - NotFoundError / DevicesNotFoundError → unavailable
 *  - OverconstrainedError → unavailable, pero reintentable con constraints relajadas
 *  - NotReadableError / TrackStartError / AbortError → error (cámara ocupada o interrumpida)
 *  - cualquier otro → error genérico
 */
export function classifyCameraError(err: unknown): ClassifiedCameraError {
  const errorName = errorNameOf(err);
  switch (errorName) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return { status: 'denied', message: CAMERA_MESSAGES.denied, errorName, retryRelaxed: false };
    case 'SecurityError':
      return {
        status: 'insecure-context',
        message: CAMERA_MESSAGES.insecure,
        errorName,
        retryRelaxed: false,
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return {
        status: 'unavailable',
        message: CAMERA_MESSAGES.unavailable,
        errorName,
        retryRelaxed: true,
      };
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return {
        status: 'unavailable',
        message: CAMERA_MESSAGES.unavailable,
        errorName,
        retryRelaxed: true,
      };
    case 'NotReadableError':
    case 'TrackStartError':
      return {
        status: 'error',
        message: CAMERA_MESSAGES.notReadable,
        errorName,
        retryRelaxed: false,
      };
    case 'AbortError':
      return { status: 'error', message: CAMERA_MESSAGES.aborted, errorName, retryRelaxed: false };
    default:
      return { status: 'error', message: CAMERA_MESSAGES.generic, errorName, retryRelaxed: false };
  }
}

/** Constraints preferidas: cámara frontal, 1280×720 @ 30 fps (ideales, el navegador negocia lo más cercano). */
export const PREFERRED_VIDEO_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: 'user',
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
  },
  audio: false,
};

/** Constraints relajadas para el reintento: cualquier cámara de vídeo, sin audio. */
export const RELAXED_VIDEO_CONSTRAINTS: MediaStreamConstraints = { video: true, audio: false };
