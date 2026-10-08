import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatSmokeResult, runSmokeTests } from '../lib/smoke';
import { buildSecurityHeaders } from '../lib/security-headers';
import { CACHE_IMMUTABLE, CACHE_NO_CACHE, CACHE_REVALIDATE } from '../lib/asset-policy';
import { FIXTURE_DIST, INFRA_DIR, REPO_ROOT } from './helpers';

const SERVER_SCRIPT = resolve(REPO_ROOT, 'scripts/serve-prod-like.mjs');

interface RunningServer {
  readonly url: string;
  readonly stop: () => Promise<void>;
}

/** Arranca el script REAL como proceso hijo (puerto aleatorio) y espera su línea PROD_LIKE_URL=. */
async function startProdLike(extraArgs: string[] = []): Promise<RunningServer> {
  const child: ChildProcess = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      SERVER_SCRIPT,
      '--port',
      '0',
      '--dir',
      FIXTURE_DIST,
      '--quiet',
      ...extraArgs,
    ],
    { cwd: INFRA_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const url = await new Promise<string>((resolveUrl, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`El servidor no arrancó: ${output}`)), 30_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = /PROD_LIKE_URL=(\S+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolveUrl(match[1]!);
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.once('exit', (code) =>
      reject(new Error(`El servidor terminó con código ${code}: ${output}`)),
    );
  });
  return {
    url,
    stop: () =>
      new Promise((done) => {
        child.once('exit', () => done());
        child.kill('SIGTERM');
      }),
  };
}

let server: RunningServer;
beforeAll(async () => {
  server = await startProdLike();
});
afterAll(async () => {
  await server.stop();
});

describe('serve-prod-like: mismas cabeceras que CloudFront', () => {
  it('sirve EXACTAMENTE las cabeceras de la fuente única en / (y en cualquier ruta, error o 304)', async () => {
    const expected = buildSecurityHeaders();
    for (const path of [
      '/',
      '/index.html',
      '/ruta/profunda/sin/archivo',
      '/assets/index-4f2a1c9e.js',
      '/wasm/vision_wasm_internal.wasm',
    ]) {
      const response = await fetch(`${server.url}${path}`);
      await response.arrayBuffer();
      for (const [name, value] of Object.entries(expected)) {
        expect(response.headers.get(name), `${path} → ${name}`).toBe(value);
      }
    }
    // 304
    const first = await fetch(`${server.url}/`);
    const etag = first.headers.get('etag')!;
    await first.arrayBuffer();
    const cached = await fetch(`${server.url}/`, { headers: { 'if-none-match': etag } });
    expect(cached.status).toBe(304);
    for (const [name, value] of Object.entries(expected))
      expect(cached.headers.get(name), `304 → ${name}`).toBe(value);
    // errores
    const post = await fetch(`${server.url}/`, { method: 'POST', body: 'x' });
    expect(post.status).toBe(403);
    for (const [name, value] of Object.entries(expected))
      expect(post.headers.get(name), `403 → ${name}`).toBe(value);
  });

  it('--strict-style sirve exactamente la variante estricta de la fuente única', async () => {
    const strict = await startProdLike(['--strict-style']);
    try {
      const response = await fetch(`${strict.url}/`);
      await response.arrayBuffer();
      const expected = buildSecurityHeaders({ strictStyles: true });
      for (const [name, value] of Object.entries(expected))
        expect(response.headers.get(name), name).toBe(value);
      const smoke = await runSmokeTests({
        baseUrl: strict.url,
        distDir: FIXTURE_DIST,
        retries: 0,
        strictStyles: true,
      });
      expect(smoke.ok, formatSmokeResult(smoke)).toBe(true);
      // y el smoke test con la variante por defecto la rechaza (detecta CSP distinta de la esperada)
      const mismatch = await runSmokeTests({ baseUrl: strict.url, retries: 0 });
      expect(mismatch.ok).toBe(false);
    } finally {
      await strict.stop();
    }
  });

  it('MIME y Cache-Control por clase (wasm, task, JS con hash, HTML)', async () => {
    const head = async (path: string) => fetch(`${server.url}${path}`, { method: 'HEAD' });
    const wasm = await head('/wasm/vision_wasm_internal.wasm');
    expect(wasm.headers.get('content-type')).toBe('application/wasm');
    expect(wasm.headers.get('cache-control')).toBe(CACHE_REVALIDATE);
    const task = await head('/models/pose_landmarker_lite.task');
    expect(task.headers.get('content-type')).toBe('application/octet-stream');
    expect(task.headers.get('cache-control')).toBe(CACHE_REVALIDATE);
    const loader = await head('/wasm/vision_wasm_internal.js');
    expect(loader.headers.get('content-type')).toMatch(/^text\/javascript/);
    const js = await head('/assets/index-4f2a1c9e.js');
    expect(js.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(js.headers.get('cache-control')).toBe(CACHE_IMMUTABLE);
    const css = await head('/assets/index-4f2a1c9e.css');
    expect(css.headers.get('content-type')).toMatch(/^text\/css/);
    const html = await head('/');
    expect(html.headers.get('content-type')).toMatch(/^text\/html/);
    expect(html.headers.get('cache-control')).toBe(CACHE_NO_CACHE);
  });

  it('fallback SPA: rutas desconocidas devuelven index.html con 200; los .map no se publican', async () => {
    const deep = await fetch(`${server.url}/probador/talla/ruta`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('<title>Probador 3D (fixture)</title>');
    const map = await fetch(`${server.url}/assets/index-4f2a1c9e.js.map`);
    expect(map.headers.get('content-type')).toMatch(/^text\/html/);
    await map.arrayBuffer();
  });

  it('ETag, 304 con If-None-Match e If-Modified-Since, y Range', async () => {
    const response = await fetch(`${server.url}/assets/index-4f2a1c9e.css`);
    const etag = response.headers.get('etag')!;
    const modified = response.headers.get('last-modified')!;
    await response.arrayBuffer();
    expect(
      (
        await fetch(`${server.url}/assets/index-4f2a1c9e.css`, {
          headers: { 'if-none-match': etag },
        })
      ).status,
    ).toBe(304);
    expect(
      (
        await fetch(`${server.url}/assets/index-4f2a1c9e.css`, {
          headers: { 'if-none-match': '"otro"' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${server.url}/assets/index-4f2a1c9e.css`, {
          headers: { 'if-modified-since': modified },
        })
      ).status,
    ).toBe(304);
    const partial = await fetch(`${server.url}/wasm/vision_wasm_internal.wasm`, {
      headers: { range: 'bytes=0-3' },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe('bytes 0-3/8');
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(Buffer.from([0x00, 0x61, 0x73, 0x6d]));
    const bad = await fetch(`${server.url}/wasm/vision_wasm_internal.wasm`, {
      headers: { range: 'bytes=100-200' },
    });
    expect(bad.status).toBe(416);
    await bad.arrayBuffer();
  });

  it('seguridad: no sale de la raíz, ignora dotfiles, rechaza codificaciones raras', async () => {
    // Las rutas con «..» se normalizan o se rechazan: nunca se lee fuera de dist.
    for (const path of [
      '/..%2f..%2fetc/passwd',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/..%5c..%5cwindows/win.ini',
      '/%00',
      '/assets/%',
    ]) {
      const response = await fetch(`${server.url}${path}`);
      const body = await response.text();
      expect([200, 400], path).toContain(response.status);
      expect(body, path).not.toMatch(/root:|\[fonts\]/);
    }
    const dot = await fetch(`${server.url}/.env`);
    expect(dot.headers.get('content-type')).toMatch(/^text\/html/); // fallback, no un archivo
    await dot.arrayBuffer();
  });

  it('comprime en Brotli/gzip lo comprimible entre 1 KB y 10 MB (como CloudFront) y respeta --no-compress', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fitroom-compress-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>c</title>');
    const big = `export const data = "${'x'.repeat(5000)}";\n`;
    writeFileSync(join(dir, 'assets/big-abc123.js'), big);
    writeFileSync(join(dir, 'assets/photo-abc123.png'), Buffer.alloc(5000, 1));
    const compressed = await startProdLike(['--dir', dir]);
    const plain = await startProdLike(['--dir', dir, '--no-compress']);
    try {
      const br = await fetch(`${compressed.url}/assets/big-abc123.js`, {
        headers: { 'accept-encoding': 'br, gzip' },
      });
      expect(br.headers.get('content-encoding')).toBe('br');
      expect(br.headers.get('vary')).toBe('Accept-Encoding');
      expect(await br.text()).toBe(big); // fetch descomprime: el contenido es idéntico
      const gz = await fetch(`${compressed.url}/assets/big-abc123.js`, {
        headers: { 'accept-encoding': 'gzip' },
      });
      expect(gz.headers.get('content-encoding')).toBe('gzip');
      expect(gz.headers.get('etag')).toMatch(/-gzip"$/);
      await gz.arrayBuffer();
      const none = await fetch(`${compressed.url}/assets/big-abc123.js`, {
        headers: { 'accept-encoding': 'identity' },
      });
      expect(none.headers.get('content-encoding')).toBeNull();
      await none.arrayBuffer();
      const png = await fetch(`${compressed.url}/assets/photo-abc123.png`, {
        headers: { 'accept-encoding': 'br' },
      });
      expect(png.headers.get('content-encoding')).toBeNull(); // las imágenes ya vienen comprimidas
      await png.arrayBuffer();
      const off = await fetch(`${plain.url}/assets/big-abc123.js`, {
        headers: { 'accept-encoding': 'br' },
      });
      expect(off.headers.get('content-encoding')).toBeNull();
      await off.arrayBuffer();
    } finally {
      await compressed.stop();
      await plain.stop();
    }
  });
});

describe('smoke test (lib/smoke.ts)', () => {
  it('pasa contra el servidor prod-like con el dist del fixture', async () => {
    const result = await runSmokeTests({ baseUrl: server.url, distDir: FIXTURE_DIST, retries: 0 });
    const failures = result.checks.filter((c) => !c.ok && c.severity === 'error');
    expect(failures, formatSmokeResult(result)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checks.length).toBeGreaterThan(40);
  });

  /** Servidor deliberadamente mal configurado: sin CSP, wasm mal etiquetado, sin fallback. */
  async function withBrokenServer<T>(
    handler: Parameters<typeof createServer>[1],
    run: (url: string) => Promise<T>,
  ): Promise<T> {
    const broken: Server = createServer(handler);
    await new Promise<void>((done) => broken.listen(0, '127.0.0.1', done));
    try {
      return await run(`http://127.0.0.1:${(broken.address() as AddressInfo).port}`);
    } finally {
      await new Promise((done) => broken.close(done));
    }
  }

  it('FALLA si faltan las cabeceras de seguridad', async () => {
    await withBrokenServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>x</title>');
      },
      async (url) => {
        const result = await runSmokeTests({ baseUrl: url, retries: 0 });
        expect(result.ok).toBe(false);
        const missing = result.checks.filter((c) => !c.ok).map((c) => c.name);
        expect(missing).toEqual(
          expect.arrayContaining([
            'cabeceras en /: Content-Security-Policy',
            'cabeceras en /: Permissions-Policy',
          ]),
        );
      },
    );
  });

  it('FALLA si la CSP se relaja (p. ej. alguien añade un CDN)', async () => {
    const headers = {
      ...buildSecurityHeaders(),
      'Content-Security-Policy': buildSecurityHeaders()['Content-Security-Policy']!.replace(
        "script-src 'self'",
        "script-src 'self' https://cdn.example.com",
      ),
    };
    await withBrokenServer(
      (_req, res) => {
        res.writeHead(200, {
          ...headers,
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
        });
        res.end('<!doctype html><title>x</title>');
      },
      async (url) => {
        const result = await runSmokeTests({ baseUrl: url, retries: 0 });
        expect(result.ok).toBe(false);
        expect(
          result.checks.find((c) => c.name === 'cabeceras en /: Content-Security-Policy')?.ok,
        ).toBe(false);
      },
    );
  });

  it('FALLA si el servidor no responde (tras reintentos)', async () => {
    const result = await runSmokeTests({
      baseUrl: 'http://127.0.0.1:9',
      retries: 1,
      retryDelayMs: 10,
      timeoutMs: 500,
    });
    expect(result.ok).toBe(false);
    expect(result.checks[0]!.name).toBe('GET / responde 200');
  });
});
