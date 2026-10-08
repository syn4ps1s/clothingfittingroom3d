import type { WorldPanelPose } from './layout';

/**
 * Registro de paneles DOM anclados al espacio 3D. Los paneles (DOM real, en el árbol normal de React,
 * con sus contextos y foco) se registran aquí con una pose de mundo; el proyector dentro del Canvas
 * (`CssProjector`) escribe su `transform: matrix3d(...)` en cada fotograma de cámara.
 */
export type AnchorPose = WorldPanelPose;

interface Entry {
  readonly el: HTMLElement;
  readonly pose: AnchorPose;
}

const registry = new Map<string, Entry>();
const listeners = new Set<() => void>();

export function registerAnchor(id: string, el: HTMLElement, pose: AnchorPose): () => void {
  registry.set(id, { el, pose });
  listeners.forEach((l) => l());
  return () => {
    if (registry.get(id)?.el === el) registry.delete(id);
    listeners.forEach((l) => l());
  };
}

export function forEachAnchor(cb: (id: string, entry: Entry) => void): void {
  registry.forEach((entry, id) => cb(id, entry));
}

export function onAnchorsChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function anchorCount(): number {
  return registry.size;
}
