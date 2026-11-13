import { sendRendererEvent } from "./renderer-events.js";
import { test, expect } from "./fixtures";
import { type ElectronApplication, type Locator, type Page } from "playwright";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setWindowSize, buildE2eBaseSettings, buildIsolatedElectronEnv, launchElectron } from "./seeded-electron";
import type { AgentSpawnEvent } from "../../../src/shared/subagent-events.js";
import { TEST_IDS, chatSidePanelLauncherTestId } from "../../../src/shared/test-ids.js";
import { FONT_SIZE_SCALE_VALUES } from "../../../src/shared/appearance-font.js";
import { showFileColumns } from "./document-preview-flow.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const MAIN_ENTRY = resolve(REPO_ROOT, "dist/src/main/main.js");
const CLEANUP_RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Element has no layout box");
  return box;
}

// Exercise workspace column sizing, file filters and grouped agent transcripts against a real project.
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

  // Files is one filtered project tree (315307c02): All / Changed / Session filters replace the former Directory/Session source
  // toggle, and the search field filters the tree.
  test("file tab: All/Changed/Session filters (default All, empty Session) and a working tree search", async () => {
    await setWindowSize(app, 1400, 840);
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    await expect(page.getByTestId(TEST_IDS.chatSidePanel)).toBeVisible();
    await page.getByTestId(chatSidePanelLauncherTestId("file-browser")).click();

    const filters = page.getByTestId("chat-side-panel-file-tree").getByRole("group");
    await expect(filters.getByRole("button")).toHaveCount(3);
    await expect(page.getByTestId("chat-side-panel-file-filter-all")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("chat-side-panel-file-filter-changed")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("chat-side-panel-file-filter-session")).toHaveText(/0$/u);
    const file = page.getByTestId("chat-side-panel-fs-file").filter({ hasText: "architecture.md" });
    await expect(file).toBeVisible();

    // The filters stay inside the tree column instead of overflowing a narrow pane.
    const treeBox = await boxOf(page.getByTestId("chat-side-panel-file-tree"));
    const filterBox = await boxOf(filters);
    expect(filterBox.x).toBeGreaterThanOrEqual(treeBox.x);
    expect(filterBox.x + filterBox.width).toBeLessThanOrEqual(treeBox.x + treeBox.width + 0.5);
    // And stay compact enough for narrow file panes.
    expect((await boxOf(page.getByTestId("chat-side-panel-file-filter-all"))).height).toBeLessThanOrEqual(26);
    expect(filterBox.height).toBeLessThanOrEqual(30);

    const search = page.getByTestId("chat-side-panel-file-tree").getByTestId("chat-preview-search");
    await search.fill("no-such-file");
    await expect(file).toHaveCount(0);
    await search.fill("architecture");
    await expect(file).toBeVisible();

    const shot = await page.getByTestId(TEST_IDS.chatSidePanel).screenshot();
    await test.info().attach("file-filters.png", { contentType: "image/png", body: shot });
  });

  // The tree and the file detail are resizable columns. Their separator is a fixed 9px bar (315307c02); it must not shrink with
  // the UI font scale or lose the full column height.
  test("file tab: the column separator keeps its fixed hit width at every font scale", async () => {
    await setWindowSize(app, 1400, 840);
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    await page.getByTestId(chatSidePanelLauncherTestId("file-browser")).click();
    await showFileColumns(page);

    const splitter = page.getByTestId("chat-side-panel-file-splitter");
    await expect(splitter).toHaveAttribute("aria-orientation", "vertical");
    const baseline = await boxOf(splitter);
    expect(baseline.width).toBeGreaterThanOrEqual(8);
    const originalScale = await page.evaluate(() => document.documentElement.style.getPropertyValue("--ave-font-size-scale"));
    const rootFontSizes = new Set<number>();
    try {
      for (const sizeScale of FONT_SIZE_SCALE_VALUES) {
        const rootFontSize = await page.evaluate((scale) => {
          document.documentElement.style.setProperty("--ave-font-size-scale", String(scale));
          return Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
        }, sizeScale);
        rootFontSizes.add(rootFontSize);
        const box = await boxOf(splitter);
        const tree = await boxOf(page.getByTestId("chat-side-panel-file-tree"));
        expect(box.width, `separator hit width at font scale ${sizeScale}`).toBe(baseline.width);
        expect(box.height, `separator spans the columns at font scale ${sizeScale}`).toBeGreaterThanOrEqual(tree.height - 1);
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

  // The former vertical split preference migrated to one persisted tree width (use-file-tree-width.ts).
  test("file tab: the tree column width persists across restart", async () => {
    await setWindowSize(app, 1400, 840);
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    await page.getByTestId(chatSidePanelLauncherTestId("file-browser")).click();
    await showFileColumns(page);

    const tree = page.getByTestId("chat-side-panel-file-tree");
    const before = await tree.evaluate((el) => (el as HTMLElement).style.width);
    // Drive the separator by keyboard for a deterministic persisted width; ArrowLeft narrows an end-edge column.
    const splitter = page.getByTestId("chat-side-panel-file-splitter");
    await splitter.focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => tree.evaluate((el) => (el as HTMLElement).style.width)).not.toBe(before);
    const afterResize = await tree.evaluate((el) => (el as HTMLElement).style.width);

    await app.close();
    await launch();
    await setWindowSize(app, 1400, 840);
    // The window layout restores the open side panel at its widened width, on its empty landing: content tabs are not
    // restored. Toggling the panel here would close it, so Files is opened from the landing.
    await expect(page.getByTestId(TEST_IDS.chatSidePanel)).toBeVisible();
    await expect(page.getByTestId("chat-side-panel-launcher")).toBeVisible();
    const restoredFiles = page.getByTestId("chat-side-panel-file-browser");
    await expect(restoredFiles).not.toBeVisible();
    await page.getByTestId(chatSidePanelLauncherTestId("file-browser")).click();
    await expect(restoredFiles).toHaveAttribute("data-file-layout", "columns");
    await expect
      .poll(async () => page.getByTestId("chat-side-panel-file-tree").evaluate((el) => (el as HTMLElement).style.width))
      .toBe(afterResize);
  });

  // A browser tab is its address row and page only (469497456); the conversation's visited pages are listed, and searched,
  // on the side panel's empty landing.
  test("browser: visited pages are searchable on the landing and a browser tab has a single address bar", async () => {
    // Local artifacts provide distinct visited rows without network requests.
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
    await setWindowSize(app, 1400, 840);
    await page.getByTestId(TEST_IDS.panePanelToggle).click();

    const panel = page.getByTestId(TEST_IDS.chatSidePanel);
    await expect(panel.getByTestId("chat-side-panel-launcher")).toBeVisible();
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
    const landingShot = await panel.screenshot();
    await test.info().attach("browser-visited-landing-search.png", { contentType: "image/png", body: landingShot });

    await page.getByTestId(chatSidePanelLauncherTestId("browser")).click();
    await expect(panel.getByTestId("chat-side-panel-tab-browser")).toBeVisible();
    await expect(panel.getByTestId("chat-side-panel-browser-address")).toHaveCount(1);
    await expect(panel.getByTestId("chat-side-panel-browser-visited")).toHaveCount(0);

    const shot = await panel.screenshot();
    await test.info().attach("browser-single-address.png", { contentType: "image/png", body: shot });
  });

  test("subagent tab: opens from the launcher and shows the empty state", async () => {
    await setWindowSize(app, 1400, 840);
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    await expect(page.getByTestId(chatSidePanelLauncherTestId("subagent"))).toBeVisible();
    await expect(page.getByTestId(chatSidePanelLauncherTestId("side-chat"))).toBeVisible();

    await page.getByTestId(chatSidePanelLauncherTestId("subagent")).click();
    await expect(page.getByTestId("chat-side-panel-tab-subagent")).toBeVisible();
    await expect(page.getByTestId("chat-side-panel-subagent-empty")).toBeVisible();

    const shot = await page.getByTestId(TEST_IDS.chatSidePanel).screenshot();
    await test.info().attach("subagent-tab-empty.png", { contentType: "image/png", body: shot });
  });

  test("subagent tab: a spawn + its resume (shared childSessionId) render as ONE unified, live-growing transcript", async () => {
    // Inject production spawn events to verify original and resumed calls form one logical transcript.
    await setWindowSize(app, 1400, 840);
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    await page.getByTestId(chatSidePanelLauncherTestId("subagent")).click();
    await expect(page.getByTestId("chat-side-panel-tab-subagent")).toBeVisible();

    // Every frame must name the displayed conversation to pass tile ownership filtering.
    const parentSessionId = await page.evaluate(
      async () => (await (window as unknown as {
        aveApi: { chatSessions: () => Promise<{ current: string }> };
      }).aveApi.chatSessions()).current,
    );
    const sendSpawn = async (event: Omit<AgentSpawnEvent, "parentSessionId">): Promise<void> => {
      await sendRendererEvent(app, page, "ave:agent-spawn:event", { ...event, parentSessionId });
    };

    const CHILD = "e2e-child-session";
    // The done frame first supplies the child-session join key.
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

    // Resumes use a new spawn id with the same child session; retain the original prefix while the tail grows.
    await sendSpawn({ spawnId: "e2e-resume", type: "start", taskState: "TASK_STATE_INPUT_REQUIRED", title: "(sub-agent)", instructions: "resume prompt", toolUseId: "tu-resume", childSessionId: CHILD });
    await sendSpawn({
      spawnId: "e2e-resume",
      type: "activity",
      taskState: "TASK_STATE_WORKING",
      toolCallCount: 1,
      childSessionId: CHILD,
      entries: [{ kind: "assistant", text: "RESUME_TAIL_A", streaming: false }],
    });

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
    await expect(page.getByTestId("chat-side-panel-subagent-row")).toContainText("E2E research");

    const shot = await page.getByTestId(TEST_IDS.chatSidePanel).screenshot();
    await test.info().attach("subagent-tab-unified-resume.png", { contentType: "image/png", body: shot });
  });
});
