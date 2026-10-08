import { beforeEach, describe, expect, it } from 'vitest';
import { REFERENCE_MEASUREMENTS } from '@fitroom/shared';
import { createAppStore } from './store';
import {
  MEASUREMENTS_KEY,
  PREFS_KEY,
  browserStorage,
  loadMeasurements,
  loadPrefs,
  wipeAll,
  type KeyValueStorage,
} from './persistence';
import { draftFromMeasurements } from './measurementDraft';

class MemoryStorage implements KeyValueStorage {
  readonly data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
  get length() {
    return this.data.size;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
}

const M = REFERENCE_MEASUREMENTS.adultB;
let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
});

function confirmed(store = createAppStore({ storage })) {
  store.getState().setDraft(draftFromMeasurements(M));
  store.getState().send({ type: 'START_MANUAL' });
  store.getState().send({ type: 'SUBMIT_MANUAL' });
  store.getState().confirmMeasurements(M);
  return store;
}

describe('persistencia opt-in', () => {
  it('por defecto NO guarda las medidas', () => {
    const store = confirmed();
    expect(store.getState().settings.remember).toBe(false);
    expect(storage.getItem(MEASUREMENTS_KEY)).toBeNull();
    expect(store.getState().flow.stage).toBe('catalog');
  });

  it('al activar «recordar» guarda; al desactivar, borra', () => {
    const store = confirmed();
    store.getState().setSettings({ remember: true });
    expect(loadMeasurements(storage)).toEqual(M);
    store.getState().setSettings({ remember: false });
    expect(storage.getItem(MEASUREMENTS_KEY)).toBeNull();
  });

  it('con «recordar» activo, confirmar nuevas medidas las guarda', () => {
    const store = createAppStore({ storage });
    store.getState().setSettings({ remember: true });
    confirmed(store);
    expect(loadMeasurements(storage)).toEqual(M);
  });

  it('un arranque nuevo recupera medidas guardadas y ofrece continuar', () => {
    const first = confirmed();
    first.getState().setSettings({ remember: true });
    const second = createAppStore({ storage });
    expect(second.getState().measurements).toEqual(M);
    expect(second.getState().flow.hasMeasurements).toBe(true);
    expect(second.getState().flow.stage).toBe('welcome');
  });

  it('sin consentimiento, aunque haya datos guardados, no se cargan', () => {
    storage.setItem(MEASUREMENTS_KEY, JSON.stringify(M));
    const store = createAppStore({ storage });
    expect(store.getState().measurements).toBeNull();
  });

  it('datos guardados corruptos o inválidos se ignoran', () => {
    storage.setItem(PREFS_KEY, JSON.stringify({ remember: true, lang: 'xx', quality: 'ultra', units: 3 }));
    storage.setItem(MEASUREMENTS_KEY, JSON.stringify({ ...M, heightCm: 9999 }));
    const store = createAppStore({ storage });
    expect(store.getState().measurements).toBeNull();
    expect(store.getState().settings.lang).toBe('es');
    expect(store.getState().settings.quality).not.toBe('ultra');
    storage.setItem(PREFS_KEY, '{no es json');
    expect(loadPrefs(storage)).toEqual({});
    storage.setItem(MEASUREMENTS_KEY, '[1,2,3]');
    expect(loadMeasurements(storage)).toBeNull();
  });

  it('«Borrar mis datos» limpia memoria y almacenamiento y vuelve a la bienvenida', () => {
    const store = confirmed();
    store.getState().setSettings({ remember: true });
    store.getState().wear('upper', { garmentId: 'tee', size: 'M', variantId: 'v' });
    storage.setItem('fitroom:otra', 'x');
    storage.setItem('ajeno', 'y');
    store.getState().wipeData();
    const s = store.getState();
    expect(s.measurements).toBeNull();
    expect(s.worn).toEqual({});
    expect(s.flow.stage).toBe('welcome');
    expect(s.settings.remember).toBe(false);
    expect([...storage.data.keys()]).toEqual(['ajeno']);
  });

  it('funciona sin almacenamiento disponible (modo privado / bloqueado)', () => {
    const broken: KeyValueStorage = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
      removeItem() {
        throw new Error('blocked');
      },
    };
    const store = createAppStore({ storage: broken });
    expect(() => confirmed(store)).not.toThrow();
    store.getState().setSettings({ remember: true });
    expect(() => store.getState().wipeData()).not.toThrow();
    expect(() => wipeAll(broken)).not.toThrow();
    expect(createAppStore({ storage: null }).getState().measurements).toBeNull();
  });

  it('el entorno de pruebas (jsdom) ofrece localStorage utilizable', () => {
    expect(browserStorage()).not.toBeNull();
  });
});

describe('ajustes y almacén', () => {
  it('idioma: parámetro > preferencia guardada > navegador', () => {
    storage.setItem(PREFS_KEY, JSON.stringify({ lang: 'en' }));
    expect(createAppStore({ storage, languages: ['es'] }).getState().settings.lang).toBe('en');
    expect(
      createAppStore({ storage, languages: ['es'], overrides: { lang: 'es' } }).getState().settings.lang,
    ).toBe('es');
    expect(createAppStore({ storage: new MemoryStorage(), languages: ['en-US'] }).getState().settings.lang).toBe('en');
  });

  it('las prendas respetan las ranuras y avisan de lo expulsado', () => {
    const store = createAppStore({ storage });
    store.getState().wear('upper', { garmentId: 'tee', size: 'M', variantId: 'v' });
    const displaced = store.getState().wear('full', { garmentId: 'dress', size: 'M', variantId: 'v' });
    expect(displaced).toEqual(['upper']);
    expect(store.getState().activeSlot).toBe('full');
    store.getState().takeOff('full');
    expect(store.getState().activeSlot).toBeNull();
  });

  it('los avisos se acumulan con tope y se pueden descartar', () => {
    const store = createAppStore({ storage });
    for (let i = 0; i < 8; i++) store.getState().toast('fitting.photoSaved');
    expect(store.getState().toasts.length).toBeLessThanOrEqual(4);
    const id = store.getState().toasts[0]!.id;
    store.getState().dismissToast(id);
    expect(store.getState().toasts.find((t) => t.id === id)).toBeUndefined();
  });
});
