import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { MirrorStats, TrackingState } from '../contracts';

/**
 * Estado de la «vista» (no de los datos de la persona): disposición responsive y estado de la escena 3D.
 * - `wide`: los paneles se anclan en el espacio 3D (CSS3D alineado con la cámara).
 * - `compact`: pantallas estrechas; los mismos paneles se acoplan como hojas fijas.
 */
export type LayoutMode = 'wide' | 'compact';
export type SceneStatus = 'loading' | 'ready' | 'failed' | 'none';

export interface ViewState {
  readonly layout: LayoutMode;
  readonly sceneStatus: SceneStatus;
  /** Aspecto de la ventana (ancho/alto), para encuadrar la cámara. */
  readonly aspect: number;
  /** Alto de la ventana en px CSS (escala de los paneles anclados). */
  readonly viewportHeight: number;
  readonly reducedMotion: boolean;
  readonly tracking: TrackingState;
  readonly stats: MirrorStats | null;
  setLayout(layout: LayoutMode, aspect: number, viewportHeight: number): void;
  setSceneStatus(status: SceneStatus): void;
  setReducedMotion(reduced: boolean): void;
  setTracking(tracking: TrackingState): void;
  setStats(stats: MirrorStats | null): void;
}

export const viewStore = createStore<ViewState>()((set) => ({
  layout: 'compact',
  sceneStatus: 'loading',
  aspect: 1,
  viewportHeight: 800,
  reducedMotion: false,
  tracking: 'initializing',
  stats: null,
  setLayout: (layout, aspect, viewportHeight) => set({ layout, aspect, viewportHeight }),
  setSceneStatus: (sceneStatus) => set({ sceneStatus }),
  setReducedMotion: (reducedMotion) => set({ reducedMotion }),
  setTracking: (tracking) => set({ tracking }),
  setStats: (stats) => set({ stats }),
}));

export function useView<T>(selector: (s: ViewState) => T): T {
  return useStore(viewStore, selector);
}

/** ¿Los paneles van anclados al espacio 3D? (pantalla ancha y escena no fallida) */
export function useAnchored(): boolean {
  return useView((s) => s.layout === 'wide' && s.sceneStatus !== 'failed' && s.sceneStatus !== 'none');
}
