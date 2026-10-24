import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) } },
  test: {
    environment: 'node',
    // Tests that start real programs (Git) are slow when 30 files run in parallel on a busy machine.
    testTimeout: 20_000,
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    exclude: ['test/fixtures/**', '**/node_modules/**'],
    setupFiles: ['test/setup.ts'],
  },
});
