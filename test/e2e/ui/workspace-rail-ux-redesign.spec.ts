import { test, expect } from "./fixtures";
import { type ElectronApplication, type Page } from "playwright";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildE2eBaseSettings, buildIsolatedElectronEnv, launchElectron } from "./seeded-electron";
import type { AgentSpawnEvent } from "../../../src/shared/subagent-events.js";
import { TEST_IDS, chatSidePanelLauncherTestId } from "../../../src/shared/test-ids.js";
import { FONT_SIZE_SCALE_VALUES } from "../../../src/shared/appearance-font.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const MAIN_ENTRY = resolve(REPO_ROOT, "dist/src/main/main.js");
const CLEANUP_RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

/**
 * Workspace-rail UX redesign (vertical resize, browser de-nest + search Popover,
 * file-source segment, subagent viewer). Drives the packaged renderer against a
 * real, allow-listed project folder.
 */
test.describe("workspace rail UX redesign", () => {
  test.skip(!existsSync(MAIN_ENTRY), "dist/src/main/main.js not built; run bun run build first");

  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let tempHome: string;
  let workspaceDir: string;

  async function launch() {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      app = await launchElectron({
        args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, "--no-sandbox"],
        env: buildIsolatedElectronEnv({
          HOME: tempHome,
          USERPROFILE: tempHome,
          AVE_HOME: resolve(tempHome, ".ave"),
          AVE_DEV: "1",
          AVE_E2E: "1",
          AVE_MAIN_ENTRY: MAIN_ENTRY,
          NODE_ENV: "test",
          ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
        }),
        timeout: 30_000,
      });
      try {
        page = await app.firstWindow();
        await page.locator('[data-testid="main-toolbar"]').first().waitFor({ state: "visible", timeout: 60_000 });
        return;
      } catch (err) {
        lastError = err;
        await app?.close().catch(() => {});
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Electron launch failed");
  }

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(resolve(tmpdir(), "ave-wsrail-ux-user-data-"));
    tempHome = mkdtempSync(resolve(tmpdir(), "ave-wsrail-ux-home-"));
    workspaceDir = resolve(tempHome, ".ave", "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(resolve(workspaceDir, "architecture.md"), "# Architecture\n\nmarker\n", "utf-8");
    writeFileSync(
      resolve(userDataDir, "ave-settings.json"),
      JSON.stringify(buildE2eBaseSettings(true), null, 2) + "\n",
      "utf-8",
    );
    await launch();
  });

  test.afterEach(async () => {
    await app?.close().catch(() => {});
    if (userDataDir) rmSync(userDataDir, CLEANUP_RM_OPTIONS);
    if (tempHome) rmSync(tempHome, CLEANUP_RM_OPTIONS);
  });

  test("file tab: directory/session segment toggle (default directory, session disabled empty)", async () => {
    await page.setViewportSize({ width: 1400, height: 840 });
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    await expect(page.getByTestId(TEST_IDS.chatSidePanel)).toBeVisible();
    await page.getByTestId(chatSidePanelLauncherTestId("file-browser")).click();

    // Directory is the default source; the project file is listed there.
    await expect(page.getByTestId("chat-side-panel-file-source-directory")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("chat-side-panel-fs-file").filter({ hasText: "architecture.md" })).toBeVisible();

    // No chat has run, so there are no session artifacts → the segment is disabled
    // with a 0 count.
    const sessionSeg = page.getByTestId("chat-side-panel-file-source-session");
    await expect(sessionSeg).toBeDisabled();
    await expect(page.getByTestId("chat-side-panel-file-source-session-count")).toHaveText("0");

    // R3: the segment strip is compact — its total footprint stays ~24-28px so
    // it does not crowd the narrow file pane. Each button is 24px (h-6).
    const dirBtnBox = await page.getByTestId("chat-side-panel-file-source-directory").boundingBox();
    expect(dirBtnBox).not.toBeNull();
    expect(dirBtnBox!.height).toBeLessThanOrEqual(26);
    const stripBox = await page.getByTestId("chat-side-panel-file-source-segment").boundingBox();
    expect(stripBox).not.toBeNull();
    expect(stripBox!.height).toBeLessThanOrEqual(30);

    // R3: no dead search — the search box is not rendered on the Directory
    // segment (ProjectRootsBrowser has no query wiring).
    await expect(page.getByTestId("chat-preview-search")).toHaveCount(0);

    const shot = await page.getByTestId(TEST_IDS.chatSidePanel).screenshot();
    await test.info().attach("file-source-segment.png", { contentType: "image/png", body: shot });
  });

  test("file tab: the vertical separator keeps a 20px drag hit area at every font scale", async () => {
    await page.setViewportSize({ width: 1400, height: 840 });
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    await page.getByTestId(chatSidePanelLauncherTestId("file-browser")).click();

    const splitter = page.getByTestId("chat-side-panel-file-splitter");
    await expect(splitter).toBeVisible();
    const originalScale = await page.evaluate(() => document.documentElement.style.getPropertyValue("--ave-font-size-scale"));
    const rootFontSizes = new Set<number>();
    try {
      for (const sizeScale of FONT_SIZE_SCALE_VALUES) {
        const rootFontSize = await page.evaluate((scale) => {
          document.documentElement.style.setProperty("--ave-font-size-scale", String(scale));
          return Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
        }, sizeScale);
        rootFontSizes.add(rootFontSize);
        const box = await splitter.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height, `separator hit area at font scale ${sizeScale}`).toBeGreaterThanOrEqual(20);
      }
      expect(rootFontSizes.size).toBe(FONT_SIZE_SCALE_VALUES.length);
    } finally {
      await page.evaluate((scale) => {
        if (scale) document.documentElement.style.setProperty("--ave-font-size-scale", scale);
        else document.documentElement.style.removeProperty("--ave-font-size-scale");
      }, originalScale);
    }

    const shot = await page.getByTestId(TEST_IDS.chatSidePanel).screenshot();
    await test.info().attach("separator-drag-zone.png", { contentType: "image/png", body: shot });
  });

  test("file tab: vertical splitter persists across restart", async () => {
    await page.setViewportSize({ width: 1400, height: 840 });
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    await page.getByTestId(chatSidePanelLauncherTestId("file-browser")).click();

    const splitLayout = page.getByTestId("chat-side-panel-file-split-layout");
    await expect(splitLayout).toBeVisible();
    const before = await splitLayout.evaluate((el) => (el as HTMLElement).style.gridTemplateRows);

    // Keyboard-drive the splitter (deterministic vs a pixel drag) and confirm it
    // moved, then persisted the new ratio.
    const splitter = page.getByTestId("chat-side-panel-file-splitter");
    await splitter.focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
    await expect
      .poll(async () => splitLayout.evaluate((el) => (el as HTMLElement).style.gridTemplateRows))
      .not.toBe(before);
    const afterDrag = await splitLayout.evaluate((el) => (el as HTMLElement).style.gridTemplateRows);

    // Restart the app against the same user-data dir; the split ratio survives.
    await app.close();
    await launch();
    await page.setViewportSize({ width: 1400, height: 840 });
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    await page.getByTestId(chatSidePanelLauncherTestId("file-browser")).click();
    await expect
      .poll(async () =>
        page.getByTestId("chat-side-panel-file-split-layout").evaluate((el) => (el as HTMLElement).style.gridTemplateRows),
      )
      .toBe(afterDrag);
  });

  test("browser tab: single address bar and searchable visited-page list", async () => {
    // Two local HTML artifacts supply distinct visited rows without a network request.
    await app.close();
    const browserSessionId = "b2000000-bb11-4cc2-8dd3-eeeeeeeeeeee";
    const sessionsDir = resolve(tempHome, ".ave", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const pages = ["Alpha marker", "Beta notes"];
    const history = [
      { role: "user", content: "Show the two local pages." },
      { role: "assistant", content: "", toolCalls: pages.map((title, index) => ({
        id: `visited-${index}`, name: "render_html", input: { title },
      })) },
      ...pages.map((title, index) => ({
        role: "tool_result", toolUseId: `visited-${index}`, toolName: "render_html",
        content: JSON.stringify({ kind: "ave.render_html", title, html: `<p>${title}</p>` }),
      })),
    ];
    writeFileSync(resolve(sessionsDir, `${browserSessionId}.jsonl`), history.map((row) => JSON.stringify(row)).join("\n") + "\n");
    writeFileSync(resolve(sessionsDir, ".active-session.json"), JSON.stringify({
      mainActiveMode: "resume", mainActiveSessionId: browserSessionId, updatedAt: new Date().toISOString(),
    }));
    await launch();
    await page.setViewportSize({ width: 1400, height: 840 });
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    await page.getByTestId(chatSidePanelLauncherTestId("browser")).click();

    const panel = page.getByTestId(TEST_IDS.chatSidePanel);
    // Exactly ONE address bar (the duplicated viewer header is suppressed).
    await expect(panel.getByTestId("chat-side-panel-browser-address")).toHaveCount(1);
    // The visited-page list occupies the upper pane and owns its search field.
    await expect(panel.getByTestId("chat-side-panel-browser-split-layout")).toBeVisible();
    const visited = panel.getByTestId("chat-side-panel-browser-visited");
    await expect(visited).toBeVisible();
    const rows = visited.getByTestId("chat-side-panel-browser-row");
    await expect(rows).toHaveCount(2);
    const search = visited.getByTestId("chat-preview-search");
    await expect(search).toBeVisible();
    await search.fill("marker");
    await expect(search).toHaveValue("marker");
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("Alpha marker");
    await expect(visited).not.toContainText("Beta notes");
    await search.clear();
    await expect(rows).toHaveCount(2);

    const shot = await panel.screenshot();
    await test.info().attach("browser-single-address-visited-search.png", { contentType: "image/png", body: shot });
  });

  test("subagent tab: opens from the launcher and shows the empty state", async () => {
    await page.setViewportSize({ width: 1400, height: 840 });
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    await expect(page.getByTestId(chatSidePanelLauncherTestId("subagent"))).toBeVisible();
    // side-chat is a first-class launcher item alongside sub-agent — both are
    // live surfaces, both openable from the same empty-state picker.
    await expect(page.getByTestId(chatSidePanelLauncherTestId("side-chat"))).toBeVisible();

    await page.getByTestId(chatSidePanelLauncherTestId("subagent")).click();
    await expect(page.getByTestId("chat-side-panel-tab-subagent")).toBeVisible();
    // No spawns in a fresh session → empty state.
    await expect(page.getByTestId("chat-side-panel-subagent-empty")).toBeVisible();

    const shot = await page.getByTestId(TEST_IDS.chatSidePanel).screenshot();
    await test.info().attach("subagent-tab-empty.png", { contentType: "image/png", body: shot });
  });

  test("subagent tab: a spawn + its resume (shared childSessionId) render as ONE unified, live-growing transcript", async () => {
    // Inject the real `ave:agent-spawn:event` stream (the same channel the main
    // process forwards on) so the renderer's live spawn hook + the viewer's
    // groupSubAgentSessions run end-to-end without a real LLM. The original spawn
    // and its resume are two separate agent_spawn calls (two spawnIds/toolUseIds)
    // that share ONE childSessionId — the viewer must unify them into a single
    // row whose transcript concatenates both segments.
    await page.setViewportSize({ width: 1400, height: 840 });
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    await page.getByTestId(chatSidePanelLauncherTestId("subagent")).click();
    await expect(page.getByTestId("chat-side-panel-tab-subagent")).toBeVisible();

    // A tile keeps only the frames its own conversation spawned, so every
    // injected frame has to name the conversation this window is showing —
    // exactly what the real spawn path stamps.
    const parentSessionId = await page.evaluate(
      async () => (await (window as unknown as {
        aveApi: { chatSessions: () => Promise<{ current: string }> };
      }).aveApi.chatSessions()).current,
    );
    const sendSpawn = async (event: Omit<AgentSpawnEvent, "parentSessionId">): Promise<void> => {
      await app.evaluate(({ BrowserWindow }, ev) => {
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
        if (!win) return;
        win.webContents.send("ave:agent-spawn:event", ev);
      }, { ...event, parentSessionId });
    };

    const CHILD = "e2e-child-session";
    // 1) original spawn runs to an INCOMPLETE finish (learns its childSessionId
    //    on `done`, the first phase to carry the join key).
    await sendSpawn({ spawnId: "e2e-orig", type: "start", taskState: "TASK_STATE_SUBMITTED", title: "E2E research", instructions: "E2E prompt", toolUseId: "tu-orig" });
    await sendSpawn({
      spawnId: "e2e-orig",
      type: "done",
      taskState: "TASK_STATE_INPUT_REQUIRED",
      status: "waiting",
      summary: "partial",
      toolCallCount: 2,
      childSessionId: CHILD,
      suspension: { reason: "budget", resumeId: CHILD },
      entries: [{ kind: "assistant", text: "ORIGINAL_SEGMENT", streaming: false }],
    });

    const detail = page.getByTestId("chat-side-panel-subagent-detail");
    await expect(page.getByTestId("chat-side-panel-subagent-row")).toHaveCount(1);
    await expect(detail.getByTestId("chat-side-panel-subagent-transcript")).toBeVisible();
    await expect(detail).toContainText("E2E prompt");
    await expect(detail).toContainText("ORIGINAL_SEGMENT");

    // 2) a resume (separate spawnId, SAME childSessionId) starts and streams a
    //    growing tail. The unified transcript's prefix (the original segment)
    //    must stay stable while the tail grows — no flicker / re-mount.
    await sendSpawn({ spawnId: "e2e-resume", type: "start", taskState: "TASK_STATE_INPUT_REQUIRED", title: "(sub-agent)", instructions: "resume prompt", toolUseId: "tu-resume", childSessionId: CHILD });
    await sendSpawn({
      spawnId: "e2e-resume",
      type: "activity",
      taskState: "TASK_STATE_WORKING",
      toolCallCount: 1,
      childSessionId: CHILD,
      entries: [{ kind: "assistant", text: "RESUME_TAIL_A", streaming: false }],
    });

    // Still ONE row; prefix stable, first tail chunk appended.
    await expect(page.getByTestId("chat-side-panel-subagent-row")).toHaveCount(1);
    await expect(detail).toContainText("ORIGINAL_SEGMENT");
    await expect(detail).toContainText("RESUME_TAIL_A");

    await sendSpawn({
      spawnId: "e2e-resume",
      type: "done",
      taskState: "TASK_STATE_COMPLETED",
      status: "done",
      summary: "done",
      toolCallCount: 2,
      childSessionId: CHILD,
      entries: [
        { kind: "assistant", text: "RESUME_TAIL_A", streaming: false },
        { kind: "assistant", text: "RESUME_TAIL_B", streaming: false },
      ],
    });

    // Final assertion: ONE row, and the concatenated transcript is ordered
    // original → resume tail A → resume tail B (stable prefix, grown tail).
    await expect(page.getByTestId("chat-side-panel-subagent-row")).toHaveCount(1);
    await expect(detail).toContainText("RESUME_TAIL_B");
    const order = await detail.evaluate((el) => {
      const text = el.textContent ?? "";
      return {
        prompt: text.indexOf("E2E prompt"),
        orig: text.indexOf("ORIGINAL_SEGMENT"),
        tailA: text.indexOf("RESUME_TAIL_A"),
        tailB: text.indexOf("RESUME_TAIL_B"),
      };
    });
    expect(order.prompt).toBeGreaterThanOrEqual(0);
    expect(order.orig).toBeGreaterThan(order.prompt);
    expect(order.tailA).toBeGreaterThan(order.orig);
    expect(order.tailB).toBeGreaterThan(order.tailA);
    // The row carries the ORIGINAL's title (one logical agent = one name).
    await expect(page.getByTestId("chat-side-panel-subagent-row")).toContainText("E2E research");

    const shot = await page.getByTestId(TEST_IDS.chatSidePanel).screenshot();
    await test.info().attach("subagent-tab-unified-resume.png", { contentType: "image/png", body: shot });
  });
});
