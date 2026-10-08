import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['cdk.out/**', 'node_modules/**'],
    // Sintetizar stacks con BucketDeployment (capas de aws-cli) tarda unos segundos en CI.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts', 'bin/**/*.ts'],
      reporter: ['text', 'json-summary', 'lcov'],
    },
  },
});
