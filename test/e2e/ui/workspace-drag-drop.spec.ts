import { test, expect } from "./fixtures";
import { type ElectronApplication, type Page } from "playwright";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildE2eBaseSettings, buildIsolatedElectronEnv, launchElectron } from "./seeded-electron";
import { TEST_IDS, chatSidePanelLauncherTestId } from "../../../src/shared/test-ids.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const MAIN_ENTRY = resolve(REPO_ROOT, "dist/src/main/main.js");

// Synthetic drops cannot create OS-backed file paths; test safe no-op behavior and the real post-resolution trust path.
test.describe("workspace drag-drop add-root (#1458)", () => {
  test.skip(!existsSync(MAIN_ENTRY), "dist/src/main/main.js not built; run bun run build first");

  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let tempHome: string;
  let dropTarget: string;
  let sensitiveTarget: string;
  let fileTarget: string;

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(resolve(tmpdir(), "ave-drop-user-data-"));
    tempHome = mkdtempSync(resolve(tmpdir(), "ave-drop-home-"));
    mkdirSync(resolve(tempHome, ".ave", "workspace"), { recursive: true });
    // Use a folder outside existing scope so successful acknowledgement proves authority widened.
    dropTarget = resolve(tempHome, "dropme-project");
    mkdirSync(dropTarget, { recursive: true });
    writeFileSync(resolve(dropTarget, "readme.md"), "# Dropped\n", "utf-8");
    // Sensitive directories must be denied even through acknowledgement.
    sensitiveTarget = resolve(tempHome, ".ave", "secrets");
    mkdirSync(sensitiveTarget, { recursive: true });
    fileTarget = resolve(tempHome, "loose-file.txt");
    writeFileSync(fileTarget, "not a folder\n", "utf-8");

    writeFileSync(
      resolve(userDataDir, "ave-settings.json"),
      JSON.stringify(buildE2eBaseSettings(true), null, 2) + "\n",
      "utf-8",
    );
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
    page = await app.firstWindow();
    await page.locator('[data-testid="main-toolbar"]').first().waitFor({ state: "visible", timeout: 60_000 });
  });

  test.afterEach(async () => {
    await app?.close().catch(() => {});
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  });

  async function openRootsZone(): Promise<{ x: number; y: number }> {
    await page.setViewportSize({ width: 1400, height: 840 });
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    await expect(page.getByTestId(TEST_IDS.chatSidePanel)).toBeVisible();
    await page.getByTestId(chatSidePanelLauncherTestId("file-browser")).click();
    const zone = page.getByTestId("chat-side-panel-project-roots");
    await expect(zone).toBeVisible();
    const box = await zone.boundingBox();
    if (!box) throw new Error("project-roots drop zone has no bounding box");
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  test("a real drop fires the handler + real webUtils bridge and is a safe no-op under CDP (no widen)", async () => {
    const { x, y } = await openRootsZone();
    // Use the production file-path bridge rather than a synthetic path property.
    const bridgeType = await page.evaluate(() => typeof window.aveDrop?.resolveDroppedPaths);
    expect(bridgeType).toBe("function");

    // Synthetic drops resolve no OS-backed path; capture the real bridge result.
    await page.evaluate(() => {
      const w = window as unknown as { __dropResolved?: string[] };
      const el = document.querySelector('[data-testid="chat-side-panel-project-roots"]');
      el?.addEventListener(
        "drop",
        (e) => {
          const files = (e as DragEvent).dataTransfer?.files;
          w.__dropResolved = files ? window.aveDrop.resolveDroppedPaths(files) : ["<no-dt>"];
        },
        { capture: true, once: true },
      );
    });
    const cdp = await page.context().newCDPSession(page);
    const data = { items: [], files: [dropTarget], dragOperationsMask: 1 };
    await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", x, y, data });
    await cdp.send("Input.dispatchDragEvent", { type: "drop", x, y, data });
    await cdp.detach();

    // No resolved path means a safe no-op without acknowledgement or scope changes.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __dropResolved?: string[] }).__dropResolved))
      .toEqual([]);
    await page.waitForTimeout(300);
    await expect(page.getByTestId("chat-side-panel-root-warning")).toHaveCount(0);
    await expect(page.getByTestId("chat-side-panel-op-error")).toHaveCount(0);
  });

  test("real pipeline: a valid dropped folder adds as a root only after an explicit ack", async () => {
    await openRootsZone();
    const prep = await page.evaluate(
      (p) => window.ave.workspace.dropPrepare(p),
      dropTarget,
    );
    expect(prep.ok).toBe(true);
    expect(prep.pendingPath).toBe(dropTarget);
    expect(typeof prep.ackToken).toBe("string");

    // Compare canonical roots while acknowledgement uses the raw path; temporary paths may resolve through aliases.
    const canonicalDrop = realpathSync(dropTarget);

    const before = await page.evaluate(() => window.ave.workspace.listRoots());
    expect((before.roots ?? []).some((r) => r.path === canonicalDrop)).toBe(false);

    // Confirm the token rather than echoing a path to prove persisted acknowledgement.
    const done = await page.evaluate(
      (tok) => window.ave.workspace.pickRoot({ ackToken: tok }),
      prep.ackToken as string,
    );
    expect(done.ok).toBe(true);
    expect(done.added).toBe(canonicalDrop);

    const after = await page.evaluate(() => window.ave.workspace.listRoots());
    expect((after.roots ?? []).some((r) => r.path === canonicalDrop)).toBe(true);
  });

  test("real pipeline: a Layer-0 sensitive folder is hard-denied and mints no ack token", async () => {
    await openRootsZone();
    const prep = await page.evaluate(
      (p) => window.ave.workspace.dropPrepare(p),
      sensitiveTarget,
    );
    expect(prep.ok).toBe(false);
    // Assert stable localized error codes rather than validator prose.
    expect(prep.error).toBe("sensitive-path");
    expect(prep.ackToken).toBeUndefined();
    const roots = await page.evaluate(() => window.ave.workspace.listRoots());
    expect((roots.roots ?? []).some((r) => r.path === sensitiveTarget)).toBe(false);
  });

  test("real pipeline: a dropped plain file is rejected (not-a-dir) — no parent inference", async () => {
    await openRootsZone();
    const prep = await page.evaluate((p) => window.ave.workspace.dropPrepare(p), fileTarget);
    expect(prep.ok).toBe(false);
    expect(prep.error).toBe("not-a-dir");
    expect(prep.ackToken).toBeUndefined();
  });

  test("real pipeline: a dir swapped for a file between prepare and ack is refused (TOCTOU)", async () => {
    await openRootsZone();
    // Replace the directory after token creation; acknowledgement must re-stat before widening scope.
    const toctouTarget = resolve(tempHome, "toctou-project");
    mkdirSync(toctouTarget, { recursive: true });
    const prep = await page.evaluate((p) => window.ave.workspace.dropPrepare(p), toctouTarget);
    expect(prep.ok).toBe(true);
    expect(typeof prep.ackToken).toBe("string");
    rmSync(toctouTarget, { recursive: true, force: true });
    writeFileSync(toctouTarget, "now a file\n", "utf-8");
    const done = await page.evaluate(
      (tok) => window.ave.workspace.pickRoot({ ackToken: tok }),
      prep.ackToken as string,
    );
    expect(done.ok).toBe(false);
    expect(done.error).toBe("not-a-dir");
    const canonical = realpathSync(toctouTarget);
    const after = await page.evaluate(() => window.ave.workspace.listRoots());
    expect((after.roots ?? []).some((r) => r.path === canonical || r.path === toctouTarget)).toBe(false);
    rmSync(toctouTarget, { force: true });
  });
});
