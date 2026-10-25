import { test, expect } from './fixtures.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';

// Verify telemetry controls can revise stored consent and endpoint values through the real settings service.
test('the telemetry controls round-trip through the real settings service', async ({ app, mainWindow }) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'audit');

  const readTelemetry = () =>
    settingsPage.evaluate(async () => {
      const api = (window as unknown as {
        aveApi: { getSettings: () => Promise<unknown> };
      }).aveApi;
      const settings = (await api.getSettings()) as {
        telemetry?: { enabled?: boolean; endpoint?: string; telemetryPromptAnswered?: boolean };
      };
      return settings.telemetry ?? {};
    });

  const toggle = settingsPage.getByTestId('telemetry-enabled');
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  // Show endpoint bounds beside the control.
  await expect(settingsPage.getByTestId('telemetry-allowed-hosts')).toContainText('localhost');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(readTelemetry).toMatchObject({ enabled: true, telemetryPromptAnswered: true });

  const endpoint = settingsPage.getByTestId('telemetry-endpoint');
  await endpoint.fill('  https://localhost/v1  ');
  await settingsPage.getByTestId('telemetry-endpoint-save').click();
  await expect.poll(readTelemetry).toMatchObject({ endpoint: 'https://localhost/v1' });

  // Persist clearing as no destination, never an empty URL the transport might POST to.
  await endpoint.fill('');
  await settingsPage.getByTestId('telemetry-endpoint-save').click();
  await expect.poll(async () => (await readTelemetry()).endpoint).toBeUndefined();

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect.poll(readTelemetry).toMatchObject({ enabled: false, telemetryPromptAnswered: true });

  await closeInlineSettings(app, settingsPage);
});
