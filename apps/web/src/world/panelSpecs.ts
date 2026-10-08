import type { PanelSpec } from './layout';

/**
 * Dónde «cuelga» cada panel en el espacio cuando la disposición es ancha (con la cámara de su pantalla en reposo).
 * Los valores son coordenadas de pantalla normalizadas + profundidad: así se adaptan a cualquier relación de aspecto.
 */
export type PanelId =
  | 'welcome-copy'
  | 'welcome-cta'
  | 'camera-status'
  | 'height'
  | 'scan'
  | 'book'
  | 'catalog'
  | 'fit-sheet'
  | 'fit-swatches'
  | 'fit-toolbar';

export const PANEL_SPECS: Readonly<Record<PanelId, PanelSpec>> = {
  'welcome-copy': { ndc: [-0.6, 0.02], depth: 3.4, yawDeg: 9 },
  'welcome-cta': { ndc: [0.0, -0.5], depth: 6.0 },
  'camera-status': { ndc: [-0.58, 0.0], depth: 3.0, yawDeg: 9 },
  height: { ndc: [-0.58, 0.0], depth: 3.0, yawDeg: 9 },
  scan: { ndc: [-0.6, 0.0], depth: 3.0, yawDeg: 9 },
  book: { ndc: [0.0, -0.02], depth: 2.9 },
  catalog: { ndc: [0.52, 0.0], depth: 3.2, yawDeg: -9 },
  'fit-sheet': { ndc: [-0.66, 0.0], depth: 3.0, yawDeg: 12 },
  'fit-swatches': { ndc: [0.66, 0.0], depth: 3.0, yawDeg: -12 },
  'fit-toolbar': { ndc: [0.0, -0.83], depth: 3.0 },
};
