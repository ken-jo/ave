import type { ElectronApplication, Page } from 'playwright';
import { openInlineSettings } from '../e2e/ui/inline-settings.js';
import { expect, type CaptureViewport, type ScriptedScript } from './fixtures.js';
import { VIEW_FIXTURE_ID } from '../fixtures/e2e-plugins/view-fixture.js';

/**
 * Data-driven scenario matrix: one entry per docs-site screenshot key
 * (`web/lib/screenshots.ts`).
 *
 * Each entry is either:
 *   - capturable: `steps` navigates/injects state, `locator` (optional)
 *     scopes the capture to one element; omitted `locator` captures the
 *     full window.
 *   - `skip: "<reason>"`: honest skip — the harness cannot realistically
 *     seed this state today. See README.md "Skip list" for the categorized
 *     rationale (live OAuth, real STT, external signals, etc). Keys outside
 *     this harness entirely are listed at the bottom of this file.
 *
 * Keyed by the same string keys as `shots` in screenshots.ts so a docs-site
 * key maps 1:1 to a matrix entry and an output filename `<key>.png`.
 */
export interface ScenarioContext {
  app: ElectronApplication;
  page: Page;
}

export interface ScenarioEntry {
  /** docs-site topic, mirrored from screenshots.ts for readability/grouping. */
  topic: string;
  /** Element to crop the capture to. Full-window screenshot if omitted. */
  locator?: string;
  /**
   * Ids of in-repository fixture plugins to install before launch (e.g.
   * `['viewfixture']`) — see `plugin-seed.ts`. Omit for host-only scenarios.
   */
  plugins?: readonly string[];
  /**
   * Keep the LLM permission reviewer ON for this scenario (default: it is
   * disabled whenever `plugins` is set, so panel mount-time read tools don't
   * open the approval dock). Set true only for `plugin-permission-grant`, whose
   * capture target IS that approval dock.
   */
  keepReviewer?: boolean;
  /** Navigate/seed steps run before capture. Required unless `skip` is set. */
  steps?: (ctx: ScenarioContext) => Promise<void>;
  /**
   * Honest skip reason; `skip` wins over `steps` when both are present. An
   * entry with neither is an incomplete entry and the spec fails it.
   */
  skip?: string;
  /**
   * Transcript for the harness's local scripted endpoint (see fixtures.ts
   * "Scripted provider"), one entry per model call the scenario's `steps`
   * cause. Set this and the app is launched pointing at that endpoint instead
   * of a vendor it cannot reach; leave it unset for scenarios that never start
   * a turn. The spec fails the capture when the endpoint refused a request it
   * could not answer; a trailing turn the capture stopped before is not
   * checked.
   */
  scriptedScript?: ScriptedScript;
  /** Reviewer mode for the isolated profile. Plugin scenarios leave this to
   *  `plugin-seed.ts`, which already picks the mode their panel needs. */
  reviewerMode?: 'disabled' | 'rule' | 'llm' | 'strict';
  /**
   * Permission execution mode for the isolated profile. Omit for the host
   * default (`default`). `auto` is what routes a foreground shell/write/network
   * call through the reviewer before the approval dock opens — see the option's
   * JSDoc in fixtures.ts.
   */
  executionMode?: 'default' | 'strict' | 'auto' | 'allow';
  /** Fabricated files written under the isolated Ave home before launch. */
  seededCorpus?: Readonly<Record<string, string>>;
  /** UI locale for this capture. The published docs images are Korean. */
  uiLocale?: 'ko' | 'en';
  /**
   * Window size for this capture. Omit for the harness default
   * (`CAPTURE_VIEWPORT`, 1600x1000); set it for a key whose subject is a short
   * transcript, which the default frames inside a lot of empty background.
   */
  captureViewport?: CaptureViewport;
}

async function openWorkMode(page: Page): Promise<void> {
  const workToggle = page.locator('[data-testid="app-mode-work"]');
  if (await workToggle.count()) {
    await workToggle.click().catch(() => {});
  }
  await page.locator('[data-testid="chat-view-root"]').first().waitFor({ state: 'visible', timeout: 15_000 });
}

/**
 * Open a seeded plugin's panel from the sidebar's plugin rail, then wait for
 * its UI bundle to render inside the plugin webview.
 *
 * The sidebar rail is the only DOM route left to a plugin panel: the composer's
 * command button opens a NATIVE Electron menu, which lives outside the page and
 * cannot be seen, driven, or screenshotted by Playwright. The rail's "plugins"
 * group opens a menu whose rows each carry
 * `data-viewkey="plugin:<pluginId>:<viewId>"` (Sidebar.tsx, `PluginNavItem`),
 * so a prefix match addresses a plugin without knowing its view id or its
 * localized display label, and works whether the rail is expanded or collapsed
 * (the collapsed square button carries the same attribute, only its text is
 * dropped). Clicking a row calls `handleViewSelectWithDoctor(viewKey)`, the
 * same handler the picker used to call; in WORK mode (the harness default) that
 * opens the panel INLINE via `setActiveView` in the main renderer, so the
 * webview mounts inside mainWindow and is screenshottable in either workspace
 * mode.
 *
 * The plugin UI loads inside an Electron <webview> (plugin-ui-host.tsx) whose
 * guest content is the plugin's real bundle served over `ave-plugin://asset`.
 * Playwright cannot pierce a <webview>'s guest document with `.locator`, so we
 * wait for the <webview> element to attach + finish loading and give the guest
 * a settle beat, then screenshot the host panel region (which contains it).
 *
 * @param pluginId the plugin's manifest id, e.g. `VIEW_FIXTURE_ID` (`viewfixture`).
 */
async function openPluginPanel(page: Page, pluginId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await selectPluginPanel(page, pluginId);
      // The plugin panel host mounts a <webview>. Wait for it to attach and
      // finish its first load; the guest bundle then renders its own DOM.
      await page.locator('webview').first().waitFor({ state: 'visible', timeout: 8_000 });
      break;
    } catch (err) {
      // Re-selecting, rather than waiting longer, is what actually converges.
      // A plugin whose `start()` has not resolved yet already opens a panel
      // that waits, so the loop only has to cover a row that has not appeared
      // in the rail yet on a cold profile.
      if (Date.now() >= deadline) throw err;
    }
  }
  // Give the guest bundle a settle beat to paint its initial (empty-state) UI
  // after did-finish-load. No host-observable signal crosses the <webview>
  // boundary, so a fixed settle is the pragmatic wait here.
  await page.waitForTimeout(2_500);
}

/** One walk of the sidebar rail to the named plugin's panel row. */
async function selectPluginPanel(page: Page, pluginId: string): Promise<void> {
  await openWorkMode(page);

  // Plugin rows live in the rail's "plugins" group, a popover menu portaled
  // out of the sidebar (Sidebar.tsx, `NavGroup`): open the group, then pick the
  // row inside that menu, so the match cannot land on another surface that
  // carries the same `data-viewkey`.
  await page.locator('[data-testid="primary-sidebar"] [data-testid="sidebar-group-plugins"]').first().click();
  const row = page
    .locator(`[data-testid="sidebar-group-plugins-menu"] [data-viewkey^="plugin:${pluginId}:"]`)
    .first();
  await row.waitFor({ state: 'visible', timeout: 15_000 });
  await row.click();
}

/**
 * Type one message into the composer and send it, starting a model turn
 * against the scripted endpoint.
 */
async function sendChatMessage(page: Page, text: string): Promise<void> {
  const composer = page.locator('[data-testid="composer-textarea"]').first();
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  await composer.click();
  await composer.fill(text);
  await page.locator('[data-testid="composer-send-button"]').first().click();
}

/** Capture a host alert card through the production overlay channel.
 * Delivery and acknowledgement are exercised by the seeded alert E2E fixture. */
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
    // The ko string `be_pluginRuntime.overlayPrimaryActionLabel` resolves to.
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
  // The card opens with the summary clamped to two lines and a "더 보기" toggle.
  // The published images are clamped too, but what they clamp away is the alert
  // itself, so the frame ends up showing the feature without showing what it
  // said. Expanding is a real state of the real card, reached by clicking the
  // real control.
  await page.locator('[data-testid="overlay-card-expand-toggle"]').first().click();
}

/**
 * Everything in the captures below is invented. It is written here rather than
 * read from anywhere on the capturing machine so a frame cannot pick up a real
 * name, path, or document by accident — which is the whole reason these keys
 * are being re-shot (docs/development/screenshot-reshoot.md).
 */
const SEEDED_NOTE_PATH = 'notes/reading-list.md';
/**
 * A path deliberately outside the isolated profile's allowed scope, which is
 * exactly `cwd` plus the Ave home (`computeDefaultAllowedDirectories`). A read
 * of it therefore reaches the allowed-directory gate. Invented, and never
 * created — the capture is of the dialog, not of a successful read.
 */
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

/**
 * Declared alert presentation scenarios.
 *
 * The published images for these keys carry a real organiser, real attendee
 * addresses and, on one, an opaque calendar event id. Everything below is
 * invented for the capture: the addresses are at `example.invalid`, which is
 * reserved by RFC 2606 and can never resolve to anyone, and the names are role
 * labels rather than person names.
 */
const ALERT_CONFLICT_SUMMARY = [
  '새 일정이 기존 일정과 겹칩니다.',
  '- 새 일정: 분기 데모 리허설 (14:00~15:00)',
  '- 겹치는 일정 (1개):',
  '  - 문서화 스프린트 점검 (14:30~15:30)',
].join('\n');

const ALERT_PREP_SUMMARY = [
  '약 15분 후 일정이 시작됩니다.',
  '- 제목: 분기 데모 리허설',
  '- 주최자: 데모 진행자 (demo-host@example.invalid)',
  '- 장소: 온라인',
].join('\n');

const ALERT_MEETING_SUMMARY = [
  '미팅이 방금 종료되었습니다.',
  '- 제목: 분기 데모 리허설',
  '- 주요 내용:',
  '  - 데모 시나리오 3건을 확정함',
  '  - 녹화본은 다음 주까지만 보관함',
].join('\n');

export const scenarios: Record<string, ScenarioEntry> = {
  // ---- chat (host app) ------------------------------------------------
  'chat-todo-queue': {
    topic: 'chat',
    uiLocale: 'ko',
    reviewerMode: 'disabled',
    captureViewport: { width: 1440, height: 780 },
    // Two model calls: the first writes the session task list, the second is a
    // long answer streamed slowly so messages typed while it runs land in the
    // queue instead of starting a turn of their own. Both panels are then on
    // screen at once, which is what this key shows.
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
      await openWorkMode(page);
      await sendChatMessage(page, '읽을 자료들 정리하고 요약 초안까지 만들어 줘.');
      await page
        .locator('[data-testid="session-tasks-panel"]')
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
      // The second turn is streaming by now. Anything sent while it runs is
      // queued rather than started, which is the state this key depicts.
      await sendChatMessage(page, '오늘 날씨는 어때?');
      await sendChatMessage(page, '점심은 뭐가 좋을까?');
      await page
        .locator('[data-testid="message-queue-panel"]')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 });
      // The tasks chip collapses to a one-line focus row once a turn is under
      // way; expand it so the checklist this key is about is in frame.
      const tasksPanel = page.locator('[data-testid="session-tasks-panel"]').first();
      if (await tasksPanel.locator('[data-testid="session-tasks-collapsed-active"]').count()) {
        await tasksPanel.locator('button').first().click();
      }
      // A phrase that appears only in the streamed answer, not in the checklist
      // above it — so this waits for the transcript, not for a task row.
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
    // Capture the completed file read while the next response is in flight.
    // The active work group owns the single thinking status; reasoning cards
    // appear only after the turn settles. Slow reasoning keeps that status and
    // the finished tool row in the same frame.
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
      await openWorkMode(page);
      await sendChatMessage(page, '노트에 정리해 둔 읽을 자료들 좀 요약해 줘.');
      const workGroup = page.getByTestId('work-group').filter({
        has: page.getByTestId('tool-duration'),
      }).first();
      // The duration badge proves the first read returned. Keep the active
      // group open: clicking its thinking header would hide the tool row, and
      // the current UI does not expose a live reasoning body to wait for.
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
    // The same shell call as chat-permission-risk, captured one step earlier:
    // while the reviewer's answer is still on the wire. The reviewer runs
    // BEFORE the tool starts, so no tool row exists for that toolUseId yet and
    // TranscriptRenderer's `rendersOnToolRow` is false — which is exactly the
    // case its comment reserves the standalone PermissionReviewStatusCard for.
    // `chunkDelayMs` on the reviewer turn is what holds that state open long
    // enough to wait on.
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
      await openWorkMode(page);
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
    // The reviewer is off, so nothing here is a risk verdict: this is the
    // allowed-directory gate in PermissionManager, reached by reading a path
    // outside the profile's scope. That is the dialog this key documents.
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
      await openWorkMode(page);
      await sendChatMessage(page, '문서 폴더에 있는 읽을 자료 목록도 같이 봐 줘.');
      const dock = page.locator('[data-testid="approval-dock"]').first();
      await dock.waitFor({ state: 'visible', timeout: 30_000 });
      // The dock summarises by default; the path evidence — requested path and
      // the directories currently in scope — is inside the review details,
      // which is what this key is about.
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
    // `auto` is the mode this key documents — the branch where the reviewer
    // grades a shell call first and only a verdict above the auto-approve
    // threshold reaches the user. Under the default mode the dock opens
    // straight from the category rule, no classification call is made, and the
    // scripted reviewer turn below is not requested at all.
    executionMode: 'auto',
    locator: '[data-testid="approval-dock"]',
    // Same flow as chat-permission-llm-review, captured one step later: the
    // verdict has landed and the dock is showing what the risk level means for
    // this call, which is the branch this key documents.
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
      await openWorkMode(page);
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
      await openWorkMode(page);
      // MainToolbar's badge is driven by main -> renderer IPC on
      // "ave:update:state" (src/main/auto-updater.ts sends it via
      // mainWindow.webContents.send; shape = UpdateState in
      // src/shared/update-state.ts). Push a synthetic "available" state
      // through the real channel from the main process — same technique as
      // test/e2e/ui/seeded-electron.ts's sendRendererStreamEvent — instead of
      // a fabricated DOM event the renderer never actually listens for.
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
    // One call: the turn parks on `ask_user_question` and waits for an answer
    // that never comes, so the card stays on screen for the capture.
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
      await openWorkMode(page);
      await sendChatMessage(page, '노트에 정리해 둔 읽을 자료들 요약해 줘.');
      await page
        .locator('[data-testid="ask-user-question-card"]')
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
    },
  },
  'chat-plugin-panel': {
    topic: 'chat',
    // A plugin's sidebar panel open inline beside the chat. The plugin is the
    // in-repository view fixture: the frame is about the host's panel chrome,
    // and the panel shows the result of the fixture's own mount-time tool call.
    plugins: [VIEW_FIXTURE_ID],
    // The panel's mount-time call is a write; left at `default` it raises the
    // approval card over the panel this frame exists to show.
    executionMode: 'allow',
    steps: async ({ page }) => {
      await openPluginPanel(page, VIEW_FIXTURE_ID);
    },
  },

  // ---- plugin common ----------------------------------------------------
  'plugin-permission-grant': {
    topic: 'plugins',
    plugins: [VIEW_FIXTURE_ID],
    keepReviewer: true,
    uiLocale: 'ko',
    locator: '[data-testid="tool-approval-panel"]',
    steps: async ({ page }) => {
      // With the reviewer left ON (keepReviewer), the view fixture panel's
      // mount-time tool call raises the host's "Approve Tool Execution" card
      // (ToolApprovalContent.tsx) — the plugin-first-tool-call permission grant
      // this docs key depicts.
      await openPluginPanel(page, VIEW_FIXTURE_ID);
      await page
        .locator('[data-testid="tool-approval-panel"]')
        .first()
        .waitFor({ state: 'visible', timeout: 20_000 });
    },
  },

  // ---- meeting, local-indexer ------------------------------------------------
  // Their keys depict those plugins' own UI, which lives in their own
  // repositories. See PLUGIN_REPOSITORY_KEYS_OUT_OF_SCOPE below.

  // ---- integration (meeting + outlook) ------------------------------------------------
  'meeting-outlook-mail': {
    topic: 'integration',
    skip: 'Requires live Outlook OAuth + generated minutes. Plugin UI + live OAuth, both out of scope.',
  },
  'meeting-outlook-mail-2': { topic: 'integration', skip: 'Same as meeting-outlook-mail.' },

  // ---- lyra-mail (Outlook) ------------------------------------------------
  'outlook-login-trigger': {
    topic: 'lyra-mail',
    skip:
      'The lyra-mail plugin lives in its own repository, and its manifest declares ' +
      '`auth.loginTool: lyramail_auth`, so selecting the Outlook panel while unauthed goes ' +
      'straight to the live Microsoft OAuth window (use-plugin-view-routing.ts handleViewSelect ' +
      'calls loginTool on select for auth plugins) rather than rendering an inline pre-login ' +
      'panel. Reaching a stable, non-OAuth trigger state needs a real/mocked auth session — ' +
      'out of scope (see outlook-login-window).',
  },
  'outlook-login-window': {
    topic: 'lyra-mail',
    skip: 'Live Microsoft OAuth popup — cannot be seeded deterministically or without real credentials.',
  },
  'outlook-login-after': {
    topic: 'lyra-mail',
    skip: 'Requires a completed live OAuth login.',
  },
  'outlook-logout': {
    topic: 'lyra-mail',
    skip: 'Requires a prior live OAuth login to revoke.',
  },

  // ---- meeting (recording) ------------------------------------------------
  'meeting-record': {
    topic: 'meeting',
    skip:
      'The live-recording mini-widget is a separate detached BrowserWindow the meeting plugin ' +
      'opens only after meeting_start begins a session (needs an active audio device / injected ' +
      'PCM chunks); its waveform/transcript render is meaningless without a real audio source. ' +
      'The meeting panel keys are out of scope too (PLUGIN_REPOSITORY_KEYS_OUT_OF_SCOPE).',
  },
  'meeting-record-stt': {
    topic: 'meeting',
    skip: 'Requires real STT audio pipeline streaming chunks — explicitly called out as infeasible to seed.',
  },

  // Host alert cards and their accepted prompts.
  'alert-conflict': {
    topic: 'alerts',
    // Card plus chat, without the dead space the default viewport leaves.
    captureViewport: { width: 1440, height: 820 },
    uiLocale: 'ko',
    steps: async ({ app, page }) => {
      await openWorkMode(page);
      await pushAlertOverlay(app, page, {
        intent: 'calendar-conflict-prep',
        summary: ALERT_CONFLICT_SUMMARY,
        prompt: ALERT_CONFLICT_SUMMARY,
      });
    },
  },
  'alert-conflict-2': {
    topic: 'alerts',
    // Taller than its siblings: this reply carries both event detail blocks, and
    // a shorter frame scrolls the imported-trigger bubble — the thing that shows
    // the card's prompt became a chat turn — off the top.
    captureViewport: { width: 1440, height: 980 },
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
                '겹치는 두 일정의 상세는 아래와 같습니다.',
                '',
                '1. 분기 데모 리허설',
                '',
                '- 시간: 2026-08-27 14:00 ~ 15:00',
                '- 장소: 온라인',
                '- 주최자: 데모 진행자 (demo-host@example.invalid)',
                '- 상태: 참석자에 본인 포함',
                '',
                '2. 문서화 스프린트 점검',
                '',
                '- 시간: 2026-08-27 14:30 ~ 15:30',
                '- 장소: 회의실 B',
                '- 주최자: 문서 담당 (demo-docs@example.invalid)',
                '- 상태: 수락, 정기 일정',
                '',
                '겹치는 구간은 30분입니다. 원하시면 다음 중 하나로 이어가겠습니다.',
                '',
                '1. 리허설을 30분 앞당겨 겹침을 없앨다',
                '2. 점검을 다음 슬롯으로 미룬다',
                '3. 이번엔 그대로 둔다',
              ].join('\n'),
            },
          ],
        },
      ],
    },
    steps: async ({ app, page }) => {
      await openWorkMode(page);
      await pushAlertOverlay(app, page, {
        intent: 'calendar-conflict-prep',
        summary: ALERT_CONFLICT_SUMMARY,
        prompt: ALERT_CONFLICT_SUMMARY,
      });
      // The published image for this key is the state AFTER the card's primary
      // action: the staged prompt lands in chat as an imported trigger and the
      // assistant answers it. Clicking the real button is what produces it.
      await page.locator('[data-testid="overlay-card-primary-action"]').first().click();
      await page.locator('[data-testid="assistant-message-body"]').last().waitFor({
        state: 'visible',
        timeout: 30_000,
      });
    },
  },
  'alert-reminder': {
    topic: 'alerts',
    // Card plus chat, without the dead space the default viewport leaves.
    captureViewport: { width: 1440, height: 820 },
    uiLocale: 'ko',
    steps: async ({ app, page }) => {
      await openWorkMode(page);
      await pushAlertOverlay(app, page, {
        intent: 'calendar-event-prep',
        summary: ALERT_PREP_SUMMARY,
        prompt: ALERT_PREP_SUMMARY,
      });
    },
  },
  'alert-reminder-2': {
    topic: 'alerts',
    // Card plus chat, without the dead space the default viewport leaves.
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
                '시작 전 준비할 것을 정리했습니다.',
                '',
                '- 지난 회차에서 넘어온 항목 2건이 아직 열려 있습니다.',
                '- 데모 시나리오 문서는 어제 저녁 이후 변경이 없습니다.',
                '',
                '지금 열어드릴까요, 아니면 요약만 먼저 보시겠어요?',
              ].join('\n'),
            },
          ],
        },
      ],
    },
    steps: async ({ app, page }) => {
      await openWorkMode(page);
      await pushAlertOverlay(app, page, {
        intent: 'calendar-event-prep',
        summary: ALERT_PREP_SUMMARY,
        prompt: ALERT_PREP_SUMMARY,
      });
      await page.locator('[data-testid="overlay-card-primary-action"]').first().click();
      await page.locator('[data-testid="assistant-message-body"]').last().waitFor({
        state: 'visible',
        timeout: 30_000,
      });
    },
  },
  'alert-meeting-end-trigger': {
    topic: 'alerts',
    // Card plus chat, without the dead space the default viewport leaves.
    captureViewport: { width: 1440, height: 820 },
    uiLocale: 'ko',
    steps: async ({ app, page }) => {
      await openWorkMode(page);
      await pushAlertOverlay(app, page, {
        intent: 'meeting-summary',
        summary: ALERT_MEETING_SUMMARY,
        prompt: ALERT_MEETING_SUMMARY,
      });
    },
  },
  'alert-meeting-end-trigger-2': {
    topic: 'alerts',
    // Card plus chat, without the dead space the default viewport leaves.
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
      await openWorkMode(page);
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

  // ---- agent-hub plugin (host sidebar) ------------------------------------------------
  'agent-hub-my-work': {
    topic: 'agent-hub-plugin',
    skip:
      'No agent-hub plugin bundle exists in this workspace — there is no ave-plugin-hydra ' +
      'repo, and no plugin.json anywhere declares a ui extension named my-work / team-board / ' +
      'agent-hub (verified by scanning every ave-plugin-*/plugin.json). Nothing to side-load.',
  },
  'agent-hub-team-board': { topic: 'agent-hub-plugin', skip: 'Same as agent-hub-my-work — no agent-hub bundle exists.' },

  // ---- settings (not in the docs shot list by app- prefix, but part of the smoke subset) ----
  // Not a docs-site key — included as an extra smoke-subset target proving the
  // settings surface renders. Not written into the docs `shots` map.
  '_smoke-settings-llm': {
    topic: '_smoke',
    steps: async ({ app, page }) => {
      await openInlineSettings(app, page, 'llm');
    },
  },
};

/**
 * ah-* / ep-* keys (agent-hub SERVER dashboards, internal portal) are
 * WEB/server screens per the task's explicit scope — they render in a browser against a separate Next.js app, not the Electron
 * host. Deliberately absent from `scenarios` (not even as skip entries) so
 * the matrix only enumerates keys this harness could ever plausibly own.
 * See README.md "Out of scope: web/server keys" for the full list.
 */
export const WEB_SERVER_KEYS_OUT_OF_SCOPE = [
  'ah-dashboard', 'ah-workboard', 'ah-worklog', 'ah-inbox', 'ah-report', 'ah-subscription',
  'orion-login', 'orion-attendance', 'orion-attendance-2', 'orion-attendance-3', 'orion-approval', 'orion-parking',
  'orion-meeting-room', 'orion-meeting-room-2', 'orion-meeting-room-3', 'orion-meeting-room-4', 'orion-meeting-room-5',
  'orion-video-call', 'orion-video-call-2', 'orion-video-call-3', 'orion-video-call-4',
  'orion-portal', 'orion-portal-2',
] as const;

/**
 * meeting-* / local-indexer-* keys depict those plugins' own UI (the meeting
 * panel and minutes, the indexer's folders, scan and search), built from their
 * own repositories. This harness seeds only the fixture plugins under
 * `test/fixtures/e2e-plugins`, so it reads nothing outside this repository, and
 * a fixture cannot honestly stand in for another product's screens. The keys
 * are therefore deliberately absent from `scenarios`, as the web/server keys
 * above are. Their committed images stay as published; reshooting them belongs
 * to the plugin's own repository.
 */
export const PLUGIN_REPOSITORY_KEYS_OUT_OF_SCOPE = [
  'meeting-upcoming', 'meeting-minutes', 'meeting-minutes-2', 'meeting-minutes-3',
  'local-indexer-add-folder', 'local-indexer-indexing', 'local-indexer-home',
  'local-indexer-index-search', 'local-indexer-search', 'local-indexer-search-2',
  'local-indexer-search-3',
] as const;
