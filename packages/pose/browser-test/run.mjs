#!/usr/bin/env node
// Test de integración en navegador (Chromium headless, CPU) del adaptador MediaPipe contra una FOTO REAL.
//
//   node packages/pose/browser-test/run.mjs [ruta/a/foto.png]
//
// La foto por defecto es `skimage.data.astronaut()` guardada como PNG en `.scratch/pose/astronaut.png`
// (ver README abajo). Sin foto o sin modelos el test se OMITE con un mensaje claro (código de salida 0
// sólo con --optional; en caso contrario 2).
//
// Genera la foto (fuera del repo):  python3 -I -m venv V && V/bin/pip install scikit-image &&
//   V/bin/python -I -c "from skimage import data, io; io.imsave('astronaut.png', data.astronaut())"
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const publicDir = join(repo, 'apps/web/public');
const outDir = join(repo, '.scratch/pose/browser-bundle');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const optional = process.argv.includes('--optional');
const imagePath = resolve(args[0] ?? process.env.POSE_TEST_IMAGE ?? join(repo, '.scratch/pose/astronaut.png'));
const MODEL = process.env.POSE_MODEL ?? 'pose_landmarker_full.task';
const DELEGATE = process.env.POSE_DELEGATE ?? 'CPU';

const skip = (why) => {
  console.warn(`SKIP: ${why}`);
  process.exit(optional ? 0 : 2);
};
if (!existsSync(imagePath)) skip(`no existe la foto de prueba ${imagePath}`);
if (!existsSync(join(publicDir, 'models', MODEL))) {
  skip(`faltan los modelos: NODE_USE_ENV_PROXY=1 node scripts/fetch-models.mjs`);
}

await build({
  entryPoints: [join(here, 'entry.ts')],
  outdir: join(outDir, 'bundle'),
  bundle: true,
  format: 'esm',
  splitting: true,
  platform: 'browser',
  target: 'es2022',
  sourcemap: false,
  logLevel: 'warning',
});

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.png': 'image/png',
};
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file;
  if (url.pathname === '/') file = join(here, 'page.html');
  else if (url.pathname === '/photo.png') file = imagePath;
  else if (url.pathname.startsWith('/bundle/')) file = join(outDir, url.pathname);
  else file = join(publicDir, url.pathname);
  if (!file.startsWith(outDir) && !file.startsWith(publicDir) && file !== imagePath && !file.startsWith(here)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  headless: true,
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    ...(process.env.POSE_NO_WEBGL ? ['--disable-gpu', '--disable-3d-apis', '--disable-webgl'] : []),
  ],
});
let exitCode = 0;
try {
  const page = await browser.newPage();
  const errors = [];
  const external = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('request', (r) => {
    if (!r.url().startsWith(`http://127.0.0.1:${port}`) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) {
      external.push(r.url());
    }
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => !!window.__pose, null, { timeout: 15000 });
  const result = await page.evaluate(
    async ({ model, delegate }) => {
      const { createMediaPipePoseProvider, PoseProviderError } = window.__pose;
      const img = new Image();
      img.src = '/photo.png';
      await img.decode();
      const out = { delegate: null, fallback: null, initMs: 0, detectMs: [], frame: null, errors: {} };
      // 1) errores tipados
      const bad = createMediaPipePoseProvider({ modelUrl: '/models/no-existe.task', wasmBaseUrl: '/wasm' });
      try {
        await bad.init();
        out.errors.missingModel = 'NO LANZÓ';
      } catch (e) {
        out.errors.missingModel = e instanceof PoseProviderError ? e.code : `cruda: ${e}`;
      }
      const bad2 = createMediaPipePoseProvider({ modelUrl: '/models/' + model, wasmBaseUrl: '/wasm-no-existe' });
      try {
        await bad2.init();
        out.errors.missingWasm = 'NO LANZÓ';
      } catch (e) {
        out.errors.missingWasm = e instanceof PoseProviderError ? e.code : `cruda: ${e}`;
      }
      try {
        createMediaPipePoseProvider({ modelUrl: '/models/' + model, wasmBaseUrl: '/wasm' }).detect(img, 1);
        out.errors.detectBeforeInit = 'NO LANZÓ';
      } catch (e) {
        out.errors.detectBeforeInit = e instanceof PoseProviderError ? e.code : `cruda: ${e}`;
      }
      // 2) detección real sobre la foto (modo IMAGE)
      const p = createMediaPipePoseProvider({
        modelUrl: '/models/' + model,
        wasmBaseUrl: '/wasm',
        runningMode: 'IMAGE',
        outputSegmentationMask: true,
        delegate,
        onDelegateFallback: (r) => (out.fallback = String(r)),
      });
      const t0 = performance.now();
      await p.init();
      out.initMs = performance.now() - t0;
      out.delegate = p.delegate;
      for (let i = 0; i < 5; i++) {
        const t1 = performance.now();
        const f = p.detect(img, 1000 + i);
        out.detectMs.push(performance.now() - t1);
        if (i === 0) {
          out.frame = f && {
            ...f,
            mask: f.mask && { width: f.mask.width, height: f.mask.height, data: Array.from(f.mask.data) },
          };
        }
      }
      p.dispose();
      p.dispose();
      out.blocked = [...p.blockedRequests];
      out.afterDispose = p.detect(img, 99999);
      // 3) modo VIDEO con timestamps repetidos / hacia atrás (MediaPipe lanza si no son monótonos)
      const v = createMediaPipePoseProvider({
        modelUrl: '/models/' + model,
        wasmBaseUrl: '/wasm',
        runningMode: 'VIDEO',
        delegate,
      });
      await v.init();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      const stamps = [100, 100, 133, 90, 166, NaN, 200];
      out.video = stamps.map((ts) => {
        try {
          const f = v.detect(canvas, ts);
          return f ? 'frame' : 'null';
        } catch (e) {
          return `LANZÓ ${e}`;
        }
      });
      out.videoLastError = v.lastError ? String(v.lastError) : null;
      v.dispose();
      return out;
    },
    { model: MODEL, delegate: DELEGATE },
  );
  console.log(JSON.stringify({ port, external, pageErrors: errors.slice(0, 5), ...result, frame: undefined }, null, 2));
  if (!result.frame) {
    console.error('FALLO: no se detectó ninguna persona en la foto');
    exitCode = 1;
  } else {
    const f = result.frame;
    const LM = {
      nose: 0, l_ear: 7, r_ear: 8, l_shoulder: 11, r_shoulder: 12, l_elbow: 13, r_elbow: 14,
      l_wrist: 15, r_wrist: 16, l_hip: 23, r_hip: 24, l_knee: 25, r_knee: 26, l_ankle: 27, r_ankle: 28,
    };
    const fmt = (i) => {
      const l = f.image[i], w = f.world[i];
      return `${i.toString().padStart(2)} img(${l.x.toFixed(3)}, ${l.y.toFixed(3)}, ${l.z.toFixed(3)}) vis=${l.visibility.toFixed(2)}  world(${w.x.toFixed(3)}, ${w.y.toFixed(3)}, ${w.z.toFixed(3)})`;
    };
    for (const [k, i] of Object.entries(LM)) console.log(k.padEnd(11), fmt(i));
    if (f.mask) {
      const d = f.mask.data;
      console.log(`mask ${f.mask.width}x${f.mask.height} max=${Math.max(...d)} >128: ${d.filter((v) => v > 128).length} px (${((100 * d.filter((v) => v > 128).length) / d.length).toFixed(1)} %)`);
    } else console.log('mask: ausente');
    const checks = [];
    const ok = (name, cond) => checks.push([name, !!cond]);
    const im = (n) => f.image[LM[n]];
    const w = (n) => f.world[LM[n]];
    ok('personCount === 1', f.personCount === 1);
    ok('33 landmarks image/world', f.image.length === 33 && f.world.length === 33);
    ok('nariz más arriba que los hombros', im('nose').y < im('l_shoulder').y && im('nose').y < im('r_shoulder').y);
    ok('hombros más arriba que los codos', im('l_shoulder').y < im('l_elbow').y && im('r_shoulder').y < im('r_elbow').y);
    ok('codos más arriba que las muñecas', im('l_elbow').y < im('l_wrist').y && im('r_elbow').y < im('r_wrist').y);
    ok('muñecas más arriba que las caderas (orden vertical, caderas extrapoladas)', im('l_wrist').y < im('l_hip').y + 0.35);
    ok('hombro izq. persona a la DERECHA de la imagen (sin espejar)', im('l_shoulder').x > im('r_shoulder').x);
    ok('world: hombro izq. con +X', w('l_shoulder').x > w('r_shoulder').x);
    ok('world: hombros por encima (Y) de las caderas', w('l_shoulder').y > w('l_hip').y && w('r_shoulder').y > w('r_hip').y);
    ok('world: nariz por encima de los hombros', w('nose').y > w('l_shoulder').y);
    ok('visibilidad de hombros > 0.8', im('l_shoulder').visibility > 0.8 && im('r_shoulder').visibility > 0.8);
    ok('piernas con visibilidad baja (foto de medio cuerpo)', im('l_ankle').visibility < 0.5 && im('r_ankle').visibility < 0.5);
    ok('ancho de hombros world 0.25–0.55 m', Math.abs(w('l_shoulder').x - w('r_shoulder').x) > 0.25 && Math.abs(w('l_shoulder').x - w('r_shoulder').x) < 0.55);
    ok('máscara presente', f.mask && f.mask.width > 0 && f.mask.data.some((v) => v > 200));
    ok('delegado CPU/GPU reportado', result.delegate === 'CPU' || result.delegate === 'GPU');
    ok('sin peticiones a hosts externos (la telemetría de MediaPipe se bloquea)', external.length === 0 && result.blocked.length > 0);
    ok('error tipado: modelo inexistente', result.errors.missingModel === 'model-load-failed');
    ok('error tipado: WASM inexistente', ['wasm-unsupported', 'init-failed'].includes(result.errors.missingWasm));
    ok('error tipado: detect antes de init', result.errors.detectBeforeInit === 'not-initialized');
    ok('dispose idempotente y detect posterior = null', result.afterDispose === null);
    ok('VIDEO con timestamps repetidos/atrás no lanza', result.video.every((s) => !s.startsWith('LANZÓ')));
    for (const [name, pass] of checks) console.log(pass ? '  ok  ' : '  FAIL', name);
    if (checks.some(([, pass]) => !pass)) exitCode = 1;
    console.log(`init ${result.initMs.toFixed(0)} ms (${result.delegate}); detect ms: ${result.detectMs.map((x) => x.toFixed(0)).join(', ')}`);
    if (process.env.POSE_DUMP) {
      (await import('node:fs')).writeFileSync(process.env.POSE_DUMP, JSON.stringify(f));
    }
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(exitCode);
