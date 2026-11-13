import { execFileSync } from "node:child_process";
// Verify native initial geometry.
import { test, expect } from "@playwright/test";
import { ElectronApplication, type Page } from "playwright";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIsolatedElectronEnv, launchElectron, quitElectron } from "../ui/seeded-electron.js";
import { withPageWindow } from "../ui/renderer-events.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_MAIN = resolve(HERE, "../../../dist/src/main/main.js");

test.describe("initial window size", () => {
  test.skip(!existsSync(DIST_MAIN), "dist/src/main/main.js not built — skipping");
  let app: ElectronApplication | undefined;
  let tempHome: string | undefined;
  let userDataDir: string | undefined;

  async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
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
    if (process.env.AVE_E2E_STARTUP_DIAGNOSTICS === "1") {
      const child = app.process();
      child.stdout?.on("data", (data: Buffer) => process.stdout.write(data));
      child.stderr?.on("data", (data: Buffer) => process.stderr.write(data));
      child.once("exit", (code, signal) => {
        console.log("Native root exit", { code, signal });
        if (process.platform === "linux") {
          const group = execFileSync("ps", ["-eo", "pid,ppid,pgid,args"], { encoding: "utf8" })
            .split("\n").filter(line => line.trim().split(/\s+/)[2] === String(child.pid));
          console.log("Native remaining group", group);
        }
      });
      child.once("close", (code, signal) => console.log("Native pipes closed", { code, signal }));
    }
    const page = await app.firstWindow();
    return { app, page };
  }

  test.afterEach(async () => {
    if (process.env.AVE_E2E_STARTUP_DIAGNOSTICS === "1") console.log("Begin native quit");
    if (app) await quitElectron(app);
    if (process.env.AVE_E2E_STARTUP_DIAGNOSTICS === "1") console.log("Native quit complete");
    app = undefined;
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  });

  test("opens centered at 1243 by 768 with a 360px minimum width", async () => {
    const { app: launched, page } = await launch();
    const { bounds, minimumSize } = await withPageWindow(launched, page, (window) => ({
      bounds: window.getBounds(), minimumSize: window.getMinimumSize(),
    }));
    const workArea = await launched.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
    const width = Math.min(1243, workArea.width);
    const height = Math.min(768, workArea.height);
    expect(Math.abs(bounds.width - width)).toBeLessThanOrEqual(8);
    expect(Math.abs(bounds.height - height)).toBeLessThanOrEqual(8);
    expect(Math.abs(bounds.x - (workArea.x + Math.round((workArea.width - width) / 2)))).toBeLessThanOrEqual(8);
    expect(Math.abs(bounds.y - (workArea.y + Math.round((workArea.height - height) / 2)))).toBeLessThanOrEqual(8);
    expect(minimumSize[0]).toBe(360);
  });
});
