import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // los tests que construyen cuerpos de @fitroom/body (≈ 0.5–1 s cada uno) necesitan holgura
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // el adaptador MediaPipe se valida con el test de navegador (browser-test/run.mjs) y con simulacros;
      // `testing.ts` son utilidades de prueba
      exclude: ['src/**/*.test.ts', 'src/testing.ts', 'src/index.ts'],
      reporter: ['text-summary', 'text'],
    },
  },
});
