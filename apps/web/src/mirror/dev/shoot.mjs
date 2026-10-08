// Captura capturas del espejo en Chromium headless (SwiftShader) con el arnés `mirror-harness.html`.
// Herramienta de DESARROLLO (no se incluye en el bundle). Uso:
//
//   node apps/web/src/mirror/dev/shoot.mjs --out .scratch/mirror/run1 \
//        --shots a-pose:1500,arms-up:4500,turn:9500,sit:14500 \
//        [--garments tee-essential] [--size M] [--variant 0] [--quality medium] [--doubles] \
//        [--m a|b|small|large] [--mirrored 0] [--mode scan] [--source synthetic] [--wait 3500]
//
// Cada toma produce <out>/<nombre>.png (pantalla completa) y <out>/<nombre>-composite.png (captura()
// exacta del compuesto). Imprime el HUD y los errores de consola.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, '../../..');
const webRequire = createRequire(resolve(webDir, 'package.json'));

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) o[k] = true;
    else {
      o[k] = next;
      i++;
    }
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
const out = resolve(String(args.out ?? '.scratch/mirror/run'));
const shots = String(args.shots ?? 'a-pose:1500')
  .split(',')
  .map((s) => {
    const [name, ms] = s.split(':');
    return { name, ms: Number(ms) };
  });
const port = Number(args.port ?? 5199);
const waitMs = Number(args.wait ?? 3500);
const [vw, vh] = String(args.viewport ?? '1280x720').split('x').map(Number);

const q = new URLSearchParams();
for (const k of ['garments', 'size', 'variant', 'quality', 'm', 'mirrored', 'mode', 'source', 'occluder']) {
  if (args[k] !== undefined) q.set(k, String(args[k]));
}
if (args.doubles) q.set('doubles', '1');
if (args.slow !== '0') q.set('slow', '1');
const url = `http://127.0.0.1:${port}/src/mirror/dev/mirror-harness.html?${q}`;

/** Construye el arnés con Vite (producción: sin HMR) y lo sirve con un servidor estático mínimo. */
async function startServer() {
  const outDir = resolve(out, '..', 'dist');
  const viteJs = resolve(dirname(webRequire.resolve('vite/package.json')), 'bin/vite.js');
  if (!args.nobuild) {
    await new Promise((res, rej) => {
      const b = spawn(
        process.execPath,
        [viteJs, 'build', '--config', resolve(here, 'vite.shoot.config.mjs')],
        { cwd: webDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SHOOT_OUT_DIR: outDir } },
      );
      let log = '';
      b.stdout.on('data', (d) => (log += d));
      b.stderr.on('data', (d) => (log += d));
      b.on('exit', (c) => (c === 0 ? res() : rej(new Error(`vite build falló:\n${log}`))));
    });
  }
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.task': 'application/octet-stream',
    '.png': 'image/png',
  };
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/src/mirror/dev/mirror-harness.html';
      const file = resolve(outDir, '.' + p);
      if (!file.startsWith(outDir)) {
        res.statusCode = 403;
        return res.end();
      }
      const body = await readFile(file);
      res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return server;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
try {
  await mkdir(out, { recursive: true });
  server = await startServer();
  const { chromium } = webRequire('@playwright/test');
  const chromiumArgs = [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ];
  if (args.fakecam) {
    chromiumArgs.push(
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${resolve(String(args.fakecam))}`,
    );
  }
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: chromiumArgs,
  });
  const page = await browser.newPage({ viewport: { width: vw, height: vh } });
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(url, { waitUntil: 'load' });
  if (args.fakecam) {
    await page.waitForSelector('#start-camera', { timeout: 30000 });
    await page.click('#start-camera');
  }
  const t0 = Date.now();
  await page.waitForFunction(
    () => window.__mirror && window.__mirror.models.status === 'ready',
    null,
    { timeout: Number(args.timeout ?? 180000), polling: 500 },
  );
  process.stdout.write(`modelos listos en ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
  const dumpLogs = () => {
    const uniq = [...new Set(logs)].slice(0, 60);
    if (uniq.length) process.stdout.write(`--- consola ---\n${uniq.join('\n')}\n`);
  };
  process.on('uncaughtException', (e) => {
    dumpLogs();
    throw e;
  });
  for (const s of shots) {
    if (!args.fakecam && args.source !== 'camera') {
      await page.evaluate((ms) => window.__mirror.seek(ms), s.ms);
    }
    await sleep(waitMs);
    const hud = await page.evaluate(() => document.getElementById('hud')?.textContent ?? '');
    await page.screenshot({ path: resolve(out, `${s.name}.png`) });
    const dataUrl = await page.evaluate(() => window.__mirror.capture());
    await writeFile(
      resolve(out, `${s.name}-composite.png`),
      Buffer.from(dataUrl.split(',')[1], 'base64'),
    );
    process.stdout.write(`${s.name} @${s.ms} ms · ${hud}\n`);
  }
  if (args.logs !== '0') {
    const uniq = [...new Set(logs)].slice(0, 40);
    if (uniq.length) process.stdout.write(`--- consola ---\n${uniq.join('\n')}\n`);
  }
  await browser.close();
} finally {
  server?.close();
}
