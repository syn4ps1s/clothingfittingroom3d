// Renderiza mallas (arrays planos) a un PNG multivista con three.js en Chromium headless (SwiftShader).
// Herramienta de DESARROLLO para verificar visualmente cuerpo/prendas. No se incluye en el bundle de la app.
//
//   import { renderMeshes } from '../scripts/lib/render-meshes.mjs';
//   await renderMeshes({
//     out: '.scratch/body.png',
//     views: ['front', 'side', 'back', 'three-quarter'],   // o [{ name, eye:[x,y,z], target:[x,y,z], fov }]
//     size: 640,                                            // lado de cada vista
//     meshes: [{ positions, normals, indices, color: '#c9a46c', opacity: 1, wireframe: false, roughness: 0.6 }],
//     target: [0, 0.9, 0], distance: 3.2,                   // opcional
//   });
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const webRequire = createRequire(resolve(root, 'apps/web/package.json'));
const threeDir = realpathSync(resolve(root, 'apps/web/node_modules/three'));

const PRESETS = {
  front: { dir: [0, 0, 1] },
  back: { dir: [0, 0, -1] },
  side: { dir: [1, 0, 0] },
  'three-quarter': { dir: [0.7, 0.15, 0.7] },
  top: { dir: [0, 1, 0.001] },
};

const toArr = (a) => (a ? Array.from(a) : undefined);

const HTML = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#1b1d22}</style>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js"}}</script>
<canvas id="c"></canvas>
<script type="module">
import * as THREE from 'three';
const spec = await (await fetch('/spec.json')).json();
const S = spec.size, N = spec.views.length;
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1); renderer.setSize(S * N, S, false);
renderer.setScissorTest(true);
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x23262d);
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a2f28, 1.1));
const key = new THREE.DirectionalLight(0xfff1dd, 2.4); key.position.set(2, 4, 3); scene.add(key);
const rim = new THREE.DirectionalLight(0x9db8ff, 1.0); rim.position.set(-3, 2, -2); scene.add(rim);
const grid = new THREE.GridHelper(4, 16, 0x555b66, 0x363b44); scene.add(grid);
for (const m of spec.meshes) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m.positions), 3));
  if (m.normals) g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(m.normals), 3));
  if (m.uvs) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(m.uvs), 2));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(m.indices), 1));
  if (!m.normals) g.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: m.color ?? '#c9a46c', roughness: m.roughness ?? 0.6, metalness: 0,
    wireframe: !!m.wireframe, transparent: (m.opacity ?? 1) < 1, opacity: m.opacity ?? 1,
    side: m.doubleSide ? THREE.DoubleSide : THREE.FrontSide, flatShading: !!m.flat,
  });
  scene.add(new THREE.Mesh(g, mat));
}
const target = new THREE.Vector3(...spec.target);
spec.views.forEach((v, i) => {
  const cam = new THREE.PerspectiveCamera(v.fov ?? 30, 1, 0.05, 50);
  cam.position.set(...v.eye); cam.lookAt(target);
  renderer.setViewport(i * S, 0, S, S); renderer.setScissor(i * S, 0, S, S);
  renderer.render(scene, cam);
});
window.__done = true;
</script>`;

export async function renderMeshes(spec) {
  const {
    out,
    meshes,
    views = ['front', 'side', 'back', 'three-quarter'],
    size = 560,
    target = [0, 0.9, 0],
    distance = 4.2,
  } = spec;
  const resolvedViews = views.map((v) => {
    if (typeof v !== 'string') return v;
    const p = PRESETS[v];
    if (!p) throw new Error(`vista desconocida: ${v}`);
    const n = Math.hypot(...p.dir);
    return {
      name: v,
      eye: [
        target[0] + (p.dir[0] / n) * distance,
        target[1] + (p.dir[1] / n) * distance,
        target[2] + (p.dir[2] / n) * distance,
      ],
      fov: 30,
    };
  });
  const payload = JSON.stringify({
    size,
    target,
    views: resolvedViews,
    meshes: meshes.map((m) => ({
      ...m,
      positions: toArr(m.positions),
      normals: toArr(m.normals),
      uvs: toArr(m.uvs),
      indices: toArr(m.indices),
    })),
  });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x').pathname;
      if (url === '/') {
        res.setHeader('content-type', 'text/html');
        return res.end(HTML);
      }
      if (url === '/spec.json') {
        res.setHeader('content-type', 'application/json');
        return res.end(payload);
      }
      if (url.startsWith('/three/')) {
        const file = resolve(threeDir, '.' + url.slice('/three'.length));
        if (!file.startsWith(threeDir)) {
          res.statusCode = 403;
          return res.end();
        }
        res.setHeader('content-type', 'text/javascript');
        return res.end(await readFile(file));
      }
      res.statusCode = 404;
      res.end();
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const { chromium } = webRequire('@playwright/test');
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: [
      '--no-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: size * resolvedViews.length, height: size },
    });
    page.on('pageerror', (e) => {
      throw e;
    });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction('window.__done === true', null, { timeout: 60000 });
    await mkdir(dirname(resolve(out)), { recursive: true });
    await page.screenshot({ path: resolve(out) });
  } finally {
    await browser.close();
    server.close();
  }
  return resolve(out);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [specPath, out] = process.argv.slice(2);
  if (!specPath || !out) {
    console.error('uso: node scripts/lib/render-meshes.mjs spec.json out.png');
    process.exit(2);
  }
  const spec = JSON.parse(await readFile(specPath, 'utf8'));
  console.log(await renderMeshes({ ...spec, out }));
}
