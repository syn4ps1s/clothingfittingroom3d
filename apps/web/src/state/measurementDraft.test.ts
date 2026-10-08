import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MEASUREMENT_KEYS,
  MEASUREMENT_LIMITS,
  REFERENCE_MEASUREMENTS,
  type MeasurementEstimate,
  type Measurements,
  type PartialMeasurements,
} from '@fitroom/shared';
import {
  buildMeasurements,
  commitAll,
  commitField,
  displayText,
  draftFromEstimate,
  draftFromMeasurements,
  editField,
  emptyDraft,
  fieldError,
  sigmaForDisplay,
  toPartial,
  validateDraft,
} from './measurementDraft';
import { toDisplay } from './units';

/** Completado de prueba: rellena lo que falta con las medidas de referencia (sin depender de @fitroom/body). */
const complete = (p: PartialMeasurements): Measurements => ({
  ...REFERENCE_MEASUREMENTS.adultA,
  ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)),
}) as Measurements;

const typed = (text: string, key: (typeof MEASUREMENT_KEYS)[number] = 'heightCm', system: 'metric' | 'imperial' = 'metric') =>
  commitField(editField(emptyDraft(), key, text), key, system);

describe('formulario de medidas: validación', () => {
  it('estatura vacía → obligatoria; resto vacío → sin error', () => {
    const d = emptyDraft();
    expect(fieldError(d, 'heightCm', 'metric')?.code).toBe('required');
    expect(fieldError(d, 'chestCm', 'metric')).toBeNull();
    expect(validateDraft(d, 'metric').ok).toBe(false);
  });

  it.each(['abc', 'NaN', 'Infinity', '-170', '1e3', '17 0', '170,5,2'])(
    'texto inválido %j → error invalid y NO se convierte en valor',
    (text) => {
      const d = typed(text);
      expect(d.fields.heightCm.value).toBeNull();
      expect(d.fields.heightCm.text).toBe(text);
      expect(fieldError(d, 'heightCm', 'metric')?.code).toBe('invalid');
    },
  );

  it.each(['119', '119,9', '230,1', '0', '999'])('fuera de rango %j → out-of-range', (text) => {
    const d = typed(text);
    expect(d.fields.heightCm.value).toBeNull();
    const err = fieldError(d, 'heightCm', 'metric');
    expect(err?.code).toBe('out-of-range');
    expect(err?.limits).toMatchObject({ min: 120, max: 230, unit: 'cm' });
  });

  it('acepta los extremos exactos y decimales con coma o punto', () => {
    expect(typed('120').fields.heightCm.value).toBe(120);
    expect(typed('230').fields.heightCm.value).toBe(230);
    expect(typed('178,5').fields.heightCm.value).toBe(178.5);
    expect(typed('178.5').fields.heightCm.value).toBe(178.5);
  });

  it('un campo opcional vacío se borra al confirmar; el obligatorio no', () => {
    const base = draftFromMeasurements(REFERENCE_MEASUREMENTS.adultA);
    const cleared = commitField(editField(base, 'chestCm', ''), 'chestCm', 'metric');
    expect(cleared.fields.chestCm.value).toBeNull();
    const keep = commitField(editField(base, 'heightCm', ''), 'heightCm', 'metric');
    expect(keep.fields.heightCm.text).toBe('');
    expect(fieldError(keep, 'heightCm', 'metric')?.code).toBe('required');
  });

  it('editar a mano marca la fuente como user y borra la incertidumbre', () => {
    const est: MeasurementEstimate = {
      heightCm: { value: 175, sigma: 0.5, source: 'user' },
      chestCm: { value: 96, sigma: 3, source: 'scan-video' },
    };
    const d = draftFromEstimate(est);
    expect(sigmaForDisplay(d, 'chestCm', 'metric')).toBe(3);
    const edited = typed('100', 'chestCm');
    expect(edited.fields.chestCm).toMatchObject({ value: 100, sigma: 0, source: 'user' });
    expect(sigmaForDisplay(edited, 'chestCm', 'metric')).toBeNull();
  });

  it('confirmar sin cambiar el texto conserva la estimación y su incertidumbre', () => {
    const d = draftFromEstimate({
      heightCm: { value: 175, sigma: 0, source: 'user' },
      waistCm: { value: 80.04, sigma: 2.4, source: 'scan-video' },
    });
    const text = displayText(d, 'waistCm', 'metric', 'es');
    const again = commitField(editField(d, 'waistCm', text), 'waistCm', 'metric');
    expect(again.fields.waistCm).toMatchObject({ value: 80.04, sigma: 2.4, source: 'scan-video' });
  });
});

describe('unidades en el formulario', () => {
  it('cm → in → cm no pierde precisión: el canónico no se toca al cambiar de unidad', () => {
    fc.assert(
      fc.property(fc.double({ min: 120, max: 230, noNaN: true }), (cm) => {
        const d = draftFromMeasurements({ ...REFERENCE_MEASUREMENTS.adultA, heightCm: cm });
        const afterSwitch = commitAll(d, 'imperial'); // no hay textos pendientes
        expect(afterSwitch.fields.heightCm.value).toBe(cm);
        expect(displayText(d, 'heightCm', 'imperial', 'en')).not.toBe('');
      }),
    );
  });

  it('teclear pulgadas guarda el canónico en cm', () => {
    const d = typed('70', 'heightCm', 'imperial');
    expect(d.fields.heightCm.value).toBeCloseTo(177.8, 9);
    expect(displayText(d, 'heightCm', 'imperial', 'en')).toBe('70');
    expect(displayText(d, 'heightCm', 'metric', 'es')).toBe('177,8');
  });

  it('los límites se aplican sobre el canónico, no sobre el texto', () => {
    expect(fieldError(typed('47', 'heightCm', 'imperial'), 'heightCm', 'imperial')?.code).toBe(
      'out-of-range',
    );
    expect(typed('48', 'heightCm', 'imperial').fields.heightCm.value).toBeCloseTo(121.92, 9);
  });

  it('el peso en libras se convierte a kg', () => {
    const d = typed('176', 'weightKg', 'imperial');
    expect(d.fields.weightKg.value).toBeCloseTo(79.83, 1);
  });
});

describe('construcción de medidas completas', () => {
  it('con sólo la estatura completa el resto', () => {
    const d = typed('180');
    const r = buildMeasurements(d, 'metric', complete);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.measurements.heightCm).toBe(180);
  });

  it('bloquea entradas inválidas y estatura ausente', () => {
    expect(buildMeasurements(emptyDraft(), 'metric', complete)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(buildMeasurements(typed('x'), 'metric', complete).ok).toBe(false);
  });

  it('confirma el texto pendiente antes de construir', () => {
    const d = editField(emptyDraft(), 'heightCm', '171,5');
    const r = buildMeasurements(d, 'metric', complete);
    expect(r.ok && r.measurements.heightCm).toBe(171.5);
  });

  it('si el completado lanza o devuelve basura, falla de forma controlada', () => {
    const d = typed('180');
    expect(
      buildMeasurements(d, 'metric', () => {
        throw new Error('boom');
      }),
    ).toEqual({ ok: false, reason: 'completion-failed' });
    expect(
      buildMeasurements(d, 'metric', () => ({ ...REFERENCE_MEASUREMENTS.adultA, chestCm: Number.NaN })),
    ).toEqual({ ok: false, reason: 'completion-failed' });
  });

  it('toPartial sólo incluye valores canónicos y la base corporal', () => {
    const d = typed('180');
    expect(toPartial(d)).toEqual({ heightCm: 180, bodyBase: 'neutral' });
    expect(toPartial(emptyDraft())).toBeNull();
  });

  it('propiedad: un borrador válido jamás produce medidas fuera de los límites', () => {
    fc.assert(
      fc.property(fc.double({ min: 120, max: 230, noNaN: true }), fc.double({ min: 45, max: 180, noNaN: true }), (h, w) => {
        let d = emptyDraft();
        d = commitField(editField(d, 'heightCm', String(h)), 'heightCm', 'metric');
        d = commitField(editField(d, 'waistCm', String(w)), 'waistCm', 'metric');
        const r = buildMeasurements(d, 'metric', complete);
        expect(r.ok).toBe(true);
        if (r.ok) {
          for (const k of MEASUREMENT_KEYS) {
            expect(r.measurements[k]).toBeGreaterThanOrEqual(MEASUREMENT_LIMITS[k].min);
            expect(r.measurements[k]).toBeLessThanOrEqual(MEASUREMENT_LIMITS[k].max);
          }
        }
      }),
    );
  });
});

describe('borrador desde estimaciones', () => {
  it('ignora valores no finitos y normaliza sigma', () => {
    const d = draftFromEstimate({
      heightCm: { value: 170, sigma: 0, source: 'user' },
      chestCm: { value: Number.NaN, sigma: 2, source: 'scan-video' },
      waistCm: { value: 80, sigma: Number.POSITIVE_INFINITY, source: 'scan-video' },
      hipCm: { value: 95, sigma: -4, source: 'scan-video' },
    });
    expect(d.fields.chestCm.value).toBeNull();
    expect(d.fields.waistCm.sigma).toBeNull();
    expect(d.fields.hipCm.sigma).toBe(0);
  });

  it('un valor estimado fuera de rango se marca como error (no se corrige)', () => {
    const d = draftFromEstimate({ heightCm: { value: 170, sigma: 0, source: 'user' }, chestCm: { value: 400, sigma: 1, source: 'scan-video' } });
    expect(fieldError(d, 'chestCm', 'metric')?.code).toBe('out-of-range');
  });

  it('muestra en la unidad elegida', () => {
    const d = draftFromMeasurements(REFERENCE_MEASUREMENTS.adultA);
    expect(displayText(d, 'heightCm', 'metric', 'es')).toBe('178');
    expect(displayText(d, 'heightCm', 'imperial', 'en')).toBe(
      String(Math.round(toDisplay('heightCm', 178, 'imperial') * 10) / 10),
    );
  });
});
