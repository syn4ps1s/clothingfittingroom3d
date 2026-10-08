import { defineConfig } from '@playwright/test';

/**
 * E2E contra el servidor de desarrollo de Vite. Chromium del entorno (sin GPU): WebGL2 por SwiftShader.
 * Cámara falsa de Chromium para los recorridos que usan getUserMedia real; la app corre con `?mock=1`
 * (cámara, escaneo y espejo simulados) en los recorridos de interfaz.
 */
const PORT = Number(process.env.E2E_PORT ?? 5173);

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: '../../.scratch/world/test-results',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'off',
    launchOptions: {
      executablePath: '/opt/pw-browsers/chromium',
      args: [
        '--no-sandbox',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
      ],
    },
  },
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
