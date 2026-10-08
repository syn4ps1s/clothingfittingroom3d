import { MeasurementsSchema, type Measurements } from '@fitroom/shared';
import { isLang, type Lang } from '../i18n/translate';
import type { UnitSystem } from './units';

/**
 * Persistencia local con tres reglas:
 * 1. Las medidas sólo se guardan si la persona activó «recordar» (por defecto NO) y jamás van en la URL.
 * 2. Todo acceso a `localStorage` va con try/catch (modo privado, almacenamiento bloqueado, cuota).
 * 3. Lo leído se valida (zod / listas cerradas): un valor corrupto se ignora, nunca se confía en él.
 */
export type Quality = 'low' | 'medium' | 'high';
export type MotionPref = 'system' | 'reduce' | 'full';

export interface Settings {
  readonly lang: Lang;
  readonly units: UnitSystem;
  readonly quality: Quality;
  readonly motion: MotionPref;
  /** Efecto espejo horizontal del probador. */
  readonly mirrored: boolean;
  /** Consentimiento explícito para guardar las medidas en este dispositivo. */
  readonly remember: boolean;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const STORAGE_PREFIX = 'fitroom:';
export const PREFS_KEY = `${STORAGE_PREFIX}prefs:v1`;
export const MEASUREMENTS_KEY = `${STORAGE_PREFIX}measurements:v1`;

export function browserStorage(): KeyValueStorage | null {
  try {
    const s = globalThis.localStorage;
    // Algunos navegadores lanzan sólo al escribir.
    const probe = `${STORAGE_PREFIX}probe`;
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

function isQuality(v: unknown): v is Quality {
  return v === 'low' || v === 'medium' || v === 'high';
}
function isMotion(v: unknown): v is MotionPref {
  return v === 'system' || v === 'reduce' || v === 'full';
}
function isUnits(v: unknown): v is UnitSystem {
  return v === 'metric' || v === 'imperial';
}

/** Lee las preferencias guardadas, descartando cualquier campo inválido. */
export function loadPrefs(storage: KeyValueStorage | null): Partial<Settings> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(PREFS_KEY);
    if (!raw) return {};
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return {};
    const d = data as Record<string, unknown>;
    const out: { -readonly [K in keyof Settings]?: Settings[K] } = {};
    if (isLang(d.lang)) out.lang = d.lang;
    if (isUnits(d.units)) out.units = d.units;
    if (isQuality(d.quality)) out.quality = d.quality;
    if (isMotion(d.motion)) out.motion = d.motion;
    if (typeof d.mirrored === 'boolean') out.mirrored = d.mirrored;
    if (typeof d.remember === 'boolean') out.remember = d.remember;
    return out;
  } catch {
    return {};
  }
}

export function savePrefs(storage: KeyValueStorage | null, settings: Settings): boolean {
  if (!storage) return false;
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

export function loadMeasurements(storage: KeyValueStorage | null): Measurements | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(MEASUREMENTS_KEY);
    if (!raw) return null;
    const parsed = MeasurementsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveMeasurements(storage: KeyValueStorage | null, m: Measurements): boolean {
  if (!storage) return false;
  try {
    storage.setItem(MEASUREMENTS_KEY, JSON.stringify(m));
    return true;
  } catch {
    return false;
  }
}

export function forgetMeasurements(storage: KeyValueStorage | null): void {
  try {
    storage?.removeItem(MEASUREMENTS_KEY);
  } catch {
    /* nada que borrar */
  }
}

/** «Borrar mis datos»: elimina TODO lo que esta aplicación haya guardado (prefijo `fitroom:`). */
export function wipeAll(storage: KeyValueStorage | null): void {
  if (!storage) return;
  try {
    storage.removeItem(MEASUREMENTS_KEY);
    storage.removeItem(PREFS_KEY);
    const s = storage as Storage;
    if (typeof s.length === 'number' && typeof s.key === 'function') {
      const stale: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k?.startsWith(STORAGE_PREFIX)) stale.push(k);
      }
      for (const k of stale) storage.removeItem(k);
    }
  } catch {
    /* nada que borrar */
  }
}
