/**
 * Smoke test de una URL ya servida (CloudFront real tras un despliegue, o el servidor local prod-like).
 * Falla si faltan las cabeceras de seguridad o si los metadatos de los archivos no son los esperados.
 * Sin dependencias: sólo `fetch` de Node ≥ 22.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { CACHE_IMMUTABLE, CACHE_REVALIDATE } from './asset-policy';
import { buildSecurityHeaders, normalizeHeaderValue } from './security-headers';

export interface SmokeCheck {
  readonly name: string;
  readonly ok: boolean;
  /** Los avisos (`warn`) no hacen fallar el smoke test. */
  readonly severity: 'error' | 'warn';
  readonly detail: string;
}

export interface SmokeOptions {
  /** Raíz de la web, p. ej. `https://probador.example.com` o `http://127.0.0.1:4180`. */
  readonly baseUrl: string;
  /** `apps/web/dist` para comprobar archivos concretos (JS con hash, .wasm, .task). Opcional. */
  readonly distDir?: string;
  readonly hstsPreload?: boolean;
  readonly strictStyles?: boolean;
  /** Reintentos de la primera petición (la propagación de CloudFront tras un despliegue puede tardar). */
  readonly retries?: number;
  readonly retryDelayMs?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface SmokeResult {
  readonly ok: boolean;
  readonly checks: readonly SmokeCheck[];
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split('\\').join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** Compara el valor de una cabecera tolerando mayúsculas en nombres de directiva y espacios. */
export function sameHeaderValue(name: string, actual: string | null, expected: string): boolean {
  if (actual === null) return false;
  const norm = (value: string): string =>
    normalizeHeaderValue(value)
      .split('; ')
      .map((part) =>
        name.toLowerCase() === 'strict-transport-security' ? part.toLowerCase() : part,
      )
      .join('; ');
  return norm(actual) === norm(expected);
}

export async function runSmokeTests(options: SmokeOptions): Promise<SmokeResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const base = new URL(options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`);
  const timeout = options.timeoutMs ?? 20_000;
  const checks: SmokeCheck[] = [];
  const add = (
    name: string,
    ok: boolean,
    detail: string,
    severity: 'error' | 'warn' = 'error',
  ): void => {
    checks.push({ name, ok, severity, detail });
  };
  const get = (path: string, init: RequestInit = {}): Promise<Response> =>
    doFetch(new URL(path.replace(/^\//, ''), base), {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
      ...init,
    });

  // Primera petición con reintentos: justo tras `cdk deploy` el borde puede tardar en servir la versión nueva.
  const retries = options.retries ?? 5;
  let home: Response | undefined;
  let lastError = '';
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      home = await get('/');
      if (home.status === 200) break;
      lastError = `HTTP ${home.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, options.retryDelayMs ?? 5_000));
  }
  if (!home || home.status !== 200) {
    add(
      'GET / responde 200',
      false,
      `sin respuesta válida tras ${retries + 1} intentos (${lastError})`,
    );
    return { ok: false, checks };
  }
  const homeBody = await home.text();
  add('GET / responde 200', true, `HTTP ${home.status}`);
  add(
    'GET / es HTML',
    /^text\/html/i.test(home.headers.get('content-type') ?? '') && /<!doctype html/i.test(homeBody),
    home.headers.get('content-type') ?? '(sin content-type)',
  );
  add(
    'GET / no se cachea (revalidación obligatoria)',
    /no-cache|max-age=0/i.test(home.headers.get('cache-control') ?? ''),
    `Cache-Control: ${home.headers.get('cache-control') ?? '(ausente)'}`,
  );

  // Cabeceras de seguridad en la home, en un fallback SPA y en un archivo estático.
  const expectedHeaders = buildSecurityHeaders({
    hstsPreload: options.hstsPreload ?? false,
    strictStyles: options.strictStyles ?? false,
  });
  const checkSecurityHeaders = (label: string, response: Response): void => {
    for (const [name, expected] of Object.entries(expectedHeaders)) {
      const actual = response.headers.get(name);
      add(
        `${label}: ${name}`,
        sameHeaderValue(name, actual, expected),
        actual === null ? 'AUSENTE' : actual === expected ? 'ok' : `distinto: ${actual}`,
      );
    }
  };
  checkSecurityHeaders('cabeceras en /', home);

  const deep = await get('/probador/ruta-que-no-existe');
  const deepBody = await deep.text();
  add(
    'fallback SPA: ruta desconocida → 200 + index.html',
    deep.status === 200 && /<!doctype html/i.test(deepBody),
    `HTTP ${deep.status}`,
  );
  checkSecurityHeaders('cabeceras en fallback SPA', deep);

  const post = await get('/', { method: 'POST', body: 'x' });
  add(
    'métodos de escritura rechazados (POST → 403/405)',
    post.status === 403 || post.status === 405,
    `HTTP ${post.status}`,
  );
  await post.arrayBuffer();

  if (base.protocol === 'https:') {
    const insecure = new URL(base.href);
    insecure.protocol = 'http:';
    try {
      const redirect = await doFetch(insecure, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeout),
      });
      const location = redirect.headers.get('location') ?? '';
      add(
        'HTTP → HTTPS',
        [301, 302, 307, 308].includes(redirect.status) && location.startsWith('https://'),
        `HTTP ${redirect.status} → ${location}`,
      );
    } catch (error) {
      add('HTTP → HTTPS', false, error instanceof Error ? error.message : String(error));
    }
  }

  // Archivos concretos del build (si se facilita `dist`).
  if (options.distDir) {
    const files = listFiles(options.distDir);
    const firstOf = (pattern: RegExp): string | undefined => files.find((f) => pattern.test(f));
    const targets: { label: string; path: string | undefined; type: RegExp; cache: string }[] = [
      {
        label: 'JS con hash',
        path: firstOf(/^assets\/.+\.js$/),
        type: /^(text|application)\/javascript/i,
        cache: CACHE_IMMUTABLE,
      },
      {
        label: 'CSS con hash',
        path: firstOf(/^assets\/.+\.css$/),
        type: /^text\/css/i,
        cache: CACHE_IMMUTABLE,
      },
      {
        label: 'WASM',
        path: firstOf(/^wasm\/.+\.wasm$/),
        type: /^application\/wasm$/i,
        cache: CACHE_REVALIDATE,
      },
      {
        label: 'cargador WASM (JS)',
        path: firstOf(/^wasm\/.+\.js$/),
        type: /^(text|application)\/javascript/i,
        cache: CACHE_REVALIDATE,
      },
      {
        label: 'modelo .task',
        path: firstOf(/^models\/.+\.task$/),
        type: /^application\/octet-stream$/i,
        cache: CACHE_REVALIDATE,
      },
    ];
    for (const target of targets) {
      if (!target.path) {
        add(
          `${target.label}: presente en dist`,
          false,
          'no hay ningún archivo de esa clase en dist',
          'warn',
        );
        continue;
      }
      const response = await get(`/${target.path}`, { method: 'HEAD' });
      const where = `/${target.path}`;
      add(`${target.label}: ${where} → 200`, response.status === 200, `HTTP ${response.status}`);
      add(
        `${target.label}: Content-Type`,
        target.type.test(response.headers.get('content-type') ?? ''),
        response.headers.get('content-type') ?? '(ausente)',
      );
      const cache = response.headers.get('cache-control') ?? '';
      const cacheOk =
        target.cache === CACHE_REVALIDATE
          ? /must-revalidate|no-cache/.test(cache)
          : cache.includes(target.cache);
      add(`${target.label}: Cache-Control`, cacheOk, cache || '(ausente)');
      checkSecurityHeaders(`cabeceras en ${posix.basename(target.path)}`, response);
    }
    const map = files.find((f) => f.endsWith('.map'));
    if (map) {
      const response = await get(`/${map}`);
      const type = response.headers.get('content-type') ?? '';
      add(
        'los .map no están publicados',
        !/json/i.test(type) || response.status !== 200,
        `HTTP ${response.status} ${type}`,
      );
      await response.arrayBuffer();
    }
    const js = files.find((f) => /^assets\/.+\.js$/.test(f));
    if (js) {
      const response = await get(`/${js}`, { headers: { 'accept-encoding': 'br, gzip' } });
      const size = Number(response.headers.get('content-length') ?? 0);
      const encoding = response.headers.get('content-encoding');
      await response.arrayBuffer();
      add(
        'compresión Brotli/gzip del JS',
        encoding === 'br' || encoding === 'gzip' || size < 1000,
        `content-encoding: ${encoding ?? '(ninguna)'}`,
        'warn',
      );
    }
  }

  const ok = checks.every((check) => check.ok || check.severity === 'warn');
  return { ok, checks };
}

export function formatSmokeResult(result: SmokeResult): string {
  const lines = result.checks.map(
    (c) => `${c.ok ? 'OK  ' : c.severity === 'warn' ? 'AVISO' : 'FALLO'} ${c.name}  (${c.detail})`,
  );
  const failed = result.checks.filter((c) => !c.ok && c.severity === 'error').length;
  lines.push(
    result.ok
      ? `\nSmoke test: TODO CORRECTO (${result.checks.length} comprobaciones)`
      : `\nSmoke test: ${failed} comprobación(es) fallida(s)`,
  );
  return lines.join('\n');
}
