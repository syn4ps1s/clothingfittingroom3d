import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

/**
 * Los demás agentes publican un `STATUS.md` con la palabra READY cuando su parte está lista.
 * Este plugin expone ese estado como módulo virtual para que la app use lo real por defecto
 * y los mocks sólo mientras no esté (o con `?mock=1`). Se vuelve a leer en cada arranque del servidor.
 */
const STATUS_FILES = {
  mirror: 'apps/web/src/mirror/STATUS.md',
  catalog: 'packages/catalog/STATUS.md',
  body: 'packages/body/STATUS.md',
  garmentsGeometry: 'packages/garments/GEOMETRY_STATUS.md',
  garmentsFabric: 'packages/garments/FABRIC_STATUS.md',
} as const;

function isReady(relativePath: string): boolean {
  const file = resolve(repoRoot, relativePath);
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  return /\bREADY\b/.test(text) && !/\b(NOT|NO)[\s_-]+READY\b/i.test(text);
}

function fitroomStatus(): Plugin {
  const id = 'virtual:fitroom-status';
  const resolved = `\0${id}`;
  return {
    name: 'fitroom-status',
    resolveId(source) {
      return source === id ? resolved : undefined;
    },
    load(loaded) {
      if (loaded !== resolved) return undefined;
      const status = Object.fromEntries(
        Object.entries(STATUS_FILES).map(([name, file]) => {
          // Sólo se vigilan los que ya existen (vigilar un archivo ausente rompe el análisis de imports).
          if (existsSync(resolve(repoRoot, file))) this.addWatchFile(resolve(repoRoot, file));
          return [name, isReady(file)];
        }),
      );
      return `export const READY = ${JSON.stringify(status)};`;
    },
  };
}

export default defineConfig({
  plugins: [react(), fitroomStatus()],
  server: { host: '127.0.0.1', port: 5173, strictPort: false },
  preview: { host: '127.0.0.1', port: 4173 },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Separa el motor 3D del código de la app: la bienvenida pinta antes de que three termine de bajar.
        manualChunks(id) {
          if (id.includes('node_modules/three/') || id.includes('node_modules/three-stdlib/')) {
            return 'three';
          }
          if (id.includes('node_modules/postprocessing/')) return 'postprocessing';
          if (id.includes('@react-three/')) return 'r3f';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**'],
    setupFiles: ['./src/test-setup.ts'],
    css: false,
  },
});
