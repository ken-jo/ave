import { defineConfig } from '@playwright/test';

// Keep screenshot capture separate from the E2E runner.
export default defineConfig({
  testDir: '.',
  testMatch: /capture\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
  },
});
