#!/usr/bin/env node
// Descarga los modelos de pose de MediaPipe con verificación SHA-256 (cadena de suministro)
// y copia los binarios WASM del paquete npm. Todo se sirve desde el propio origen: ningún
// dato de cámara ni petición a CDNs de terceros en tiempo de ejecución.
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webPublic = resolve(root, 'apps/web/public');

const BASE = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker';
const MODELS = [
  {
    file: 'pose_landmarker_lite.task',
    url: `${BASE}/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
    sha256: '59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a',
  },
  {
    file: 'pose_landmarker_full.task',
    url: `${BASE}/pose_landmarker_full/float16/1/pose_landmarker_full.task`,
    sha256: '5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1',
  },
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function ensureModel({ file, url, sha256: expected }) {
  const dest = resolve(webPublic, 'models', file);
  if (existsSync(dest) && sha256(await readFile(dest)) === expected) {
    console.log(`✓ ${file} (cacheado, checksum OK)`);
    return;
  }
  console.log(`↓ ${file}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} al descargar ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = sha256(buf);
  if (actual !== expected) {
    throw new Error(`Checksum inválido para ${file}: esperado ${expected}, obtenido ${actual}`);
  }
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  console.log(`✓ ${file} (${(buf.length / 1e6).toFixed(1)} MB, checksum OK)`);
}

async function copyWasm() {
  // El paquete no expone package.json en `exports`; se localiza por ruta (pnpm enlaza node_modules del paquete).
  const pkgDir = resolve(root, 'packages/pose/node_modules/@mediapipe/tasks-vision');
  const src = resolve(pkgDir, 'wasm');
  if (!existsSync(src) || !(await stat(src)).isDirectory()) {
    console.warn(
      '! @mediapipe/tasks-vision aún no instalado (ejecuta `pnpm install`); omito copia de WASM',
    );
    return;
  }
  const dest = resolve(webPublic, 'wasm');
  await mkdir(dest, { recursive: true });
  await cp(src, dest, { recursive: true });
  console.log('✓ WASM de MediaPipe copiado a apps/web/public/wasm');
}

// Node 22 + proxy corporativo: fetch nativo requiere NODE_USE_ENV_PROXY=1
await copyWasm();
for (const m of MODELS) await ensureModel(m);
