import { test, expect } from './fixtures.js';
import { TEST_IDS } from '../../../src/shared/test-ids.js';

for (const locale of ['en', 'ko'] as const) {
  test.describe(`automatic approval pause (${locale})`, () => {
    test.use({ seedLocale: locale, seedViewFixturePlugin: false });

    test('shows the pause and resume explanation in the existing approval card', async ({ app, mainWindow, t }, testInfo) => {
      const sessionId = await mainWindow.evaluate(async () => {
        const api = (window as unknown as {
          aveApi: { chatSessions: (options: { kind: string }) => Promise<{ current?: string }> };
        }).aveApi;
        const sessions = await api.chatSessions({ kind: 'main' });
        if (!sessions.current) throw new Error('Current session is unavailable');
        return sessions.current;
      });
      const reason = t('permissionJudge.pausedConsecutive');
      await app.evaluate(({ BrowserWindow }, input) => {
        const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && candidate.isVisible());
        if (!window) throw new Error('Approval window is unavailable');
        window.webContents.send('ave:approval:request', {
          id: 'automatic-approval-paused', sessionId: input.sessionId,
          category: 'tool', kind: 'tool', toolName: 'bash', toolCategory: 'shell', source: 'builtin',
          trustOrigin: 'llm-tool-arg', args: { command: 'echo reviewed' }, reason: input.reason,
          createdAt: Date.now(), requireExplicit: true, mode: 'auto',
          reviewerVerdict: { level: 'medium', reason: input.reason },
          allowedChoices: ['allow-once', 'deny-once'],
        });
      }, { sessionId, reason });
      const dock = mainWindow.getByTestId(TEST_IDS.approvalDock).first();
      await expect(dock).toBeVisible();
      await expect(dock.getByText(reason, { exact: true })).toBeVisible();
      await mainWindow.screenshot({ path: testInfo.outputPath('automatic-approval-paused.png') });
    });
  });
}
