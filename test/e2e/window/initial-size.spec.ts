// Verify native initial geometry.
import { test, expect } from "@playwright/test";
import { ElectronApplication } from "playwright";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIsolatedElectronEnv, launchElectron } from "../ui/seeded-electron.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_MAIN = resolve(HERE, "../../../dist/src/main/main.js");

test.describe("initial window size", () => {
  test.skip(!existsSync(DIST_MAIN), "dist/src/main/main.js not built — skipping");
  let app: ElectronApplication | undefined;
  let tempHome: string | undefined;
  let userDataDir: string | undefined;

  async function launch(): Promise<ElectronApplication> {
    tempHome = mkdtempSync(resolve(tmpdir(), "ave-e2e-home-"));
    userDataDir = mkdtempSync(resolve(tmpdir(), "ave-e2e-initial-size-"));
    app = await launchElectron({
      args: [DIST_MAIN, `--user-data-dir=${userDataDir}`, "--no-sandbox"],
      env: buildIsolatedElectronEnv({
        HOME: tempHome,
        USERPROFILE: tempHome,
        AVE_HOME: resolve(tempHome, ".ave"),
        AVE_DEV: "1",
        AVE_E2E: "1",
        NODE_ENV: "test",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      }),
      timeout: 30_000,
    });
    await app.firstWindow();
    return app;
  }

  test.afterEach(async () => {
    await app?.close();
    app = undefined;
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  });

  test("opens centered at 1243 by 768 with a 360px minimum width", async () => {
    const launched = await launch();
    const { bounds, workArea, minimumSize } = await launched.evaluate(({ BrowserWindow, screen }) => {
      const [win] = BrowserWindow.getAllWindows();
      if (!win) throw new Error("main BrowserWindow was not created");
      return { bounds: win.getBounds(), workArea: screen.getPrimaryDisplay().workArea, minimumSize: win.getMinimumSize() };
    });
    const width = Math.min(1243, workArea.width);
    const height = Math.min(768, workArea.height);
    expect(Math.abs(bounds.width - width)).toBeLessThanOrEqual(8);
    expect(Math.abs(bounds.height - height)).toBeLessThanOrEqual(8);
    expect(Math.abs(bounds.x - (workArea.x + Math.round((workArea.width - width) / 2)))).toBeLessThanOrEqual(8);
    expect(Math.abs(bounds.y - (workArea.y + Math.round((workArea.height - height) / 2)))).toBeLessThanOrEqual(8);
    expect(minimumSize[0]).toBe(360);
  });
});
