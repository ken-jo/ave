// Pin composer and queue structure from docs/blueprints/composer-redesign-message-queue.md.
// Queue delivery uses a loopback provider so both turns finish without live credentials.
import { test, expect } from './fixtures';
import { TEST_IDS, testIdSelector } from "../../../src/shared/test-ids.js";
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildLlmSettings } from './seeded-electron.js';

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

test('queue-auto 자동 인입 — done event 시 큐 항목이 user bubble + "↪ 큐에서" hint 로 표시', async ({ mainWindow, t }, testInfo) => {
  const initialText = "Start the first response";
  const queuedText = "끝나면 요약";
  type ModelRequest = {
    model: string;
    messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
  };
  const requests: ModelRequest[] = [];
  const lastUserText = (request: ModelRequest) => {
    const content = request.messages.findLast((message) => message.role === "user")?.content;
    // The first text part is the input; later parts carry host-supplied context.
    return Array.isArray(content)
      ? content.find((part) => part.type === "text")?.text
      : content;
  };
  let finishInitialTurn: (() => void) | undefined;
  const complete = (response: ServerResponse, text: string) => {
    const chunk = (delta: Record<string, string>, finishReason: string | null) =>
      `data: ${JSON.stringify({
        id: "queue-response", object: "chat.completion.chunk", created: 0, model: "queue-model",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`;
    response.write(chunk({ content: text }, null));
    response.write(chunk({}, "stop"));
    response.end("data: [DONE]\n\n");
  };
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "queue-model", object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as ModelRequest;
    requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    // Hold the real first turn until the second keyboard submission is visibly queued.
    if (lastUserText(body) === initialText) {
      finishInitialTurn = () => complete(response, "Initial response completed.");
      response.flushHeaders();
      return;
    }
    complete(response, lastUserText(body) === queuedText ? "Queued response delivered." : "PONG");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const settings = buildLlmSettings("openai-compatible", "queue-model");
    const llm = settings.llm as { vendors: Record<string, { baseUrl?: string }> };
    llm.vendors["openai-compatible"].baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const readiness = await mainWindow.evaluate(async (llm) => {
      const api = (window as unknown as {
        aveApi: {
          getSettings: () => Promise<{ activeChatModel: unknown }>;
          updateSettings: (settings: unknown) => Promise<unknown>;
        };
      }).aveApi;
      const before = (await api.getSettings()).activeChatModel;
      await api.updateSettings({ llm });
      return { before, after: (await api.getSettings()).activeChatModel };
    }, llm);
    expect(readiness.after).toMatchObject({ kind: "api", vendor: "openai-compatible", model: "queue-model" });
    await expect(mainWindow.locator(MAIN + '[data-testid="iab-status-model"]')).toContainText("queue-model");

    const textarea = mainWindow.locator(MAIN + testIdSelector(TEST_IDS.composerTextarea));
    await textarea.fill(initialText);
    await textarea.press("Enter");
    await expect.poll(() => typeof finishInitialTurn).toBe("function");
    await expect(mainWindow.locator(MAIN + '[data-testid="composer-cancel-button"]')).toBeVisible();
    await textarea.fill(queuedText);
    await textarea.press("Enter");
    await expect(mainWindow.locator(MAIN + '[data-testid="message-queue-row-text"]')).toHaveText(queuedText);
    // Enqueuing must not send a second provider request before the first turn ends.
    expect(requests.filter((body) => lastUserText(body) === initialText)).toHaveLength(1);
    expect(requests.filter((body) => lastUserText(body) === queuedText)).toHaveLength(0);
    finishInitialTurn!();

    const transcript = mainWindow.getByTestId("chat-main-column");
    await expect(transcript.getByText("Initial response completed.", { exact: true })).toBeVisible();
    await expect(transcript.getByText(t("chatView.queueInjectLabel"), { exact: true })).toBeVisible();
    await expect(transcript.getByText(queuedText, { exact: true })).toBeVisible();
    await expect(transcript.getByText("Queued response delivered.", { exact: true })).toBeVisible();
    await expect(mainWindow.locator(MAIN + '[data-testid="message-queue-panel"]')).toHaveCount(0);
    expect(requests.filter((body) => lastUserText(body) === initialText)).toHaveLength(1);
    expect(requests.filter((body) => lastUserText(body) === queuedText)).toHaveLength(1);
    await testInfo.attach("queue-delivery", {
      body: JSON.stringify({ readiness, requests }, null, 2),
      contentType: "application/json",
    });
    await mainWindow.screenshot({ path: testInfo.outputPath("queue-delivered.png") });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
