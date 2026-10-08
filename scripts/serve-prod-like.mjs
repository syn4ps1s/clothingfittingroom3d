#!/usr/bin/env node
// Servidor local «prod-like» para `apps/web/dist`.
//
// Reproduce lo que harán CloudFront + S3 (ver infra/lib/web-stack.ts) para que el e2e local detecte, ANTES de
// desplegar, cualquier cosa que la CSP rompa (WASM de MediaPipe, workers, blob:, estilos en línea…):
//   · Cabeceras de seguridad IDÉNTICAS: se importan de la fuente única `infra/lib/security-headers.ts`
//     (la misma que construye la ResponseHeadersPolicy; un test lo garantiza).
//   · `Cache-Control` y `Content-Type` por clase de archivo, de `infra/lib/asset-policy.ts` (la misma tabla
//     que usan las BucketDeployment): `application/wasm` para .wasm, `application/octet-stream` para .task…
//   · Fallback SPA: cualquier ruta inexistente devuelve `/index.html` con 200 (igual que los errores 403/404
//     personalizados de CloudFront). Se avisa por consola si lo pedido tenía extensión (probable archivo perdido).
//   · Los `.map` NO se sirven (no se publican a S3 por defecto).
//   · ETag + 304, Range, Brotli/gzip (1 KB–10 MB, como CloudFront) y sólo GET/HEAD.
//
// Uso (puerto por defecto 4180):
//   pnpm --filter @fitroom/infra serve:prod-like                  # sirve apps/web/dist
//   pnpm --filter @fitroom/infra serve:prod-like -- --port 4200 --dir apps/web/dist
// Playwright: E2E_BASE_URL=http://127.0.0.1:4180 pnpm test:e2e     (ver docs/deploy.md §«e2e prod-like»)
//
// Se ejecuta con tsx (importa .ts) o con Node ≥ 22.18 (type stripping nativo).
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { classifyAsset, contentTypeFor } from '../infra/lib/asset-policy.ts';
import { buildSecurityHeaders } from '../infra/lib/security-headers.ts';

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PORT = 4180;
export const DEFAULT_DIR = resolve(repoRoot, 'apps/web/dist');

/** CloudFront sólo comprime estos tipos, entre 1 000 y 10 000 000 bytes. */
const COMPRESSIBLE =
  /^(text\/|application\/(javascript|json|manifest\+json|wasm|xml)|image\/(svg\+xml|x-icon|vnd\.radiance)|font\/(ttf|otf)|model\/gltf\+json)/;
const MIN_COMPRESS = 1_000;
const MAX_COMPRESS = 10_000_000;

/**
 * @param {{ dir?: string, quiet?: boolean, compress?: boolean, publishSourceMaps?: boolean, hstsPreload?: boolean, strictStyles?: boolean }} options
 * @returns {import('node:http').Server}
 */
export function createProdLikeServer(options = {}) {
  const root = resolve(options.dir ?? DEFAULT_DIR);
  const quiet = options.quiet ?? false;
  const compress = options.compress ?? true;
  const publishSourceMaps = options.publishSourceMaps ?? false;
  const securityHeaders = buildSecurityHeaders({
    hstsPreload: options.hstsPreload ?? false,
    strictStyles: options.strictStyles ?? false,
  });
  /** @type {Map<string, Buffer>} */
  const compressedCache = new Map();

  const log = (line) => {
    if (!quiet) console.log(line);
  };

  /** Ruta de URL → ruta relativa segura dentro de `root`, o `null` si es inválida/peligrosa. */
  function toRelativePath(urlPath) {
    let decoded;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    if (decoded.includes('\0') || decoded.includes('\\')) return null;
    const parts = decoded.split('/').filter((part) => part !== '' && part !== '.');
    if (parts.includes('..')) return null;
    if (parts.some((part) => part.startsWith('.'))) return ''; // dotfiles: como si no existieran
    return parts.join('/');
  }

  async function findFile(relative) {
    if (relative === '' || (!publishSourceMaps && relative.endsWith('.map'))) return null;
    const absolute = resolve(root, relative);
    if (absolute !== root && !absolute.startsWith(root + sep)) return null;
    try {
      const info = await stat(absolute);
      return info.isFile() ? { absolute, info, relative } : null;
    } catch {
      return null;
    }
  }

  function baseHeaders(file, relative) {
    const cls = classifyAsset(relative);
    const etag = `"${createHash('sha1').update(`${file.info.size}-${file.info.mtimeMs}`).digest('hex').slice(0, 32)}"`;
    return {
      ...securityHeaders,
      'Content-Type': contentTypeFor(relative),
      'Cache-Control': cls.cacheControl,
      ETag: etag,
      'Last-Modified': file.info.mtime.toUTCString(),
    };
  }

  function notModified(request, headers) {
    const ifNoneMatch = request.headers['if-none-match'];
    if (ifNoneMatch) {
      const wanted = ifNoneMatch.split(',').map((tag) => tag.trim().replace(/^W\//, ''));
      return wanted.includes('*') || wanted.includes(headers.ETag);
    }
    const since = request.headers['if-modified-since'];
    if (since && headers['Last-Modified']) {
      const sinceMs = Date.parse(since);
      return Number.isFinite(sinceMs) && Date.parse(headers['Last-Modified']) <= sinceMs;
    }
    return false;
  }

  /** Devuelve el código HTTP enviado. */
  async function serveFile(request, response, file) {
    const headers = baseHeaders(file, file.relative);
    const type = headers['Content-Type'];
    const size = file.info.size;
    headers['Accept-Ranges'] = 'bytes';
    if (COMPRESSIBLE.test(type)) headers.Vary = 'Accept-Encoding';

    // Range: siempre sin comprimir (como CloudFront/S3).
    const range = request.headers.range;
    const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    if (match && (match[1] || match[2])) {
      const start = Math.max(0, match[1] ? Number(match[1]) : size - Number(match[2]));
      const end = Math.min(match[1] && match[2] ? Number(match[2]) : size - 1, size - 1);
      if (start > end || start >= size) {
        response.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
        response.end();
        return 416;
      }
      response.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1),
      });
      if (request.method === 'HEAD') response.end();
      else createReadStream(file.absolute, { start, end }).pipe(response);
      return 206;
    }

    const accepts = String(request.headers['accept-encoding'] ?? '');
    const compressible =
      compress && size >= MIN_COMPRESS && size <= MAX_COMPRESS && COMPRESSIBLE.test(type);
    const encoding = !compressible
      ? null
      : /\bbr\b/.test(accepts)
        ? 'br'
        : /\bgzip\b/.test(accepts)
          ? 'gzip'
          : null;
    if (encoding) headers.ETag = headers.ETag.replace(/"$/, `-${encoding}"`);

    if (notModified(request, headers)) {
      response.writeHead(304, headers);
      response.end();
      return 304;
    }

    if (encoding) {
      const key = `${file.absolute}|${file.info.mtimeMs}|${encoding}`;
      let body = compressedCache.get(key);
      if (!body) {
        const raw = await readFile(file.absolute);
        body =
          encoding === 'br'
            ? await brotli(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } })
            : await gzipAsync(raw, { level: 6 });
        compressedCache.set(key, body);
      }
      headers['Content-Encoding'] = encoding;
      headers['Content-Length'] = String(body.length);
      response.writeHead(200, headers);
      response.end(request.method === 'HEAD' ? undefined : body);
      return 200;
    }

    headers['Content-Length'] = String(size);
    response.writeHead(200, headers);
    if (request.method === 'HEAD') response.end();
    else createReadStream(file.absolute).pipe(response);
    return 200;
  }

  return http.createServer(async (request, response) => {
    const started = Date.now();
    const url = new URL(request.url ?? '/', 'http://prod-like.local');
    let status = 500;
    let note = '';
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        // CloudFront con ALLOW_GET_HEAD responde 403 al resto de métodos.
        response.writeHead(403, {
          ...securityHeaders,
          'Content-Type': 'text/plain; charset=utf-8',
        });
        response.end('403 Forbidden: sólo GET y HEAD');
        status = 403;
        return;
      }
      const relative = toRelativePath(url.pathname);
      if (relative === null) {
        response.writeHead(400, {
          ...securityHeaders,
          'Content-Type': 'text/plain; charset=utf-8',
        });
        response.end('400 Bad Request');
        status = 400;
        return;
      }
      const wanted = relative === '' ? 'index.html' : relative;
      let file = await findFile(wanted);
      if (!file) {
        // Igual que CloudFront: 403/404 de S3 → /index.html con 200 (SPA).
        file = await findFile('index.html');
        if (!file) {
          response.writeHead(404, {
            ...securityHeaders,
            'Content-Type': 'text/plain; charset=utf-8',
          });
          response.end(
            `404: no existe ${resolve(root, 'index.html')} (¿falta \`pnpm --filter @fitroom/web build\`?)`,
          );
          status = 404;
          return;
        }
        note = extname(wanted)
          ? `FALLBACK SPA para archivo con extensión (¿falta en dist?): ${wanted}`
          : 'fallback SPA';
        if (extname(wanted)) log(`! ${note}`);
      }
      status = await serveFile(request, response, file);
    } catch (error) {
      console.error('Error sirviendo', url.pathname, error);
      if (!response.headersSent)
        response.writeHead(500, {
          ...securityHeaders,
          'Content-Type': 'text/plain; charset=utf-8',
        });
      response.end('500 Internal Server Error');
    } finally {
      log(
        `${request.method} ${url.pathname} ${status} ${Date.now() - started}ms${note ? ` [${note}]` : ''}`,
      );
    }
  });
}

/** Parseo mínimo de argumentos: --dir, --port, --host, --quiet, --no-compress, --publish-source-maps, --hsts-preload. */
export function parseArgs(argv, env = process.env) {
  const options = {
    dir: env.DIST_DIR ?? DEFAULT_DIR,
    port: Number(env.PORT ?? DEFAULT_PORT),
    host: env.HOST ?? '127.0.0.1',
    quiet: false,
    compress: true,
    publishSourceMaps: false,
    hstsPreload: false,
    strictStyles: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[(i += 1)];
      if (next === undefined) throw new Error(`Falta el valor de ${arg}`);
      return next;
    };
    if (arg === '--dir') options.dir = resolve(value());
    else if (arg === '--port') options.port = Number(value());
    else if (arg === '--host') options.host = value();
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--no-compress') options.compress = false;
    else if (arg === '--publish-source-maps') options.publishSourceMaps = true;
    else if (arg === '--hsts-preload') options.hstsPreload = true;
    else if (arg === '--strict-style') options.strictStyles = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--') continue;
    else throw new Error(`Argumento desconocido: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error(`Puerto inválido: ${options.port}`);
  }
  return options;
}

const HELP = `serve-prod-like: sirve apps/web/dist con las cabeceras de producción (CloudFront)

  --dir <ruta>            carpeta a servir (por defecto apps/web/dist)
  --port <n>              puerto (por defecto ${DEFAULT_PORT}; 0 = aleatorio)
  --host <ip>             interfaz (por defecto 127.0.0.1; la cámara sólo funciona en localhost/HTTPS)
  --quiet                 sin registro de peticiones
  --no-compress           desactiva Brotli/gzip
  --publish-source-maps   sirve los .map (por defecto no, como en S3)
  --hsts-preload          añade "preload" a HSTS (igual que -c hstsPreload=true en CDK)
  --strict-style          CSP sin 'unsafe-inline' en style-src (igual que -c strictStyleSrc=true en CDK)
`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  const server = createProdLikeServer(options);
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(options.port, options.host, resolveListen);
  });
  const address = server.address();
  const url = `http://${options.host}:${typeof address === 'object' && address ? address.port : options.port}`;
  console.log(`Servidor prod-like escuchando en ${url}`);
  console.log(`PROD_LIKE_URL=${url}`);
  console.log(
    `Sirviendo ${resolve(options.dir)} con las cabeceras de producción. Ctrl+C para salir.`,
  );
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
