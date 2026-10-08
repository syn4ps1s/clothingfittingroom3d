import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // buildBody tarda ~0,3 s por cuerpo; las propiedades construyen varios
    testTimeout: 180_000,
    hookTimeout: 180_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test-helpers.ts'],
      reporter: ['text-summary', 'text'],
    },
  },
});
