// Verify real approval mounting and keyboard decisions; missing wiring otherwise times out into denial.
import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  MAIN_ENTRY,
  builtMainExists,
  buildE2eBaseSettings,
  buildIsolatedElectronEnv,
  launchElectron,
} from "./seeded-electron.js";
import { TEST_IDS } from "../../../src/shared/test-ids.js";

const SEEDED_SESSION_ID = "abcdabcd-1111-4222-8333-444444444444";

// Session ownership determines which tile docks the request.
const OUT_OF_DIR_REQUEST = {
  id: "release-check-1",
  sessionId: SEEDED_SESSION_ID,
  category: "tool",
  kind: "out-of-allowed-dir",
  allowedChoices: ["allow-once", "allow-always", "deny-once"],
  toolName: "read_file",
  toolCategory: "read",
  args: { path: "C:/ProgramData/ave/config.json" },
  reason: "release check",
  source: "builtin",
  createdAt: Date.now(),
  requireExplicit: false,
  target: { filePath: "C:/ProgramData/ave/config.json" },
  outOfAllowedDir: {
    candidatePath: "C:/ProgramData/ave/config.json",
    suggestedParent: "C:/ProgramData/ave",
    currentAllowed: ["C:/work"],
    adjacencyWarnings: [],
  },
};

test.describe("release check — docked approval card", () => {
  test.skip(!builtMainExists(), "dist not built; run bun run build first");

  let app: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    const userDataDir = mkdtempSync(resolve(tmpdir(), "ave-rel-approval-ud-"));
    const tempHome = mkdtempSync(resolve(tmpdir(), "ave-rel-approval-home-"));
    writeFileSync(
      resolve(userDataDir, "ave-settings.json"),
      JSON.stringify(buildE2eBaseSettings(true, "ko"), null, 2),
      "utf-8",
    );
    // Seed a session so startup can mount the chat surface.
    const sessionId = SEEDED_SESSION_ID;
    const sessionsDir = resolve(tempHome, ".ave", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      resolve(sessionsDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({ role: "user", content: "릴리스 점검" }),
        JSON.stringify({ role: "assistant", content: "확인했습니다." }),
      ].join("\n") + "\n",
      "utf-8",
    );
    writeFileSync(
      resolve(sessionsDir, `${sessionId}.meta.json`),
      JSON.stringify({ title: "release check" }, null, 2),
      "utf-8",
    );
    writeFileSync(
      resolve(sessionsDir, ".active-session.json"),
      JSON.stringify({ mainActiveMode: "resume", mainActiveSessionId: sessionId, updatedAt: new Date().toISOString() }),
      "utf-8",
    );

    app = await launchElectron({
      // Isolate the runtime profile before startup to avoid singleton-lock collisions.
      // Environment-only profile configuration is too late; HOME also points to scratch.
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, "--no-sandbox"],
      env: buildIsolatedElectronEnv({
        HOME: tempHome,
        USERPROFILE: tempHome,
        AVE_HOME: resolve(tempHome, ".ave"),
        AVE_USER_DATA_DIR: userDataDir,
        AVE_DEV: "1",
        AVE_E2E: "1",
        AVE_MAIN_ENTRY: MAIN_ENTRY,
      }) as Record<string, string>,
    });
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.locator('[data-testid="main-toolbar"]').first().waitFor({ timeout: 30_000 });
  });

  test.afterEach(async () => {
    await app?.close().catch(() => {});
  });

  test("boots with no renderer error", async () => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    // A visible persistent toolbar proves the renderer mounted.
    await expect(page.getByTestId("main-toolbar")).toBeVisible({ timeout: 30_000 });
    expect(errors, `renderer threw: ${errors.join(" | ")}`).toEqual([]);
  });

  test("a real approval request mounts the card, and the target tracks focus", async () => {
    await expect(page.locator("body")).toBeVisible({ timeout: 30_000 });

    // Resend after mount so slow first paint cannot appear as a subscription failure.
    const bridgeReady = await page.evaluate(
      () => typeof (window as any).ave?.approval?.onRequest === "function",
    );
    expect(bridgeReady, "preload approval bridge missing").toBe(true);

    // Prove event delivery before attributing missing cards to approval wiring.
    await page.evaluate(() => {
      (window as any).__relSeen = [];
      (window as any).ave.approval.onRequest((r: unknown) => {
        (window as any).__relSeen.push(r);
      });
    });

    const overlay = page.getByTestId(TEST_IDS.approvalDock);
    let attempt = 0;
    await expect.poll(async () => {
      await app.evaluate(({ BrowserWindow }, payload) => {
        const win = BrowserWindow.getAllWindows()[0];
        win?.webContents.send("ave:approval:request", payload);
      }, { ...OUT_OF_DIR_REQUEST, id: `release-check-${attempt}` });
      attempt += 1;
      return overlay.count();
    }, { timeout: 10_000, intervals: [250, 500, 1_000] }).toBeGreaterThan(0);
    const seen = await page.evaluate(() => (window as any).__relSeen ?? []);
    expect(seen.length, "renderer never received the approval event").toBeGreaterThan(0);
    const kinds = await page.evaluate(() =>
      ((window as any).__relSeen ?? []).map((r: any) => r?.kind));
    expect(kinds, "kind did not survive the IPC hop").toContain("out-of-allowed-dir");

    await expect(overlay).toBeVisible({ timeout: 10_000 });

    const target = page.getByTestId("approval-decision-target");
    await expect(target).toBeVisible();
    const firstTarget = ((await target.textContent()) ?? "").trim();
    expect(firstTarget.length).toBeGreaterThan(0);

    for (const testId of ["deny-button", "allow-session-button", "approve-button"]) {
      await expect(page.getByTestId(testId)).toBeVisible();
    }

    // Focus Reject on arrival so pending composer keystrokes cannot approve accidentally.
    await expect
      .poll(async () => page.evaluate(() => {
        const el = document.activeElement;
        return !!el?.closest('[data-testid="approval-dock"]');
      }), { timeout: 5_000 })
      .toBe(true);

    await page.getByTestId(TEST_IDS.approveButton).focus();

    // Keyboard movement must update both focus and the visible grant target.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(async () => ((await target.textContent()) ?? "").trim(), { timeout: 5_000 })
      .not.toBe(firstTarget);

    const afterArrow = ((await target.textContent()) ?? "").trim();
    expect(afterArrow, "allow-always must name the parent folder").toContain("C:/ProgramData/ave");
  });
});
