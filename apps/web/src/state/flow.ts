/**
 * Máquina de estados del recorrido (pura y testeable). El store de zustand sólo la envuelve.
 *
 *   welcome ─START_CAMERA→ camera ─CAMERA_READY→ height ─SUBMIT_HEIGHT→ scan ─SCAN_COMPLETE→ book
 *   welcome ─START_MANUAL→ manual ─SUBMIT_MANUAL→ book ─CONFIRM→ catalog ⇄ fitting
 *
 * Una transición no permitida devuelve el MISMO estado (referencia idéntica): nunca lanza ni «salta» pantallas.
 */
export const STAGES = [
  'welcome',
  'camera',
  'height',
  'scan',
  'manual',
  'book',
  'catalog',
  'fitting',
] as const;
export type Stage = (typeof STAGES)[number];

/** De dónde vinieron las medidas que se están revisando en el libro. */
export type MeasurementOrigin = 'scan' | 'manual' | 'saved';

export interface FlowState {
  readonly stage: Stage;
  readonly origin: MeasurementOrigin | null;
  /** Hay medidas confirmadas (permite saltar directamente al catálogo). */
  readonly hasMeasurements: boolean;
  /** Hay al menos una prenda elegida (permite volver al probador). */
  readonly hasGarment: boolean;
}

export type FlowEvent =
  | { readonly type: 'START_CAMERA' }
  | { readonly type: 'CAMERA_READY' }
  | { readonly type: 'START_MANUAL' }
  | { readonly type: 'SUBMIT_HEIGHT' }
  | { readonly type: 'SCAN_COMPLETE' }
  | { readonly type: 'SCAN_CANCEL' }
  | { readonly type: 'SUBMIT_MANUAL' }
  | { readonly type: 'USE_SAVED' }
  | { readonly type: 'CONFIRM_MEASUREMENTS' }
  | { readonly type: 'EDIT_MEASUREMENTS' }
  | { readonly type: 'SELECT_GARMENT' }
  | { readonly type: 'BACK' }
  | { readonly type: 'RESET' };

export const initialFlow: FlowState = {
  stage: 'welcome',
  origin: null,
  hasMeasurements: false,
  hasGarment: false,
};

const go = (s: FlowState, patch: Partial<FlowState>): FlowState => ({ ...s, ...patch });

/** Pantalla a la que lleva «Atrás» (null = no hay atrás desde aquí). */
export function backTarget(s: FlowState): Stage | null {
  switch (s.stage) {
    case 'welcome':
      return null;
    case 'camera':
    case 'height':
    case 'manual':
      return 'welcome';
    case 'scan':
      return 'height';
    case 'book':
      if (s.origin === 'scan') return 'height';
      if (s.origin === 'manual') return 'manual';
      return 'welcome';
    case 'catalog':
      return 'book';
    case 'fitting':
      return 'catalog';
  }
}

export function transition(s: FlowState, e: FlowEvent): FlowState {
  switch (e.type) {
    case 'RESET':
      return initialFlow;
    case 'START_CAMERA':
      return s.stage === 'welcome' || s.stage === 'manual' ? go(s, { stage: 'camera' }) : s;
    case 'CAMERA_READY':
      return s.stage === 'camera' ? go(s, { stage: 'height' }) : s;
    case 'START_MANUAL':
      return s.stage === 'welcome' || s.stage === 'camera' || s.stage === 'height'
        ? go(s, { stage: 'manual' })
        : s;
    case 'SUBMIT_HEIGHT':
      return s.stage === 'height' ? go(s, { stage: 'scan' }) : s;
    case 'SCAN_COMPLETE':
      return s.stage === 'scan' ? go(s, { stage: 'book', origin: 'scan' }) : s;
    case 'SCAN_CANCEL':
      return s.stage === 'scan' ? go(s, { stage: 'height' }) : s;
    case 'SUBMIT_MANUAL':
      return s.stage === 'manual' ? go(s, { stage: 'book', origin: 'manual' }) : s;
    case 'USE_SAVED':
      return s.stage === 'welcome' && s.hasMeasurements
        ? go(s, { stage: 'catalog', origin: 'saved' })
        : s;
    case 'CONFIRM_MEASUREMENTS':
      return s.stage === 'book' ? go(s, { stage: 'catalog', hasMeasurements: true }) : s;
    case 'EDIT_MEASUREMENTS':
      return (s.stage === 'catalog' || s.stage === 'fitting') && s.hasMeasurements
        ? go(s, { stage: 'book', origin: s.origin ?? 'manual' })
        : s;
    case 'SELECT_GARMENT':
      return (s.stage === 'catalog' || s.stage === 'fitting') && s.hasMeasurements
        ? go(s, { stage: 'fitting', hasGarment: true })
        : s;
    case 'BACK': {
      const target = backTarget(s);
      return target === null ? s : go(s, { stage: target });
    }
  }
}

/** ¿La cámara debe estar encendida en esta pantalla? (privacidad: la luz se apaga en cuanto no hace falta). */
export function stageWantsCamera(stage: Stage): boolean {
  return stage === 'camera' || stage === 'height' || stage === 'scan' || stage === 'fitting';
}
