import { describe, expect, it } from 'vitest';
import { SCAN_HINTS, SCAN_PHASES, FIT_PREFERENCES } from '@fitroom/shared';
import { en } from './en';
import { es } from './es';
import {
  BODY_BASE_KEYS,
  CAMERA_TEXT_KEYS,
  CAMERA_TITLE_KEYS,
  CATEGORY_KEYS,
  MEASURE_KEYS,
  NOTE_KEYS,
  SCAN_HINT_KEYS,
  SCAN_PHASE_KEYS,
  SLOT_KEYS,
  SOURCE_KEYS,
  STAGE_KEYS,
  TRACKING_KEYS,
  VERDICT_KEYS,
  ZONE_KEYS,
} from './keys';
import { detectLang, formatPrice, interpolate, localized, makeT, translate } from './translate';

const placeholders = (s: string): string[] =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('paridad es/en', () => {
  const esKeys = Object.keys(es).sort();
  const enKeys = Object.keys(en).sort();

  it('tienen exactamente las mismas claves', () => {
    expect(enKeys).toEqual(esKeys);
  });

  it('cada clave tiene las mismas interpolaciones en ambos idiomas', () => {
    for (const key of esKeys) {
      const k = key as keyof typeof es;
      expect(placeholders(en[k]), `interpolaciones de ${key}`).toEqual(placeholders(es[k]));
    }
  });

  it('ninguna traducción está vacía y ninguna conserva marcas de pendiente', () => {
    for (const lang of [es, en] as Record<string, string>[]) {
      for (const [key, value] of Object.entries(lang)) {
        expect(value.trim().length, key).toBeGreaterThan(0);
        expect(value, key).not.toMatch(/TODO|FIXME|\?\?\?/);
      }
    }
  });

  it('el español no contiene texto inglés evidente en claves clave de bienvenida', () => {
    expect(es['welcome.cta']).toBe('Encender cámara');
    expect(en['welcome.cta']).toBe('Turn on camera');
  });
});

describe('tablas de claves de dominio', () => {
  it('todas las pistas del escaneo y fases están traducidas', () => {
    expect(Object.keys(SCAN_HINT_KEYS).sort()).toEqual([...SCAN_HINTS].sort());
    expect(Object.keys(SCAN_PHASE_KEYS).sort()).toEqual([...SCAN_PHASES].sort());
    for (const key of [...Object.values(SCAN_HINT_KEYS), ...Object.values(SCAN_PHASE_KEYS)]) {
      expect(es[key]).toBeTruthy();
      expect(en[key]).toBeTruthy();
    }
  });

  it('todos los estados de cámara tienen título y texto', () => {
    const statuses = ['idle', 'requesting', 'ready', 'denied', 'unavailable', 'insecure-context', 'error'];
    expect(Object.keys(CAMERA_TITLE_KEYS).sort()).toEqual([...statuses].sort());
    expect(Object.keys(CAMERA_TEXT_KEYS).sort()).toEqual([...statuses].sort());
  });

  it('el resto de tablas apuntan a claves existentes', () => {
    const tables = [
      TRACKING_KEYS,
      STAGE_KEYS,
      MEASURE_KEYS,
      SOURCE_KEYS,
      BODY_BASE_KEYS,
      CATEGORY_KEYS,
      SLOT_KEYS,
      VERDICT_KEYS,
      ZONE_KEYS,
      NOTE_KEYS,
    ];
    for (const table of tables) {
      for (const key of Object.values(table)) {
        expect(key in es, `${key} falta en es`).toBe(true);
        expect(key in en, `${key} falta en en`).toBe(true);
      }
    }
    expect(FIT_PREFERENCES.length).toBeGreaterThan(0);
  });
});

describe('traducción', () => {
  it('interpola parámetros y conserva los desconocidos', () => {
    expect(interpolate('Hola {name}, {count} prendas', { name: 'Ana', count: 3 })).toBe(
      'Hola Ana, 3 prendas',
    );
    expect(interpolate('Hola {name}', {})).toBe('Hola {name}');
  });

  it('t() traduce según el idioma', () => {
    expect(makeT('es')('app.back')).toBe('Atrás');
    expect(makeT('en')('app.back')).toBe('Back');
    expect(translate('en', 'scan.percent', { percent: 40 })).toBe('40%');
  });

  it('no interpreta HTML ni plantillas dentro de los parámetros', () => {
    const out = translate('es', 'catalog.tryGarment', { name: '<img src=x onerror=alert(1)> {name}' });
    expect(out).toContain('<img');
    expect(out).toContain('{name}');
  });

  it('detecta el idioma del navegador con español por defecto', () => {
    expect(detectLang(['en-GB', 'es'])).toBe('en');
    expect(detectLang(['es-MX'])).toBe('es');
    expect(detectLang(['fr-FR', 'de'])).toBe('es');
    expect(detectLang(undefined)).toBe('es');
  });

  it('texto localizado del catálogo y precios', () => {
    expect(localized({ es: 'Camisa', en: 'Shirt' }, 'en')).toBe('Shirt');
    expect(formatPrice(79, 'es')).toMatch(/79/);
    expect(formatPrice(79.5, 'en')).toMatch(/79\.50/);
  });
});
