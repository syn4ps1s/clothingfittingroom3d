// Configuración de Vite SÓLO para el arnés de capturas: construye `mirror-harness.html` (sin HMR ni
// re-optimización de dependencias, que recargarían la página en mitad de una captura).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export default defineConfig({
  root: webDir,
  plugins: [react()],
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
    minify: false,
    emptyOutDir: true,
    outDir: process.env.SHOOT_OUT_DIR ?? resolve(webDir, '../../.scratch/mirror/dist'),
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: resolve(webDir, 'src/mirror/dev/mirror-harness.html') },
  },
  worker: { format: 'es' },
});
