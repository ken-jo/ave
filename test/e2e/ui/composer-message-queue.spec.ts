// Pin composer and queue structure from docs/blueprints/composer-redesign-message-queue.md.
// Live-stream timing and interruption behavior belong to renderer unit coverage.
import { test, expect } from './fixtures';
import type { ElectronFixtures } from './fixtures.js';
import { TEST_IDS, testIdSelector } from "../../../src/shared/test-ids.js";
import { MAIN_CHAT_GROUP_ID } from "../../../src/contract/app-contract.js";

// Scope locators to the main dock because the side chat renders the same controls and test ids.
const MAIN = '[data-composer-surface="main"] ';


test('idle: composer input-bar contains textarea only (no Send/Stop/Guide buttons)', async ({ mainWindow }) => {
  const textarea = mainWindow.locator(MAIN + testIdSelector(TEST_IDS.composerTextarea));
  await expect(textarea).toBeVisible();

  const inputBar = mainWindow.locator(MAIN + testIdSelector(TEST_IDS.composerInputBar));
  await expect(inputBar).toBeVisible();
  const buttonsInsideInputBar = inputBar.locator('> button');
  await expect(buttonsInsideInputBar).toHaveCount(0);
});

test('idle: unified InputActionBar 가 TokenRing + Send 를 표시', async ({ mainWindow }) => {
  const row = mainWindow.locator(MAIN + '[data-testid="input-action-bar"]');
  await expect(row).toBeVisible();
  await expect(mainWindow.locator(MAIN + '[data-testid="iab-status-row"] [data-testid="iab-status-ring"]')).toBeVisible();

  const sendBtn = mainWindow.locator(MAIN + '[data-testid="composer-send-button"]');
  await expect(sendBtn).toBeVisible();
});

test('idle: cancel button 미노출 (busy 일 때만)', async ({ mainWindow }) => {
  // Stop is a state of the shared turn control while busy with an empty draft.
  const cancelBtn = mainWindow.locator(MAIN + '[data-testid="composer-cancel-button"]');
  await expect(cancelBtn).toHaveCount(0);
});

test('idle: MessageQueuePanel 미렌더 (큐 비어 있음 sentinel)', async ({ mainWindow }) => {
  const panel = mainWindow.locator(MAIN + '[data-testid="message-queue-panel"]');
  await expect(panel).toHaveCount(0);
});

test.describe('renderer debug stream env', () => {
  test.use({ launchEnv: { AVE_DEV_CONSOLE: '1' } });

  test('dev console flag does not enable renderer debugStream by default', async ({ mainWindow }) => {
    const env = await mainWindow.evaluate(() => {
      const ave = (window as unknown as {
        ave?: {
          env?: {
            isDev?: boolean;
            isE2E?: boolean;
            enableDevConsole?: boolean;
            debugStream?: boolean;
          };
        };
      }).ave;
      return ave?.env ?? null;
    });

    expect(env).toMatchObject({
      isDev: true,
      isE2E: true,
      enableDevConsole: true,
      debugStream: false,
    });
  });
});

test('InputActionBar: command → attach leading controls and reasoning status are visible', async ({ mainWindow }) => {
  const attachBtn = mainWindow.locator(MAIN + '[data-testid="iab-attach-button"]');
  await expect(attachBtn).toBeVisible();
  const leadingIds = await mainWindow.locator('[data-testid="iab-leading"] [data-testid]').evaluateAll(
    (nodes) => nodes.map((node) => node.getAttribute('data-testid')),
  );
  expect(leadingIds).toEqual([
    'slash-picker-trigger',
    'iab-attach-button',
  ]);
  await expect(mainWindow.locator('[data-testid="iab-status-reasoning"]')).toBeVisible();
});

test('큐 항목 수정 (더블클릭) — input 진입 + Enter commit', async ({ mainWindow }) => {
  // Wait for the queue store exposed by the development E2E harness rather than skipping.
  await mainWindow.waitForFunction(
    () => typeof (window as unknown as { __ave_message_queue_store__?: { add?: unknown } })
      .__ave_message_queue_store__?.add === "function",
  );
  await mainWindow.evaluate(() => {
    (window as unknown as { __ave_message_queue_store__: { add: (text: string) => void } })
      .__ave_message_queue_store__.add("original text");
  });
  const row = mainWindow.locator(MAIN + '[data-testid="message-queue-row-text"]').first();
  await expect(row).toBeVisible();
  await row.dblclick();
  const input = mainWindow.locator(MAIN + '[data-testid="message-queue-row-edit"]');
  await expect(input).toBeVisible();
  await input.fill("edited text");
  await input.press("Enter");
  await expect(mainWindow.locator(MAIN + '[data-testid="message-queue-row-text"]').first()).toContainText("edited text");
});

test('queue reorder keeps row focus and updates accessible positions', async ({ mainWindow, t }: Pick<ElectronFixtures, 'mainWindow' | 't'>) => {
  await mainWindow.waitForFunction(
    () => typeof (window as unknown as { __ave_message_queue_store__?: { add?: unknown } })
      .__ave_message_queue_store__?.add === "function",
  );
  await mainWindow.evaluate(() => {
    const store = (window as unknown as { __ave_message_queue_store__: { add: (text: string) => void } })
      .__ave_message_queue_store__;
    store.add("first queued");
    store.add("second queued");
    store.add("third queued");
  });
  const rows = mainWindow.locator(MAIN + '[data-testid="message-queue-row"]');
  const texts = mainWindow.locator(MAIN + '[data-testid="message-queue-row-text"]');
  await expect(texts).toHaveText(["first queued", "second queued", "third queued"]);
  await rows.first().getByRole('button', { name: t('messageQueuePanel.moveDown'), exact: true }).click();
  await expect(texts).toHaveText(["second queued", "first queued", "third queued"]);
  await expect(rows.nth(1)).toBeFocused();
  await expect(rows.nth(1)).toHaveAttribute('aria-posinset', '2');
  await rows.nth(1).press('Alt+ArrowDown');
  await expect(texts).toHaveText(["second queued", "third queued", "first queued"]);
  await expect(rows.nth(2)).toBeFocused();
  await expect(rows.nth(2).getByRole('button', { name: t('messageQueuePanel.moveDown'), exact: true })).toBeDisabled();
  await rows.nth(2).press('Alt+ArrowUp');
  await expect(texts).toHaveText(["second queued", "first queued", "third queued"]);
});

test('queue-auto 자동 인입 — done event 시 큐 항목이 user bubble + "↪ 큐에서" hint 로 표시', async ({ app, mainWindow, t }) => {
  // A dummy active-provider key passes the initial send gate; the queue bubble must append before later failure.
  const hasSeededKey = await mainWindow.evaluate(async () => {
    const api = (window as unknown as {
      aveApi: {
        getSettings: () => Promise<unknown>;
        hasApiKey: (provider: string) => Promise<boolean>;
        setApiKey: (provider: string, key: string) => Promise<unknown>;
      };
    }).aveApi;
    const settings = await api.getSettings();
    const provider =
      settings && typeof settings === 'object' &&
      'llm' in settings &&
      settings.llm &&
      typeof settings.llm === 'object' &&
      'provider' in settings.llm &&
      typeof settings.llm.provider === 'string'
        ? settings.llm.provider
        : 'azure';
    await api.setApiKey(provider, 'ave-e2e-dummy-key');
    return api.hasApiKey(provider);
  });
  expect(hasSeededKey).toBe(true);
  await mainWindow.waitForFunction(
    () => typeof (window as unknown as { __ave_message_queue_store__?: { add?: unknown } })
      .__ave_message_queue_store__?.add === "function",
  );
  await mainWindow.evaluate(() => {
    (window as unknown as { __ave_message_queue_store__: { add: (text: string) => void } })
      .__ave_message_queue_store__.add("끝나면 요약");
  });
  const row = mainWindow.locator(MAIN + '[data-testid="message-queue-row-text"]').first();
  await expect(row).toBeVisible();
  // Address the main dock: preload routes stream frames only to their named chat group.
  await app.evaluate(({ BrowserWindow }, chatGroupId) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (!win) throw new Error("no live window to deliver the done frame to");
    win.webContents.send("ave:chat:stream", { type: "done", streamId: 1, chatGroupId });
  }, MAIN_CHAT_GROUP_ID);
  await expect(mainWindow.locator(`text=${t('chatView.queueInjectLabel')}`).first()).toBeVisible({ timeout: 5_000 });
  await expect(mainWindow.locator('text=끝나면 요약').first()).toBeVisible();
});
