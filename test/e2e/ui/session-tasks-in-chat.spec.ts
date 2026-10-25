// Inject a session-owned task update and verify the panel belongs inside chat rather than an overlay.
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

async function currentSessionId(mainWindow: Page): Promise<string> {
  return mainWindow.evaluate(async () => {
    const api = (window as unknown as {
      aveApi?: {
        chatSessions?: (opts?: { kind?: string }) => Promise<{ current?: string }>;
      };
    }).aveApi;
    if (typeof api?.chatSessions !== 'function') {
      throw new Error('window.aveApi.chatSessions unavailable');
    }
    const listed = await api.chatSessions({ kind: 'main' });
    if (typeof listed.current !== 'string' || listed.current.length === 0) {
      throw new Error('current chat session id unavailable');
    }
    return listed.current;
  });
}

test('session-tasks-panel is NOT present when no tasks exist', async ({ mainWindow }) => {
  const panel = mainWindow.locator('[data-testid="session-tasks-panel"]');
  const visible = await panel.isVisible().catch(() => false);
  expect(visible).toBe(false);
});

test('session-tasks-panel appears inside ChatView after session-tasks:changed event', async ({ app, mainWindow }) => {
  const sessionId = await currentSessionId(mainWindow);
  await app.evaluate(({ BrowserWindow }, sid) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    if (!win) return false;
    const item = { id: 'e2e-1', content: 'E2E: Write the fix', status: 'in_progress' };
    win.webContents.send('ave:session-tasks:changed', { sessionId: sid, items: [item] });
    return true;
  }, sessionId);

  const panel = mainWindow.locator('[data-testid="session-tasks-panel"]');
  const found = await panel
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);

  expect(
    found,
    'session-tasks-panel must appear inside ChatView after session-tasks:changed; ' +
    'check that SessionTasksPanel is mounted in ChatView.tsx and that the IPC bridge fires',
  ).toBe(true);

  await expect(panel).toBeVisible();

  const collapsedActive = mainWindow.locator('[data-testid="session-tasks-collapsed-active"]');
  await expect(collapsedActive).toBeVisible();

  await panel.click();
  const activeRow = mainWindow.locator('[data-testid="session-tasks-active-row"]');
  await expect(activeRow).toBeVisible();

  const geometry = await mainWindow.evaluate(() => {
    const row = document.querySelector<HTMLElement>('[data-testid="iab-status-row"]');
    const ring = document.querySelector<HTMLElement>('[data-testid="iab-status-ring"]');
    const frame = document.querySelector<HTMLElement>('[data-testid="composer-frame"]');
    const chip = document.querySelector<HTMLElement>('[data-testid="session-tasks-panel"]');
    if (!row || !ring || !frame || !chip) return null;
    const r = ring.getBoundingClientRect();
    const f = frame.getBoundingClientRect();
    const c = chip.getBoundingClientRect();
    return {
      inRow: row.contains(chip),
      afterRing: ring.nextElementSibling === chip,
      chipLeft: c.left,
      ringRight: r.right,
      chipTop: c.top,
      frameBottom: f.bottom,
    };
  });

  expect(geometry, 'session tasks chip geometry must be measurable').not.toBeNull();
  expect(geometry!.inRow).toBe(true);
  expect(geometry!.afterRing).toBe(true);
  expect(geometry!.chipLeft).toBeGreaterThanOrEqual(geometry!.ringRight);
  expect(geometry!.chipTop).toBeGreaterThanOrEqual(geometry!.frameBottom - 1);
});

test('session-tasks-panel drops transient header badges and dismisses at completion', async ({ app, mainWindow }) => {
  const sessionId = await currentSessionId(mainWindow);
  const emitTasks = async (items: Array<{ id: string; content: string; status: string }>) => {
    await app.evaluate(({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      if (!win) return false;
      win.webContents.send('ave:session-tasks:changed', payload);
      return true;
    }, { sessionId, items });
  };

  await emitTasks([{ id: 'fresh-1', content: 'fresh step', status: 'pending' }]);
  const panel = mainWindow.locator('[data-testid="session-tasks-panel"]');
  await expect(panel).toBeVisible();
  await expect(mainWindow.locator('[data-testid="session-tasks-dismiss"]')).toHaveCount(0);

  await emitTasks([
    { id: 'fresh-1', content: 'fresh step', status: 'pending' },
    { id: 'fresh-2', content: 'added step', status: 'pending' },
  ]);
  await expect(mainWindow.locator('[data-testid="session-tasks-dismiss"]')).toHaveCount(0);

  await emitTasks([
    { id: 'fresh-1', content: 'fresh step', status: 'completed' },
    { id: 'fresh-2', content: 'added step', status: 'completed' },
  ]);
  await panel.click();
  const dismiss = mainWindow.locator('[data-testid="session-tasks-dismiss"]');
  await expect(dismiss).toBeVisible();

  // Clear through the host event path so disappearance cannot be a local hide.
  await dismiss.click();
  await expect(panel).toHaveCount(0);

  await emitTasks([{ id: 'next-1', content: 'next topic step', status: 'pending' }]);
  await expect(panel).toBeVisible();
});
