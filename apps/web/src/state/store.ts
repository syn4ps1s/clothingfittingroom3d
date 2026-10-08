import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type {
  GarmentCategory,
  GarmentSlot,
  MeasurementEstimate,
  MeasurementKey,
  Measurements,
} from '@fitroom/shared';
import { MEASUREMENT_KEYS } from '@fitroom/shared';
import type { MessageKey } from '../i18n/translate';
import { detectLang } from '../i18n/translate';
import {
  commitAll,
  draftFromEstimate,
  draftFromMeasurements,
  emptyDraft,
  type Draft,
} from './measurementDraft';
import { initialFlow, transition, type FlowEvent, type FlowState } from './flow';
import {
  browserStorage,
  forgetMeasurements,
  loadMeasurements,
  loadPrefs,
  saveMeasurements,
  savePrefs,
  wipeAll,
  type KeyValueStorage,
  type Quality,
  type Settings,
} from './persistence';
import { equip, unequip, updateWorn, type Worn, type WornItem } from './wardrobe';

export interface Toast {
  readonly id: number;
  readonly key: MessageKey;
  readonly params?: Record<string, string | number>;
  readonly tone: 'info' | 'error';
}

export interface CatalogUi {
  readonly category: GarmentCategory | 'all';
  readonly query: string;
}

export interface AppState {
  readonly flow: FlowState;
  readonly settings: Settings;
  readonly draft: Draft;
  /** Medidas confirmadas (completas) con las que se construye el cuerpo. */
  readonly measurements: Measurements | null;
  /** Incertidumbre (cm) de las medidas confirmadas que vinieron de un escaneo, para el tallaje. */
  readonly sigma: Readonly<Partial<Record<MeasurementKey, number>>>;
  readonly catalogUi: CatalogUi;
  readonly worn: Worn;
  readonly activeSlot: GarmentSlot | null;
  /** `before` = ver sin la prenda (comparar). */
  readonly view: 'after' | 'before';
  readonly settingsOpen: boolean;
  readonly toasts: readonly Toast[];
  readonly hoveredGarmentId: string | null;

  send(event: FlowEvent): void;
  setSettings(patch: Partial<Settings>): void;
  setDraft(draft: Draft): void;
  applyEstimate(estimate: MeasurementEstimate): void;
  confirmMeasurements(measurements: Measurements): void;
  setCatalogUi(patch: Partial<CatalogUi>): void;
  /** Se pone una prenda; devuelve las ranuras expulsadas. */
  wear(slot: GarmentSlot, item: WornItem): readonly GarmentSlot[];
  takeOff(slot: GarmentSlot): void;
  patchWorn(slot: GarmentSlot, patch: Partial<WornItem>): void;
  setActiveSlot(slot: GarmentSlot | null): void;
  setView(view: 'after' | 'before'): void;
  setSettingsOpen(open: boolean): void;
  setHoveredGarment(id: string | null): void;
  toast(key: MessageKey, params?: Record<string, string | number>, tone?: Toast['tone']): void;
  dismissToast(id: number): void;
  /** «Borrar mis datos»: memoria + almacenamiento. */
  wipeData(): void;
}

let toastSeq = 0;

export interface StoreInit {
  readonly storage?: KeyValueStorage | null;
  readonly languages?: readonly string[];
  readonly overrides?: {
    readonly lang?: Settings['lang'] | null;
    readonly quality?: Quality | null;
  };
  readonly defaultQuality?: Quality;
}

function heuristicQuality(): Quality {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const cores = nav?.hardwareConcurrency ?? 8;
  const memory = (nav as (Navigator & { deviceMemory?: number }) | undefined)?.deviceMemory ?? 8;
  return cores <= 4 || memory <= 4 ? 'low' : 'medium';
}

export function createAppStore(init: StoreInit = {}): StoreApi<AppState> {
  const storage = init.storage === undefined ? browserStorage() : init.storage;
  const saved = loadPrefs(storage);
  const settings: Settings = {
    lang: init.overrides?.lang ?? saved.lang ?? detectLang(init.languages),
    units: saved.units ?? 'metric',
    quality: init.overrides?.quality ?? saved.quality ?? init.defaultQuality ?? heuristicQuality(),
    motion: saved.motion ?? 'system',
    mirrored: saved.mirrored ?? true,
    remember: saved.remember ?? false,
  };
  // Medidas guardadas: sólo si hubo consentimiento explícito Y los datos pasan la validación.
  const savedMeasurements = settings.remember ? loadMeasurements(storage) : null;

  return createStore<AppState>()((set, get) => ({
    flow: savedMeasurements ? { ...initialFlow, hasMeasurements: true } : initialFlow,
    settings,
    draft: savedMeasurements ? draftFromMeasurements(savedMeasurements) : emptyDraft(),
    measurements: savedMeasurements,
    sigma: {},
    catalogUi: { category: 'all', query: '' },
    worn: {},
    activeSlot: null,
    view: 'after',
    settingsOpen: false,
    toasts: [],
    hoveredGarmentId: null,

    send: (event) => set((s) => ({ flow: transition(s.flow, event) })),

    setSettings: (patch) => {
      const next = { ...get().settings, ...patch };
      set({ settings: next });
      savePrefs(storage, next);
      const { measurements } = get();
      if (patch.remember === true && measurements) saveMeasurements(storage, measurements);
      if (patch.remember === false) forgetMeasurements(storage);
    },

    setDraft: (draft) => set({ draft }),

    applyEstimate: (estimate) =>
      set((s) => ({ draft: draftFromEstimate(estimate, s.draft.bodyBase) })),

    confirmMeasurements: (measurements) => {
      const { draft, settings: current } = get();
      const committed = commitAll(draft, current.units);
      const sigma: Partial<Record<MeasurementKey, number>> = {};
      for (const k of MEASUREMENT_KEYS) {
        const f = committed.fields[k];
        if (f.sigma !== null && f.sigma > 0 && f.source !== 'user') sigma[k] = f.sigma;
      }
      set((s) => ({
        measurements,
        sigma,
        draft: committed,
        flow: transition(s.flow, { type: 'CONFIRM_MEASUREMENTS' }),
      }));
      if (current.remember) saveMeasurements(storage, measurements);
    },

    setCatalogUi: (patch) => set((s) => ({ catalogUi: { ...s.catalogUi, ...patch } })),

    wear: (slot, item) => {
      const result = equip(get().worn, slot, item);
      set({ worn: result.worn, activeSlot: slot, view: 'after' });
      return result.displaced;
    },

    takeOff: (slot) =>
      set((s) => {
        const worn = unequip(s.worn, slot);
        const remaining = (['upper', 'lower', 'full', 'outer'] as const).find((x) => worn[x]);
        return {
          worn,
          activeSlot: s.activeSlot === slot ? (remaining ?? null) : s.activeSlot,
        };
      }),

    patchWorn: (slot, patch) => set((s) => ({ worn: updateWorn(s.worn, slot, patch) })),
    setActiveSlot: (activeSlot) => set({ activeSlot }),
    setView: (view) => set({ view }),
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    setHoveredGarment: (hoveredGarmentId) => set({ hoveredGarmentId }),

    toast: (key, params, tone = 'info') =>
      set((s) => ({
        toasts: [...s.toasts.slice(-3), { id: ++toastSeq, key, params, tone }],
      })),
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

    wipeData: () => {
      wipeAll(storage);
      set((s) => ({
        flow: initialFlow,
        settings: { ...s.settings, remember: false },
        draft: emptyDraft(),
        measurements: null,
        sigma: {},
        catalogUi: { category: 'all', query: '' },
        worn: {},
        activeSlot: null,
        view: 'after',
        hoveredGarmentId: null,
      }));
    },
  }));
}

/** Almacén de la aplicación (singleton). Los tests crean el suyo con `createAppStore`. */
let singleton: StoreApi<AppState> | null = null;

export function appStore(): StoreApi<AppState> {
  singleton ??= createAppStore({
    languages: typeof navigator === 'undefined' ? undefined : navigator.languages,
    overrides: undefined,
  });
  return singleton;
}

/** Instala un almacén concreto como singleton (arranque de la app con parámetros de URL, y pruebas). */
export function installAppStore(store: StoreApi<AppState>): void {
  singleton = store;
}

export function useApp<T>(selector: (state: AppState) => T): T {
  return useStore(appStore(), selector);
}
