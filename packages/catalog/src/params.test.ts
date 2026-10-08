import { describe, expect, it } from 'vitest';
import { GARMENT_TEMPLATES } from '@fitroom/shared';
import { TEMPLATE_PARAM_SPECS, templateParam } from './index.js';
import { garmentOf } from './test-helpers.js';

describe('templateParam', () => {
  it('devuelve el valor de la prenda o, si falta, el valor por defecto documentado', () => {
    const tee = garmentOf('tee-essential');
    expect(templateParam(tee, 'neckDropCm')).toBe(8);
    const without = { ...tee, params: undefined };
    expect(templateParam(without, 'neckDropCm')).toBe(
      TEMPLATE_PARAM_SPECS.tee.required.neckDropCm!.default,
    );
    const nan = { ...tee, params: { neckDropCm: Number.NaN } };
    expect(templateParam(nan, 'neckDropCm')).toBe(
      TEMPLATE_PARAM_SPECS.tee.required.neckDropCm!.default,
    );
    expect(templateParam(tee, 'noExiste')).toBeUndefined();
    // claves opcionales también tienen valor por defecto
    expect(
      templateParam({ ...garmentOf('dress-shirt-poplin'), params: {} }, 'sleeveTaper'),
    ).toBeDefined();
  });

  it('cada plantilla tiene especificación con al menos 4 claves obligatorias', () => {
    for (const t of GARMENT_TEMPLATES) {
      expect(Object.keys(TEMPLATE_PARAM_SPECS[t].required).length, t).toBeGreaterThanOrEqual(4);
    }
  });
});
