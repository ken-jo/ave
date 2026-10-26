import type { ElectronApplication, Page } from 'playwright';
import { openInlineSettings } from '../e2e/ui/inline-settings.js';
import { expect, type CaptureViewport, type ScriptedScript } from './fixtures.js';
import { VIEW_FIXTURE_ID } from '../fixtures/e2e-plugins/view-fixture.js';

// Keep one scenario per documentation key, with explicit steps or an honest skip reason.
export interface ScenarioContext {
  app: ElectronApplication;
  page: Page;
}

export interface ScenarioEntry {
  topic: string;
  // Omitted crop targets capture the full window.
  locator?: string;
  // Omit plugins for host-only captures.
  plugins?: readonly string[];
  // Keep review enabled only when its approval card is the capture subject.
  keepReviewer?: boolean;
  steps?: (ctx: ScenarioContext) => Promise<void>;
  // Skip takes precedence; entries without either skip or steps fail.
  skip?: string;
  // One script entry answers each model call; refused requests fail the capture.
  scriptedScript?: ScriptedScript;
  // Plugin seeding owns reviewer mode unless overridden.
  reviewerMode?: 'disabled' | 'rule' | 'llm' | 'strict';
  // Auto mode routes foreground tool calls through review before approval.
  executionMode?: 'default' | 'strict' | 'auto' | 'allow';
  seededCorpus?: Readonly<Record<string, string>>;
  uiLocale?: 'ko' | 'en';
  // Override the default viewport when its empty space would make the subject too small.
  captureViewport?: CaptureViewport;
}

async function openChatSurface(page: Page): Promise<void> {
  await page.locator('[data-testid="chat-view-root"]').first().waitFor({ state: 'visible', timeout: 15_000 });
}

// Open plugin panels through sidebar DOM; native command menus are outside the capture surface.
async function openPluginPanel(page: Page, pluginId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await selectPluginPanel(page, pluginId);
      // Wait for guest attachment and first load before its bundle can render.
      await page.locator('webview').first().waitFor({ state: 'visible', timeout: 8_000 });
      break;
    } catch (err) {
      // Retry row selection during cold plugin startup; longer waiting cannot select an absent row.
      if (Date.now() >= deadline) throw err;
    }
  }
  // No host-visible guest-paint signal exists; allow a short settle after load.
  await page.waitForTimeout(2_500);
}

async function selectPluginPanel(page: Page, pluginId: string): Promise<void> {
  await openChatSurface(page);

  // Scope selection to the portaled plugin-group menu to avoid matching another surface.
  await page.locator('[data-testid="primary-sidebar"] [data-testid="sidebar-group-plugins"]').first().click();
  const row = page
    .locator(`[data-testid="sidebar-group-plugins-menu"] [data-viewkey^="plugin:${pluginId}:"]`)
    .first();
  await row.waitFor({ state: 'visible', timeout: 15_000 });
  await row.click();
}

async function sendChatMessage(page: Page, text: string): Promise<void> {
  const composer = page.locator('[data-testid="composer-textarea"]').first();
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  await composer.click();
  await composer.fill(text);
  await page.locator('[data-testid="composer-send-button"]').first().click();
}

// Inject through the production overlay path; seeded E2E coverage owns delivery and acknowledgement.
async function pushAlertOverlay(
  app: ElectronApplication,
  page: Page,
  spec: { intent: string; summary: string; prompt: string },
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, item) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (!win) return;
    win.webContents.send('ave:overlay:show', item);
  }, {
    id: `alert:capture-${spec.intent}`,
    source: { kind: 'alert', pluginId: 'alert-fixture', kindId: spec.intent, alertId: `capture-${spec.intent}` },
    pluginDisplayName: 'Alert fixture',
    title: spec.intent,
    summary: spec.summary,
    running: false,
    priority: 'normal',
    primaryActionLabel: '확인하기',
    pendingPrompt:
      `<imported-from-proactive source="overlay:alert-fixture--${spec.intent}">
${spec.prompt}
</imported-from-proactive>`,
    createdAt: new Date().toISOString(),
  });
  await page.locator('[data-testid="overlay-card-region"]').first().waitFor({
    state: 'visible',
    timeout: 15_000,
  });
  // Expand alert details so captures include the content.
  await page.locator('[data-testid="overlay-card-expand-toggle"]').first().click();
}

// Capture content must use synthetic identities, paths and documents.
const SEEDED_NOTE_PATH = 'notes/reading-list.md';
// This denied path is synthetic and must never be created.
const FABRICATED_OUTSIDE_PATH =
  process.platform === 'win32'
    ? 'C:\\Users\\demo\\Documents\\reading-list.md'
    : process.platform === 'darwin'
      ? '/Users/demo/Documents/reading-list.md'
      : '/home/demo/Documents/reading-list.md';

const SEEDED_SUMMARY_PATH = 'notes/reading-list-summary.md';
const SEEDED_SUMMARY_BODY = [
  '# Reading list — earlier summary',
  '',
  'Three unrelated subjects, one line each, kept short on purpose.',
  '',
].join('\n');
const SEEDED_NOTE_BODY = [
  '# Reading list',
  '',
  '- Tides and estuaries — chapter 3 open questions',
  '- Lighthouse keeping, a short history',
  '- Notes on paper marbling',
  '',
  'Nothing here is real; this file exists so a capture has something to read.',
  '',
].join('\n');

// Use synthetic fixture data for captures; never expose private images or identifiers.
const ALERT_MEETING_SUMMARY = [
  '미팅이 방금 종료되었습니다.',
  '- 제목: 분기 데모 리허설',
  '- 주요 내용:',
  '  - 데모 시나리오 3건을 확정함',
  '  - 녹화본은 다음 주까지만 보관함',
].join('\n');

export const scenarios: Record<string, ScenarioEntry> = {
  'chat-todo-queue': {
    topic: 'chat',
    uiLocale: 'ko',
    reviewerMode: 'disabled',
    captureViewport: { width: 1440, height: 780 },
    // Keep task-list and slow-answer calls visible together.
    scriptedScript: {
      turns: [
      {
        expect: 'assistant',
        parts: [
          {
            kind: 'tool',
            id: 'capture-tasks-create',
            name: 'session_tasks',
            input: {
              action: 'create',
              steps: '읽을 자료 목록 정리, 장별 핵심 질문 뽑기, 요약 초안 작성, 다음 주 읽을 순서 정하기',
            },
          },
          { kind: 'tool', id: 'capture-tasks-done-1', name: 'session_tasks', input: { action: 'complete', index: 1 } },
          { kind: 'tool', id: 'capture-tasks-done-2', name: 'session_tasks', input: { action: 'complete', index: 2 } },
          { kind: 'tool', id: 'capture-tasks-active-3', name: 'session_tasks', input: { action: 'edit', index: 3, status: 'in_progress' } },
        ],
      },
      {
        expect: 'assistant',
        chunkDelayMs: 200,
        parts: [
          {
            kind: 'text',
            text:
              '자료 목록부터 정리했습니다. 세 항목 모두 서로 다른 주제라 한 묶음으로 ' +
              '합치기는 어렵고, 장별로 열어 둔 질문만 따로 뽑아 두었습니다.\n\n' +
              '지금은 초안을 쓰는 중입니다. 각 주제를 두세 문장으로 줄이고, 서로 ' +
              '겹치는 부분이 있으면 표시해 두겠습니다. 초안이 끝나면 다음 주에 어떤 ' +
              '순서로 읽으면 좋을지도 같이 제안하겠습니다.',
          },
        ],
      },
      ],
    },
    steps: async ({ page }) => {
      await openChatSurface(page);
      await sendChatMessage(page, '읽을 자료들 정리하고 요약 초안까지 만들어 줘.');
      await page
        .locator('[data-testid="session-tasks-panel"]')
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
      await sendChatMessage(page, '오늘 날씨는 어때?');
      await sendChatMessage(page, '점심은 뭐가 좋을까?');
      await page
        .locator('[data-testid="message-queue-panel"]')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 });
      // Expand the task chip so the checklist appears in the capture.
      const tasksPanel = page.locator('[data-testid="session-tasks-panel"]').first();
      if (await tasksPanel.locator('[data-testid="session-tasks-collapsed-active"]').count()) {
        await tasksPanel.locator('button').first().click();
      }
      // Wait for streamed text that cannot match a checklist label.
      await page
        .locator('[data-testid="assistant-message-body"]')
        .first()
        .getByText('겹치는 부분이', { exact: false })
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
    },
  },
  'chat-tool-thinking': {
    topic: 'chat',
    uiLocale: 'ko',
    reviewerMode: 'disabled',
    captureViewport: { width: 1440, height: 660 },
    seededCorpus: {
      [SEEDED_NOTE_PATH]: SEEDED_NOTE_BODY,
      [SEEDED_SUMMARY_PATH]: SEEDED_SUMMARY_BODY,
    },
    // Capture a completed read beside active reasoning; reasoning cards settle later.
    scriptedScript: {
      turns: [
        {
          expect: 'assistant',
          parts: [
            {
              kind: 'tool',
              id: 'capture-read-notes',
              name: 'read_file',
              input: { path: SEEDED_NOTE_PATH },
              seededPathFields: ['path'],
            },
          ],
        },
        {
          expect: 'assistant',
          chunkDelayMs: 350,
          parts: [
            {
              kind: 'reasoning',
              text:
                '노트에는 세 항목이 있고 서로 주제가 달라서 한 문단으로 묶기는 어렵다. ' +
                '조석과 하구는 챕터별 질문이 남아 있고, 등대 관리와 종이 마블링은 각각 ' +
                '한 줄짜리 메모라 분량이 맞지 않는다. 이전 요약본이 남아 있는지 먼저 ' +
                '확인한 뒤 같은 형식으로 맞추는 편이 좋겠다.',
            },
            {
              kind: 'tool',
              id: 'capture-read-summary',
              name: 'read_file',
              input: { path: SEEDED_SUMMARY_PATH },
              seededPathFields: ['path'],
            },
          ],
        },
        {
          expect: 'assistant',
          parts: [
            {
              kind: 'text',
              text:
                '노트에는 세 가지 주제가 들어 있습니다. 조석과 하구, 등대 관리의 역사, ' +
                '그리고 종이 마블링 기법입니다.',
            },
          ],
        },
      ],
    },
    steps: async ({ page }) => {
      await openChatSurface(page);
      await sendChatMessage(page, '노트에 정리해 둔 읽을 자료들 좀 요약해 줘.');
      const workGroup = page.getByTestId('work-group').filter({
        has: page.getByTestId('tool-duration'),
      }).first();
      // A duration badge proves the read returned while reasoning remains active.
      await expect(workGroup.getByTestId('tool-duration').first()).toBeVisible({ timeout: 30_000 });
      const liveThinking = workGroup.getByRole('button', { name: '생각 중...', exact: true });
      await expect(liveThinking).toBeVisible({ timeout: 30_000 });
      await expect(liveThinking).toHaveAttribute('aria-expanded', 'true');
    },
  },

  'chat-permission-llm-review': {
    topic: 'chat',
    uiLocale: 'ko',
    reviewerMode: 'llm',
    executionMode: 'auto',
    captureViewport: { width: 1440, height: 660 },
    // Capture standalone review before any tool row exists.
    scriptedScript: {
      turns: [
        {
          expect: 'assistant',
          parts: [
            {
              kind: 'text',
              text: '문서 폴더에 어떤 파일이 있는지 먼저 확인하겠습니다.',
            },
            {
              kind: 'tool',
              id: 'capture-review-shell',
              name: 'bash',
              input: { command: 'ls -la ~/Documents' },
            },
          ],
        },
        {
          expect: 'reviewer',
          chunkDelayMs: 900,
          parts: [
            {
              kind: 'text',
              text: '{ "level": "high", "reason": "reads a directory outside the allowed scope" }',
            },
          ],
        },
      ],
    },
    steps: async ({ page }) => {
      await openChatSurface(page);
      await sendChatMessage(page, '문서 폴더에 뭐가 있는지 확인해 줘.');
      await page
        .locator('[data-testid="permission-review-status-card"]')
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
    },
  },

  'chat-permission-directory': {
    topic: 'chat',
    uiLocale: 'ko',
    reviewerMode: 'disabled',
    locator: '[data-testid="approval-dock"]',
    // Reviewer-off is a scope decision, not a risk verdict.
    scriptedScript: {
      turns: [
        {
          expect: 'assistant',
          parts: [
            {
              kind: 'tool',
              id: 'capture-outside-read',
              name: 'read_file',
              input: { path: FABRICATED_OUTSIDE_PATH },
            },
          ],
        },
      ],
    },
    steps: async ({ page }) => {
      await openChatSurface(page);
      await sendChatMessage(page, '문서 폴더에 있는 읽을 자료 목록도 같이 봐 줘.');
      const dock = page.locator('[data-testid="approval-dock"]').first();
      await dock.waitFor({ state: 'visible', timeout: 30_000 });
      // Expanded review details must expose the path evidence.
      await dock.locator('[data-testid="approval-review-details"]').first().click();
      await dock
        .locator('[data-testid="approval-path-grant-evidence"]')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 });
    },
  },
  'chat-permission-risk': {
    topic: 'chat',
    uiLocale: 'ko',
    reviewerMode: 'llm',
    // Auto mode runs classification; the default mode bypasses it.
    executionMode: 'auto',
    locator: '[data-testid="approval-dock"]',
    scriptedScript: {
      turns: [
        {
          expect: 'assistant',
          parts: [
            {
              kind: 'tool',
              id: 'capture-shell',
              name: 'bash',
              input: { command: 'ls -la ~/Documents' },
            },
          ],
        },
        {
          expect: 'reviewer',
          parts: [
            {
              kind: 'text',
              text: '{ "level": "high", "reason": "reads a directory outside the allowed scope" }',
            },
          ],
        },
      ],
    },
    steps: async ({ page }) => {
      await openChatSurface(page);
      await sendChatMessage(page, '문서 폴더에 뭐가 있는지 확인해 줘.');
      const dock = page.locator('[data-testid="approval-dock"]').first();
      await dock.waitFor({ state: 'visible', timeout: 30_000 });
      await dock.locator('[data-testid="approval-review-details"]').first().click();
      await dock
        .locator('[data-testid="approval-impact-summary"]')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 });
    },
  },
  'chat-app-update': {
    topic: 'chat',
    uiLocale: 'ko',
    steps: async ({ app, page }) => {
      await openChatSurface(page);
      // Drive the synthetic update through the main IPC channel.
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
        if (!win) return;
        win.webContents.send('ave:update:state', { kind: 'available', version: '99.0.0' });
      });
      await page.locator('[data-testid="app-update-badge-available"]').waitFor({
        state: 'visible',
        timeout: 10_000,
      });
    },
    locator: '[data-testid="app-update-badge-available"]',
  },
  'chat-question-card': {
    topic: 'chat',
    uiLocale: 'ko',
    reviewerMode: 'disabled',
    locator: '[data-testid="ask-user-question-card"]',
    // Leave the request unanswered for the capture.
    scriptedScript: {
      turns: [
      {
        expect: 'assistant',
        parts: [
          {
            kind: 'tool',
            id: 'capture-ask',
            name: 'ask_user_question',
            input: {
              questions: [
                {
                  question: '요약을 어떤 길이로 만들까요?',
                  choices: ['한 문단', '반 페이지', '한 페이지'],
                  recommendedIndex: 1,
                },
              ],
            },
          },
        ],
      },
      ],
    },
    steps: async ({ page }) => {
      await openChatSurface(page);
      await sendChatMessage(page, '노트에 정리해 둔 읽을 자료들 요약해 줘.');
      await page
        .locator('[data-testid="ask-user-question-card"]')
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
    },
  },
  'chat-plugin-panel': {
    topic: 'chat',
    // Fixture panels exercise the host chrome.
    plugins: [VIEW_FIXTURE_ID],
    // Default mode would obscure the panel with mount-write approval.
    executionMode: 'allow',
    steps: async ({ page }) => {
      await openPluginPanel(page, VIEW_FIXTURE_ID);
    },
  },

  'plugin-permission-grant': {
    topic: 'plugins',
    plugins: [VIEW_FIXTURE_ID],
    keepReviewer: true,
    uiLocale: 'ko',
    locator: '[data-testid="tool-approval-panel"]',
    steps: async ({ page }) => {
      // Retain review so the mount tool shows its approval state.
      await openPluginPanel(page, VIEW_FIXTURE_ID);
      await page
        .locator('[data-testid="tool-approval-panel"]')
        .first()
        .waitFor({ state: 'visible', timeout: 20_000 });
    },
  },

  // External plugin UI is outside this capture scope.

  'alert-meeting-end-trigger': {
    topic: 'alerts',
    captureViewport: { width: 1440, height: 820 },
    uiLocale: 'ko',
    steps: async ({ app, page }) => {
      await openChatSurface(page);
      await pushAlertOverlay(app, page, {
        intent: 'meeting-summary',
        summary: ALERT_MEETING_SUMMARY,
        prompt: ALERT_MEETING_SUMMARY,
      });
    },
  },
  'alert-meeting-end-trigger-2': {
    topic: 'alerts',
    captureViewport: { width: 1440, height: 820 },
    uiLocale: 'ko',
    reviewerMode: 'disabled',
    scriptedScript: {
      turns: [
        {
          expect: 'assistant',
          parts: [
            {
              kind: 'text',
              text: [
                '미팅이 종료된 것으로 보이고, 요약도 충분히 정리돼 있습니다.',
                '원하시면 바로 다음 중 하나를 진행하겠습니다.',
                '',
                '1. 회의록을 메일로 공유',
                '2. 오늘 work-log 에 개인 기록으로 추가',
                '3. 둘 다 하지 않고 여기서 종료',
              ].join('\n'),
            },
          ],
        },
      ],
    },
    steps: async ({ app, page }) => {
      await openChatSurface(page);
      await pushAlertOverlay(app, page, {
        intent: 'meeting-summary',
        summary: ALERT_MEETING_SUMMARY,
        prompt: ALERT_MEETING_SUMMARY,
      });
      await page.locator('[data-testid="overlay-card-primary-action"]').first().click();
      await page.locator('[data-testid="assistant-message-body"]').last().waitFor({
        state: 'visible',
        timeout: 30_000,
      });
    },
  },

  // This settings smoke is not a documentation capture.
  '_smoke-settings-llm': {
    topic: '_smoke',
    steps: async ({ app, page }) => {
      await openInlineSettings(app, page, 'llm');
    },
  },
};

// Skip plugin-owned UI that repository fixtures cannot represent faithfully.
export const PLUGIN_REPOSITORY_KEYS_OUT_OF_SCOPE = [
  'meeting-upcoming', 'meeting-minutes', 'meeting-minutes-2', 'meeting-minutes-3',
  'local-indexer-add-folder', 'local-indexer-indexing', 'local-indexer-home',
  'local-indexer-index-search', 'local-indexer-search', 'local-indexer-search-2',
  'local-indexer-search-3',
] as const;
