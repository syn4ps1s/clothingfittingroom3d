import type { CameraIntrinsics } from '@fitroom/shared';

/** FOV vertical típico de una webcam frontal (grados). Ajustable/calibrable por el usuario. */
export const DEFAULT_VERTICAL_FOV_DEG = 55;
export const MIN_FOV_DEG = 30;
export const MAX_FOV_DEG = 100;
const STORAGE_KEY = 'fitroom.mirror.verticalFovDeg';

let current: number | null = null;

export function clampFov(deg: number): number {
  if (!Number.isFinite(deg)) return DEFAULT_VERTICAL_FOV_DEG;
  return Math.min(MAX_FOV_DEG, Math.max(MIN_FOV_DEG, deg));
}

/** FOV vertical asumido (calibrado si el usuario lo ajustó; si no, el típico). */
export function getVerticalFov(): number {
  if (current !== null) return current;
  let v = DEFAULT_VERTICAL_FOV_DEG;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) v = clampFov(Number(raw));
  } catch {
    /* almacenamiento no disponible: se usa el valor por defecto */
  }
  current = v;
  return v;
}

/** Fija (y recuerda en este navegador) el FOV vertical asumido de la cámara. */
export function setVerticalFov(deg: number): number {
  const v = clampFov(deg);
  current = v;
  try {
    localStorage.setItem(STORAGE_KEY, String(v));
  } catch {
    /* almacenamiento no disponible: sólo vale para esta sesión */
  }
  return v;
}

export function intrinsicsFor(source: object | null, fovDeg: number = getVerticalFov()): CameraIntrinsics {
  const s = source as {
    videoWidth?: number;
    videoHeight?: number;
    width?: number;
    height?: number;
  } | null;
  const w = s?.videoWidth ?? s?.width ?? 0;
  const h = s?.videoHeight ?? s?.height ?? 0;
  const aspect = w > 0 && h > 0 ? w / h : 16 / 9;
  return { verticalFovDeg: clampFov(fovDeg), aspect };
}

/** Sólo para tests. */
export function resetFovForTests(): void {
  current = null;
}
