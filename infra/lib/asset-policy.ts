/**
 * Política de activos estáticos: cómo se clasifican los archivos de `apps/web/dist`, qué `Cache-Control`
 * y `Content-Type` llevan en S3 y qué política de caché de CloudFront les corresponde.
 *
 * Es un módulo PURO y declarativo, compartido por:
 *  - `lib/web-stack.ts` → una `BucketDeployment` por clase (filtros `include`/`exclude` de `aws s3 sync`).
 *  - `scripts/serve-prod-like.mjs` → reproduce en local las mismas cabeceras `Cache-Control`/`Content-Type`.
 *  - `lib/smoke.ts` → comprueba en la URL real que los metadatos llegaron bien.
 *
 * Por qué `Content-Type` explícito: con `X-Content-Type-Options: nosniff`, un `.js` o `.css` con MIME
 * erróneo se BLOQUEA, y `WebAssembly.instantiateStreaming` exige `application/wasm` exacto.
 */

/** Hash en el nombre (Vite) → el contenido nunca cambia bajo la misma URL → 1 año e `immutable`. */
export const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Binarios sin hash en el nombre (modelos `.task`, WASM y sus cargadores): el navegador SIEMPRE revalida
 * (ETag → 304, barato) para no mezclar un JS nuevo con un WASM viejo; el borde de CloudFront sí los cachea
 * 1 día (`s-maxage`) y se invalida en cada despliegue.
 */
export const CACHE_REVALIDATE = 'public, max-age=0, s-maxage=86400, must-revalidate';

/** `index.html` y todo lo demás sin hash: nunca se sirve sin revalidar. */
export const CACHE_NO_CACHE = 'public, max-age=0, must-revalidate';

export type EdgeCacheKind = 'immutable' | 'revalidate' | 'none';

export interface AssetClass {
  /** Id lógico (también el de la `BucketDeployment`, en PascalCase). */
  readonly id: string;
  readonly description: string;
  /** Patrones glob estilo `aws s3 sync --include` (relativos a `dist`; `*` casa también `/`). Vacío = «todo lo demás». */
  readonly include: readonly string[];
  readonly cacheControl: string;
  /** `Content-Type` forzado. Si falta, S3 lo deduce de la extensión. */
  readonly contentType?: string;
  readonly edgeCache: EdgeCacheKind;
}

/** Clases con patrón propio, en orden de evaluación. La clase final (`SHELL_CLASS`) recoge el resto. */
export const ASSET_CLASSES: readonly AssetClass[] = [
  {
    id: 'ImmutableAssets',
    description: 'JS/CSS/fuentes/imágenes con hash de contenido emitidos por Vite en assets/',
    include: ['assets/*'],
    cacheControl: CACHE_IMMUTABLE,
    edgeCache: 'immutable',
  },
  {
    id: 'WasmBinaries',
    description:
      'WebAssembly de MediaPipe (application/wasm es obligatorio para instantiateStreaming)',
    include: ['wasm/*.wasm'],
    cacheControl: CACHE_REVALIDATE,
    contentType: 'application/wasm',
    edgeCache: 'revalidate',
  },
  {
    id: 'WasmLoaders',
    description: 'Cargadores JS de MediaPipe junto al WASM (deben ser JavaScript por nosniff)',
    include: ['wasm/*.js'],
    cacheControl: CACHE_REVALIDATE,
    contentType: 'text/javascript; charset=utf-8',
    edgeCache: 'revalidate',
  },
  {
    id: 'PoseModels',
    description: 'Modelos de pose .task (~15 MB, verificados con SHA-256 en CI)',
    include: ['models/*.task'],
    cacheControl: CACHE_REVALIDATE,
    contentType: 'application/octet-stream',
    edgeCache: 'revalidate',
  },
];

/** Todo lo que no encaja en las clases anteriores: index.html, favicon, manifest, JSON de catálogo… */
export const SHELL_CLASS: AssetClass = {
  id: 'Shell',
  description: 'index.html y archivos sin hash (nunca se sirven sin revalidar)',
  include: [],
  cacheControl: CACHE_NO_CACHE,
  edgeCache: 'none',
};

/** Rutas de CloudFront (path patterns) con comportamiento propio, derivadas de las clases. */
export const EDGE_PATH_PATTERNS: Readonly<Record<'immutable' | 'revalidate', readonly string[]>> = {
  immutable: ['assets/*'],
  revalidate: ['wasm/*', 'models/*'],
};

/** Convierte un glob de `aws s3 sync` (`*` = cualquier cosa, incluido `/`; `?` = un carácter) en RegExp anclada. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/** Clasifica una ruta relativa a `dist` (con `/` como separador, sin barra inicial). */
export function classifyAsset(relativePath: string): AssetClass {
  const path = relativePath.replace(/^\/+/, '');
  for (const cls of ASSET_CLASSES) {
    if (cls.include.some((glob) => globToRegExp(glob).test(path))) return cls;
  }
  return SHELL_CLASS;
}

/** Patrones `--exclude` que dejan fuera de la clase «resto» todo lo que ya cubren las demás. */
export function shellExcludePatterns(): string[] {
  return ASSET_CLASSES.flatMap((cls) => [...cls.include]);
}

/** Tipos MIME por extensión para el servidor local y las comprobaciones (S3 hace lo propio con `mimetypes`). */
export const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ktx2': 'image/ktx2',
  '.hdr': 'image/vnd.radiance',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** `Content-Type` efectivo de una ruta: el forzado por su clase, o el de su extensión, o binario genérico. */
export function contentTypeFor(relativePath: string): string {
  const cls = classifyAsset(relativePath);
  if (cls.contentType) return cls.contentType;
  const dot = relativePath.lastIndexOf('.');
  const ext = dot >= 0 ? relativePath.slice(dot).toLowerCase() : '';
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}
