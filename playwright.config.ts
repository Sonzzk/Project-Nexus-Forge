import { defineConfig } from '@playwright/test';

// End-to-end tests drive the built Electron app (run `npm run build` first, or use `npm run test:e2e`).
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.e2e.ts',
  workers: 1,
  timeout: 30_000,
  reporter: 'list',
});
