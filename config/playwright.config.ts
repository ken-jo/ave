import { defineConfig } from '@playwright/test';

// UI tests are opt-in via `bun run test:ui-e2e`; the default test suite excludes them.
export default defineConfig({
  testDir: '../test/e2e',
  outputDir: '../test-results',
  testMatch: /.*\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  // Retries absorb residual render-timing variance in performance and scroll specs.
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  // `@os-focus` tests activate native windows. Their project exists only with an explicit opt-in, so a direct
  // `playwright test --config` without `--project` runs the background project alone.
  projects: [
    { name: 'background', grepInvert: /@os-focus/ },
    ...(process.env.AVE_E2E_OS_FOCUS === '1' ? [{ name: 'os-focus', grep: /@os-focus/ }] : []),
  ],
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
});
