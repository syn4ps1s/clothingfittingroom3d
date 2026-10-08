import { describe, expect, it } from 'vitest';
import { PROD, PROD_FULL, STAGING, synth } from './helpers';

/**
 * Normaliza lo que cambia sin que cambie la infraestructura: hashes de activos (dependen de aws-cdk-lib y de los
 * archivos de `dist`), pero NO los identificadores lógicos ni las propiedades.
 */
function normalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value).replace(/[0-9a-f]{64}/g, '<sha256>'));
}

describe('plantillas de CloudFormation (snapshot estable)', () => {
  it('staging', () => {
    expect(normalize(synth(STAGING).json)).toMatchSnapshot();
  });
  it('prod con dominio', () => {
    expect(normalize(synth(PROD).json)).toMatchSnapshot();
  });
  it('prod con todas las opciones (alarmas, presupuesto, preload, geo)', () => {
    expect(normalize(synth(PROD_FULL).json)).toMatchSnapshot();
  });
  it('es determinista: dos síntesis seguidas producen la misma plantilla', () => {
    expect(normalize(synth(PROD_FULL).json)).toEqual(normalize(synth(PROD_FULL).json));
  });
});
