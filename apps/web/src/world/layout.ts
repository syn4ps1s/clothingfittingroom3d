/**
 * Geometría del atelier (metros, +Y arriba, +Z hacia la cámara de inicio) y poses de cámara por pantalla.
 * Todo son números planos (sin three) para poder usarlo desde el JS inicial.
 */
export type V3 = readonly [number, number, number];

export const ROOM = {
  halfWidth: 3.7,
  backZ: -3.3,
  frontZ: 7.5,
  height: 3.8,
} as const;

export const MIRROR = {
  x: 0,
  z: -2.62,
  /** Cristal (lo que cubre el MirrorStage) */
  width: 1.1,
  height: 1.95,
  /** Centro del cristal */
  centerY: 1.2,
  frame: 0.095,
} as const;

export const RACK = { x: -2.45, z: -1.35, count: 4, spacing: 0.62 } as const;
export const TABLE = { x: 2.15, z: -0.55, width: 1.9, depth: 0.95, height: 0.92 } as const;
export const WINDOW = { x: 2.4, width: 1.55, bottom: 0.55, top: 3.35 } as const;

export interface CameraPose {
  readonly position: V3;
  readonly target: V3;
  readonly fov: number;
}

export type StageKey =
  | 'welcome'
  | 'camera'
  | 'height'
  | 'scan'
  | 'manual'
  | 'book'
  | 'catalog'
  | 'fitting';

const FOV = 38;

const WIDE: Record<StageKey, CameraPose> = {
  welcome: { position: [0.2, 1.55, 3.4], target: [0.0, 1.2, -2.6], fov: FOV },
  camera: { position: [0.0, 1.5, 1.6], target: [0.0, 1.2, -2.6], fov: FOV },
  height: { position: [0.0, 1.5, 1.6], target: [0.0, 1.2, -2.6], fov: FOV },
  scan: { position: [0.0, 1.5, 1.6], target: [0.0, 1.2, -2.6], fov: FOV },
  manual: { position: [0.2, 1.5, 2.8], target: [0.1, 1.3, -2.6], fov: FOV },
  book: { position: [0.2, 1.5, 2.8], target: [0.1, 1.3, -2.6], fov: FOV },
  catalog: { position: [-0.9, 1.5, 2.3], target: [-1.55, 1.2, -1.4], fov: FOV },
  fitting: { position: [0.0, 1.42, 1.2], target: [0.0, 1.2, -2.6], fov: FOV },
};

const COMPACT: Record<StageKey, CameraPose> = {
  welcome: { position: [0.0, 1.35, 3.5], target: [0.0, 0.5, -2.6], fov: FOV },
  camera: { position: [0.0, 1.35, 3.5], target: [0.0, 0.5, -2.6], fov: FOV },
  height: { position: [0.0, 1.35, 3.5], target: [0.0, 0.5, -2.6], fov: FOV },
  scan: { position: [0.0, 1.35, 3.5], target: [0.0, 0.5, -2.6], fov: FOV },
  manual: { position: [0.0, 1.35, 3.5], target: [0.0, 0.5, -2.6], fov: FOV },
  book: { position: [0.0, 1.35, 3.5], target: [0.0, 0.5, -2.6], fov: FOV },
  catalog: { position: [-0.5, 1.4, 3.5], target: [-1.95, 0.6, -1.2], fov: FOV },
  fitting: { position: [0.0, 1.35, 3.5], target: [0.0, 0.5, -2.6], fov: FOV },
};

/** Pose de reposo de la cámara en cada pantalla, según la disposición. */
export function cameraPoseFor(stage: StageKey, layout: 'wide' | 'compact'): CameraPose {
  return (layout === 'wide' ? WIDE : COMPACT)[stage];
}

// ---- Anclaje de paneles (matemática vectorial mínima, sin three)
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export interface PanelSpec {
  /** Posición del centro del panel en pantalla, coordenadas normalizadas (-1..1) con la cámara en reposo. */
  readonly ndc: readonly [number, number];
  /** Distancia a la cámara (m) a la que «flota» el panel. */
  readonly depth: number;
  /** Giro hacia el centro de la escena (grados, + = gira hacia la derecha). */
  readonly yawDeg?: number;
  /** Escala del panel respecto al tamaño natural en píxeles (1 = 1 px CSS por píxel de pantalla). */
  readonly scale?: number;
}

export interface WorldPanelPose {
  readonly position: V3;
  /** Base ortonormal del panel: x derecha, y arriba, z hacia la cámara. */
  readonly basis: readonly [V3, V3, V3];
  readonly pxPerMeter: number;
}

/**
 * Pose de mundo de un panel que debe verse en `spec.ndc` cuando la cámara está en reposo en `cam`.
 * Queda fija en el mundo: al moverse la cámara el panel se desplaza con perspectiva real.
 */
export function panelWorldPose(
  cam: CameraPose,
  aspect: number,
  viewportHeightPx: number,
  spec: PanelSpec,
): WorldPanelPose {
  const f = norm(sub(cam.target, cam.position));
  const r = norm(cross(f, [0, 1, 0]));
  const u = norm(cross(r, f));
  const halfH = Math.tan((cam.fov * Math.PI) / 360) * spec.depth;
  const halfW = halfH * aspect;
  const [nx, ny] = spec.ndc;
  const position: V3 = [
    cam.position[0] + f[0] * spec.depth + r[0] * nx * halfW + u[0] * ny * halfH,
    cam.position[1] + f[1] * spec.depth + r[1] * nx * halfW + u[1] * ny * halfH,
    cam.position[2] + f[2] * spec.depth + r[2] * nx * halfW + u[2] * ny * halfH,
  ];
  // Base que mira a la cámara; después, giro sobre el eje Y del mundo.
  const z: V3 = [-f[0], -f[1], -f[2]];
  let bx = r;
  let by = u;
  let bz = z;
  const yaw = ((spec.yawDeg ?? 0) * Math.PI) / 180;
  if (yaw !== 0) {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const rot = (v: V3): V3 => [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
    bx = rot(bx);
    by = rot(by);
    bz = rot(bz);
  }
  const pxPerMeter = (viewportHeightPx / (2 * halfH)) * (spec.scale ?? 1);
  return { position, basis: [bx, by, bz], pxPerMeter };
}
