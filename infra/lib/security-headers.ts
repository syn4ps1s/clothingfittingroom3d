/**
 * Fuente ÚNICA de verdad de las cabeceras de seguridad HTTP del Probador 3D.
 *
 * Quién la usa (y por qué es un módulo PURO, sin dependencias de `aws-cdk-lib`):
 *  - `lib/web-stack.ts`          → construye la `ResponseHeadersPolicy` de CloudFront.
 *  - `scripts/serve-prod-like.mjs` → sirve `apps/web/dist` en local con EXACTAMENTE las mismas cabeceras,
 *                                    para que el e2e local detecte roturas de CSP antes de desplegar.
 *  - `lib/smoke.ts`              → el smoke test post-despliegue exige estas mismas cabeceras en la URL real.
 *  - `test/**`                   → pruebas de regresión de privacidad (ningún host externo en la CSP).
 *
 * Sólo sintaxis TypeScript «borrable» (sin enums ni namespaces) para que también pueda ejecutarse con
 * `node --experimental-strip-types` o `tsx`.
 */

/** Directivas CSP: nombre → lista de fuentes. Una lista vacía genera una directiva sin valor (p. ej. `upgrade-insecure-requests`). */
export type CspDirectives = Readonly<Record<string, readonly string[]>>;

/**
 * Content-Security-Policy estricta. Todo se sirve del MISMO origen (principio 1 de ENGINEERING.md):
 * no hay ni un solo host externo, así que aunque un XSS lograra ejecutarse no podría exfiltrar nada.
 *
 * Justificación de cada excepción respecto a `default-src 'none'`:
 *
 *  - `script-src 'self' 'wasm-unsafe-eval'`
 *      · `'self'`: bundles de Vite (módulos ES) y los cargadores `wasm/vision_wasm_*.js` de MediaPipe.
 *      · `'wasm-unsafe-eval'`: IMPRESCINDIBLE para compilar/instanciar WebAssembly (MediaPipe Tasks Vision).
 *        NO habilita `eval()` ni `new Function()` (eso sería `'unsafe-eval'`, que NO se concede).
 *      · No hay `'unsafe-inline'`: el `index.html` de producción no tiene scripts en línea.
 *  - `worker-src 'self' blob:`: workers del bundle (`new Worker(new URL(...))`, mismo origen) y workers
 *      creados desde `blob:` (generadores de malla/tela y MediaPipe). `blob:` sólo puede apuntar a datos
 *      creados por el propio documento (no es un canal de carga remota).
 *  - `connect-src 'self'`: `fetch` de modelos `.task`, WASM y catálogo; bloquea cualquier exfiltración
 *      (fetch/XHR/WebSocket/EventSource/sendBeacon) hacia otros hosts.
 *  - `img-src 'self' data: blob:`: texturas generadas en runtime (canvas → blob), iconos incrustados y
 *      fotogramas/ImageBitmap. `data:`/`blob:` no cargan nada de la red.
 *  - `media-src 'self' blob: mediastream:`: la cámara (`MediaStream`) y vídeos locales.
 *  - `style-src 'self' 'unsafe-inline'`: ÚNICA excepción «débil». React/three/drei (`<Html>`) y la capa
 *      DOM accesible fijan estilos en línea; los de CSSOM (`el.style.x = …`) NO los bloquea la CSP, pero
 *      cualquier librería que inyecte `<style>` o atributos `style=""` sí romperían. Se acepta porque
 *      el riesgo residual es bajo: con `default-src 'none'` + `img/font/connect 'self'`, el CSS inyectado
 *      no puede cargar recursos externos ni exfiltrar datos. Si el equipo web confirma (con
 *      `pnpm --filter @fitroom/infra csp:probe`) que no hace falta, retirar `'unsafe-inline'` aquí
 *      es un cambio de UNA línea que se propaga a CloudFront, al servidor local y al smoke test.
 *  - `font-src 'self'`: fuentes alojadas por nosotros (@fontsource), nunca Google Fonts.
 *      OJO: Vite incrusta como `data:` los activos < 4 KB (`assetsInlineLimit`); una fuente tan pequeña
 *      sería bloqueada. Las fuentes variables reales pesan decenas de KB, así que no aplica.
 *  - `manifest-src 'self'`: manifiesto de PWA futuro (hoy inocuo).
 *  - `frame-ancestors 'none'` (+ `X-Frame-Options: DENY`): anti-clickjacking; nadie puede embeber la app.
 *  - `base-uri 'none'`: impide inyectar `<base>` para redirigir URLs relativas.
 *  - `form-action 'none'`: la app no envía formularios.
 *  - `object-src 'none'`: sin plugins (`<object>/<embed>`).
 *  - `upgrade-insecure-requests`: cualquier recurso `http://` se pide por `https://`.
 *
 * Fuera de alcance a propósito (ver docs/threat-model.md): `require-trusted-types-for 'script'`
 * (el cargador de MediaPipe asigna `script.src` con strings y se rompería) y `report-to`
 * (no hay colector propio; enviarlo a un tercero violaría el principio de privacidad).
 */
export const CSP_DIRECTIVES = {
  'default-src': ["'none'"],
  'script-src': ["'self'", "'wasm-unsafe-eval'"],
  'worker-src': ["'self'", 'blob:'],
  'connect-src': ["'self'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'media-src': ["'self'", 'blob:', 'mediastream:'],
  'style-src': ["'self'", "'unsafe-inline'"],
  'font-src': ["'self'"],
  'manifest-src': ["'self'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'object-src': ["'none'"],
  'upgrade-insecure-requests': [],
} as const satisfies CspDirectives;

/** Palabras clave y esquemas locales permitidos en una fuente CSP. Cualquier otra cosa se considera host externo. */
const LOCAL_CSP_KEYWORDS: ReadonlySet<string> = new Set([
  "'none'",
  "'self'",
  "'wasm-unsafe-eval'",
  "'unsafe-inline'",
  'data:',
  'blob:',
  'mediastream:',
]);

/**
 * Devuelve las fuentes CSP que NO son locales (hosts, comodines, `https:`, `http:`, `ws:`, `*`, `'unsafe-eval'`…).
 * Una CSP válida para este proyecto devuelve SIEMPRE una lista vacía.
 */
export function findNonLocalCspSources(directives: CspDirectives = CSP_DIRECTIVES): string[] {
  const offenders: string[] = [];
  for (const [name, sources] of Object.entries(directives)) {
    // `frame-ancestors`, `base-uri`, `form-action`… sólo admiten 'none' en este proyecto: se valida igual.
    for (const source of sources) {
      if (!LOCAL_CSP_KEYWORDS.has(source)) offenders.push(`${name} ${source}`);
    }
  }
  return offenders;
}

/** Serializa unas directivas a la cabecera CSP. Lanza si hay fuentes no locales (defensa en profundidad de privacidad). */
export function buildCsp(directives: CspDirectives = CSP_DIRECTIVES): string {
  const offenders = findNonLocalCspSources(directives);
  if (offenders.length > 0) {
    throw new Error(
      `La CSP contiene fuentes no locales (violan el principio «sin hosts externos»): ${offenders.join(', ')}`,
    );
  }
  return Object.entries(directives)
    .map(([name, sources]) => (sources.length > 0 ? `${name} ${sources.join(' ')}` : name))
    .join('; ');
}

/** HSTS: 2 años. `includeSubDomains` siempre; `preload` sólo si se pide (es casi irreversible: ver docs/deploy.md). */
export const HSTS_MAX_AGE_SECONDS = 63_072_000;

/** Permissions-Policy: la cámara sólo para el propio origen; el resto de capacidades sensibles, denegadas. */
export const PERMISSIONS_POLICY =
  'camera=(self), microphone=(), geolocation=(), payment=(), usb=()';

export interface SecurityHeaderOptions {
  /** Añade `preload` a HSTS (requiere dominio propio y enviarlo a hstspreload.org). Por defecto, no. */
  readonly hstsPreload?: boolean;
  /**
   * CSP sin `'unsafe-inline'` en `style-src` (variante estricta). Pasa a ser el valor por defecto cuando la UI final
   * demuestre cero violaciones con `pnpm --filter @fitroom/infra csp:probe -- --site ../apps/web/dist --strict-style`.
   */
  readonly strictStyles?: boolean;
}

/** Directivas CSP efectivas según las opciones. */
export function cspDirectivesFor(options: SecurityHeaderOptions = {}): CspDirectives {
  return options.strictStyles ? { ...CSP_DIRECTIVES, 'style-src': ["'self'"] } : CSP_DIRECTIVES;
}

export function buildHsts(options: SecurityHeaderOptions = {}): string {
  return `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains${options.hstsPreload ? '; preload' : ''}`;
}

/**
 * Todas las cabeceras de seguridad que CloudFront debe añadir a CADA respuesta (incluidas 304 y las
 * de error). Claves en su capitalización canónica.
 */
export function buildSecurityHeaders(options: SecurityHeaderOptions = {}): Record<string, string> {
  return {
    'Content-Security-Policy': buildCsp(cspDirectivesFor(options)),
    'Permissions-Policy': PERMISSIONS_POLICY,
    'Strict-Transport-Security': buildHsts(options),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  };
}

/** Normaliza un valor de cabecera para compararlo (minúsculas en nombres de directiva, espacios colapsados). */
export function normalizeHeaderValue(value: string): string {
  return value
    .split(';')
    .map((part) => part.trim().replace(/\s+/g, ' '))
    .filter((part) => part.length > 0)
    .join('; ');
}
