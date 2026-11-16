import { test, expect } from './fixtures.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';

// Exercise consent and endpoint refusal through the real settings boundary.
test('reporting levels and authorized destinations round-trip without inactive fields', async ({ app, mainWindow }) => {
  const page = await openInlineSettings(app, mainWindow, 'audit');
  const readTelemetry = () => page.evaluate(async () => (await window.aveApi.getSettings()).telemetry);
  const level = page.getByTestId('telemetry-level');
  await expect(level).toBeEnabled();
  await expect(level).toHaveValue('off');
  await expect(page.getByTestId('telemetry-sentry-dsn')).toHaveCount(0);
  await expect(page.getByTestId('telemetry-allowed-hosts')).toContainText('localhost');
  for (const value of ['crash', 'error', 'all', 'off']) {
    await level.selectOption(value);
    await expect.poll(readTelemetry).toMatchObject({ level: value, enabled: value === 'error' || value === 'all', crashReportingEnabled: value !== 'off', telemetryPromptAnswered: true });
  }
  const endpoint = page.getByTestId('telemetry-endpoint');
  await endpoint.fill('http://localhost/v1');
  await page.getByTestId('telemetry-endpoint-save').click();
  await expect(page.locator('[data-settings-section="audit-telemetry"]').getByRole('alert')).toBeVisible();
  expect((await readTelemetry()).endpoint).toBeUndefined();
  const rejected = await page.evaluate(() => window.aveApi.updateSettings({ telemetry: { crashReportEndpoint: 'http://localhost/crash' } }));
  expect(rejected).toMatchObject({ ok: false, error: 'invalid-telemetry-endpoint' });
  await endpoint.fill('  https://localhost/v1  ');
  await page.getByTestId('telemetry-endpoint-save').click();
  await expect.poll(readTelemetry).toMatchObject({ endpoint: 'https://localhost/v1' });
  await endpoint.fill('');
  await page.getByTestId('telemetry-endpoint-save').click();
  await expect.poll(async () => (await readTelemetry()).endpoint).toBeUndefined();
  await closeInlineSettings(app, page);
});
