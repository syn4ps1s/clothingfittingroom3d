import type { Quality } from '../state/persistence';
import { isLang, type Lang } from '../i18n/translate';

/**
 * Parámetros de URL de desarrollo y pruebas. NUNCA contienen datos de la persona (medidas, etc.).
 *   ?mock=1       todo simulado (cámara, escaneo, espejo, modelos)
 *   ?synthetic=1  pipeline real pero pose sintética en vez de cámara
 *   ?quality=low|medium|high   ?lang=es|en   ?debug=1
 *   ?mockcam=denied|unavailable|insecure|error|slow   (sólo con mock)  ?mockspeed=<factor> (acelera el escaneo simulado)
 *   ?webgl=0      fuerza la alternativa sin WebGL2 (pruebas)
 */
export type MockCameraMode = 'ok' | 'denied' | 'unavailable' | 'insecure-context' | 'error' | 'slow';

export interface AppParams {
  readonly mock: boolean;
  readonly synthetic: boolean;
  readonly quality: Quality | null;
  readonly lang: Lang | null;
  readonly debug: boolean;
  readonly mockCam: MockCameraMode;
  readonly mockSpeed: number;
  readonly forceNoWebgl: boolean;
}

const truthy = (v: string | null): boolean => v === '1' || v === 'true';

export function parseParams(search: string): AppParams {
  const p = new URLSearchParams(search);
  const q = p.get('quality');
  const lang = p.get('lang');
  const cam = p.get('mockcam');
  const speed = Number(p.get('mockspeed'));
  const mockCam: MockCameraMode =
    cam === 'denied' || cam === 'unavailable' || cam === 'error' || cam === 'slow'
      ? cam
      : cam === 'insecure'
        ? 'insecure-context'
        : 'ok';
  return {
    mock: truthy(p.get('mock')),
    synthetic: truthy(p.get('synthetic')),
    quality: q === 'low' || q === 'medium' || q === 'high' ? q : null,
    lang: isLang(lang) ? lang : null,
    debug: truthy(p.get('debug')),
    mockCam,
    mockSpeed: Number.isFinite(speed) && speed > 0 ? Math.min(speed, 100) : 1,
    forceNoWebgl: p.get('webgl') === '0',
  };
}

let cached: AppParams | null = null;

/** Parámetros de la página actual (se leen una sola vez). */
export function appParams(): AppParams {
  cached ??= parseParams(typeof location === 'undefined' ? '' : location.search);
  return cached;
}

/** Sólo para pruebas. */
export function resetAppParamsForTests(search = ''): void {
  cached = parseParams(search);
}
