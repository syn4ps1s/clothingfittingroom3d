import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  STAGES,
  backTarget,
  initialFlow,
  stageWantsCamera,
  transition,
  type FlowEvent,
  type FlowState,
} from './flow';

const EVENTS: FlowEvent['type'][] = [
  'START_CAMERA',
  'CAMERA_READY',
  'START_MANUAL',
  'SUBMIT_HEIGHT',
  'SCAN_COMPLETE',
  'SCAN_CANCEL',
  'SUBMIT_MANUAL',
  'USE_SAVED',
  'CONFIRM_MEASUREMENTS',
  'EDIT_MEASUREMENTS',
  'SELECT_GARMENT',
  'BACK',
  'RESET',
];

const run = (events: FlowEvent['type'][], from: FlowState = initialFlow): FlowState =>
  events.reduce((s, type) => transition(s, { type } as FlowEvent), from);

describe('máquina de estados del recorrido', () => {
  it('recorrido feliz con cámara', () => {
    let s = initialFlow;
    const path: [FlowEvent['type'], string][] = [
      ['START_CAMERA', 'camera'],
      ['CAMERA_READY', 'height'],
      ['SUBMIT_HEIGHT', 'scan'],
      ['SCAN_COMPLETE', 'book'],
      ['CONFIRM_MEASUREMENTS', 'catalog'],
      ['SELECT_GARMENT', 'fitting'],
    ];
    for (const [type, stage] of path) {
      s = transition(s, { type } as FlowEvent);
      expect(s.stage).toBe(stage);
    }
    expect(s.origin).toBe('scan');
    expect(s.hasMeasurements).toBe(true);
    expect(s.hasGarment).toBe(true);
  });

  it('recorrido manual sin cámara', () => {
    const s = run(['START_MANUAL', 'SUBMIT_MANUAL', 'CONFIRM_MEASUREMENTS']);
    expect(s.stage).toBe('catalog');
    expect(s.origin).toBe('manual');
  });

  it('alternativa manual desde un error de cámara', () => {
    expect(run(['START_CAMERA', 'START_MANUAL']).stage).toBe('manual');
  });

  it('no se puede saltar pasos: sin medidas no hay catálogo ni probador', () => {
    for (const ev of ['SELECT_GARMENT', 'CONFIRM_MEASUREMENTS', 'USE_SAVED', 'EDIT_MEASUREMENTS'] as const) {
      expect(transition(initialFlow, { type: ev })).toBe(initialFlow);
    }
    expect(run(['START_MANUAL', 'SUBMIT_MANUAL', 'SELECT_GARMENT']).stage).toBe('book');
  });

  it('«medidas guardadas» permite ir directo al catálogo sólo desde la bienvenida', () => {
    const saved: FlowState = { ...initialFlow, hasMeasurements: true };
    expect(transition(saved, { type: 'USE_SAVED' }).stage).toBe('catalog');
    const inCamera = transition(saved, { type: 'START_CAMERA' });
    expect(transition(inCamera, { type: 'USE_SAVED' })).toBe(inCamera);
  });

  it('atrás sigue el camino lógico', () => {
    expect(run(['START_CAMERA', 'CAMERA_READY', 'SUBMIT_HEIGHT', 'BACK']).stage).toBe('height');
    expect(run(['START_MANUAL', 'SUBMIT_MANUAL', 'BACK']).stage).toBe('manual');
    expect(run(['START_CAMERA', 'CAMERA_READY', 'SUBMIT_HEIGHT', 'SCAN_COMPLETE', 'BACK']).stage).toBe('height');
    expect(backTarget(initialFlow)).toBeNull();
    expect(transition(initialFlow, { type: 'BACK' })).toBe(initialFlow);
  });

  it('cancelar el escaneo vuelve a pedir la estatura', () => {
    expect(run(['START_CAMERA', 'CAMERA_READY', 'SUBMIT_HEIGHT', 'SCAN_CANCEL']).stage).toBe('height');
  });

  it('editar medidas desde el catálogo o el probador vuelve al libro', () => {
    const inFitting = run(['START_MANUAL', 'SUBMIT_MANUAL', 'CONFIRM_MEASUREMENTS', 'SELECT_GARMENT']);
    expect(transition(inFitting, { type: 'EDIT_MEASUREMENTS' }).stage).toBe('book');
  });

  it('RESET vuelve siempre al estado inicial', () => {
    expect(run(['START_MANUAL', 'SUBMIT_MANUAL', 'RESET'])).toEqual(initialFlow);
  });

  it('transiciones inválidas devuelven la misma referencia', () => {
    expect(transition(initialFlow, { type: 'SCAN_COMPLETE' })).toBe(initialFlow);
    expect(transition(initialFlow, { type: 'CAMERA_READY' })).toBe(initialFlow);
    expect(transition(initialFlow, { type: 'SUBMIT_HEIGHT' })).toBe(initialFlow);
  });

  it('la cámara sólo se quiere donde hace falta (privacidad)', () => {
    expect(STAGES.filter(stageWantsCamera)).toEqual(['camera', 'height', 'scan', 'fitting']);
  });

  it('propiedad: cualquier secuencia de eventos mantiene los invariantes', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...EVENTS), { maxLength: 60 }), (events) => {
        let s = initialFlow;
        for (const type of events) {
          s = transition(s, { type } as FlowEvent);
          expect(STAGES).toContain(s.stage);
          // Sin medidas confirmadas nunca se llega al catálogo ni al probador.
          if (s.stage === 'catalog' || s.stage === 'fitting') expect(s.hasMeasurements).toBe(true);
          if (s.stage === 'fitting') expect(s.hasGarment).toBe(true);
          if (s.stage === 'welcome' && type === 'RESET') expect(s).toEqual(initialFlow);
        }
      }),
      { numRuns: 300 },
    );
  });
});
