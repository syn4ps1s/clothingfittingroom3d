import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CatalogDataError, SizingInputError } from './errors.js';
import {
  clamp,
  clamp01,
  deepFreeze,
  isInvisibleCodePoint,
  median,
  normalizeText,
  round,
} from './util.js';
import { formatPath, sanitizeForMessage } from './errors.js';
import { FC } from './test-helpers.js';

describe('util', () => {
  it('clamp / clamp01 / round', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
    expect(clamp01(1.4)).toBe(1);
    expect(round(1.23456, 2)).toBe(1.23);
    expect(round(2.5, 0)).toBe(3);
  });

  it('median', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([7])).toBe(7);
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });

  it('deepFreeze congela objetos anidados y es idempotente; ignora primitivos', () => {
    const o = deepFreeze({ a: { b: [1, { c: 2 }] }, d: 'x' });
    expect(Object.isFrozen(o.a.b[1])).toBe(true);
    expect(deepFreeze(o)).toBe(o);
    expect(deepFreeze(5)).toBe(5);
    expect(deepFreeze(null)).toBe(null);
  });

  it('normalizeText: idempotente y sin acentos para cualquier cadena', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        const n = normalizeText(s);
        expect(normalizeText(n)).toBe(n);
        expect(n).toBe(n.trim());
        expect(/\p{M}/u.test(n)).toBe(false);
      }),
      FC,
    );
  });

  it('isInvisibleCodePoint', () => {
    expect(isInvisibleCodePoint(0x41)).toBe(false);
    expect(isInvisibleCodePoint(0x0a)).toBe(true);
    expect(isInvisibleCodePoint(0x202e)).toBe(true);
    expect(isInvisibleCodePoint(0xfeff)).toBe(true);
  });
});

describe('errores', () => {
  it('sanitizeForMessage recorta y elimina controles', () => {
    expect(sanitizeForMessage('a\nb‮c')).toBe('a b c');
    expect(sanitizeForMessage('x'.repeat(500)).length).toBe(121);
    expect(sanitizeForMessage('hola')).toBe('hola');
  });

  it('formatPath formatea rutas con índices y claves', () => {
    expect(formatPath([])).toBe('(raíz)');
    expect(formatPath(['garments', 2, 'variants', 0, 'color'])).toBe(
      'garments[2].variants[0].color',
    );
    expect(formatPath([0, 'a'])).toBe('[0].a');
  });

  it('los errores resumen y acotan la lista de problemas', () => {
    const issues = Array.from({ length: 12 }, (_, i) => ({ path: `p${i}`, message: `m${i}` }));
    const e = new CatalogDataError(issues);
    expect(e.message).toContain('12 problemas');
    expect(e.message).toContain('(+4 más)');
    expect(e.name).toBe('CatalogDataError');
    const one = new SizingInputError('invalid-sigma', [{ path: 'sigmaCm', message: 'mal' }]);
    expect(one.message).toContain('1 problema)');
    expect(one.code).toBe('invalid-sigma');
    expect(one).toBeInstanceOf(Error);
  });
});
