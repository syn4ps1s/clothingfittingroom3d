import { clamp, degToRad, type CameraIntrinsics, type Vec3 } from '@fitroom/shared';

/**
 * Cámara pinhole del proyecto: en el origen, mirando a −Z, +Y arriba, +X a la derecha de la imagen
 * SIN espejar. Coordenadas de imagen normalizadas (0..1, origen arriba-izquierda), como MediaPipe.
 */

export interface CameraScales {
  /** tan(FOV vertical / 2) */
  readonly tanY: number;
  /** tan(FOV horizontal / 2) = tanY · aspect */
  readonly tanX: number;
}

/** Valores por defecto razonables si los intrínsecos son inválidos (webcam típica). */
export const DEFAULT_CAMERA: CameraIntrinsics = { verticalFovDeg: 55, aspect: 4 / 3 };

/** Sanea los intrínsecos: FOV en [10°, 150°], aspecto en [0.3, 4]. */
export function sanitizeCamera(camera: CameraIntrinsics): CameraIntrinsics {
  const fov = Number.isFinite(camera.verticalFovDeg)
    ? clamp(camera.verticalFovDeg, 10, 150)
    : DEFAULT_CAMERA.verticalFovDeg;
  const aspect = Number.isFinite(camera.aspect)
    ? clamp(camera.aspect, 0.3, 4)
    : DEFAULT_CAMERA.aspect;
  return { verticalFovDeg: fov, aspect };
}

export function cameraScales(camera: CameraIntrinsics): CameraScales {
  const c = sanitizeCamera(camera);
  const tanY = Math.tan(degToRad(c.verticalFovDeg) / 2);
  return { tanY, tanX: tanY * c.aspect };
}

/**
 * Rayo (ex, ey) de un punto de imagen normalizado: un punto a profundidad Z (distancia al plano
 * de la cámara, >0) está en (Z·ex, Z·ey, −Z).
 */
export function rayFromNormalized(
  xn: number,
  yn: number,
  s: CameraScales,
): readonly [number, number] {
  return [(2 * xn - 1) * s.tanX, -(2 * yn - 1) * s.tanY];
}

export interface ProjectedPoint {
  /** 0..1 (puede salir de rango si el punto está fuera de cuadro) */
  readonly x: number;
  readonly y: number;
  /** distancia al plano de la cámara (m) */
  readonly depth: number;
}

/** Proyecta un punto en espacio cámara a coordenadas normalizadas. */
export function projectToNormalized(p: Vec3, s: CameraScales, minDepth = 0.05): ProjectedPoint {
  const depth = Math.max(-p[2], minDepth);
  return {
    x: 0.5 + p[0] / depth / (2 * s.tanX),
    y: 0.5 - p[1] / depth / (2 * s.tanY),
    depth,
  };
}

/** Estatura aparente (fracción del alto de imagen) de un objeto vertical de `heightM` a `distanceM`. */
export const apparentHeightFraction = (heightM: number, distanceM: number, s: CameraScales) =>
  heightM / (distanceM * 2 * s.tanY);
