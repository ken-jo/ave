import { test, expect } from './fixtures.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';

test('round budget rejects invalid drafts and persists its inclusive maximum', async ({ app, mainWindow }) => {
  const page = await openInlineSettings(app, mainWindow, 'chat');
  const input = page.getByTestId('subagent-max-rounds-input');
  const read = () => page.evaluate(async () => (await window.aveApi.getSettings()).chat.subAgentMaxRounds);
  const initial = await read(); await input.fill('-5'); await input.press('Tab');
  await expect(input).toHaveAttribute('aria-invalid', 'true'); expect(await read()).toBe(initial);
  await input.fill('1000'); await input.press('Tab'); await expect.poll(read).toBe(1000);
  await expect(input).toHaveValue('1000');
  await page.screenshot({ path: 'test-results/settings-round-budget.png' });
  await closeInlineSettings(app, page);
});
