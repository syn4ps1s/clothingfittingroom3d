import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Holgado a propósito: los tests son deterministas pero el equipo es compartido (CPU variable).
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/test-helpers.ts'],
      reporter: ['text-summary', 'text'],
    },
  },
});
