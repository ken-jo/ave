import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { closeNativeFixture, launchNativeFixture } from "./native-fixture-runtime.js";
import { buildIsolatedElectronEnv, launchElectron, REPO_ROOT } from "./seeded-electron.js";
import type { CursorCase } from "../../manual/window-cursor-repro.js";

const cases: CursorCase[] = [false, true].flatMap(vibrancy => [false, true].flatMap(rootCss => [false, true].map(edgeCover =>
  ({ vibrancy, rootCss, edgeCover, host: "browser", nativeInset: 0 }))));
cases.push({ vibrancy: true, rootCss: false, edgeCover: false, host: "child", nativeInset: 0 });
cases.push({ vibrancy: true, rootCss: false, edgeCover: false, host: "child", nativeInset: 4 });
cases.push({ vibrancy: false, rootCss: false, edgeCover: false, host: "browser", nativeInset: 0, nativeFrame: true });

for (const config of cases) {
  const name = `${config.host}-glass-${config.vibrancy}-root-${config.rootCss}-cover-${config.edgeCover}-inset-${config.nativeInset}-frame-${Boolean(config.nativeFrame)}`;
  test(`window cursor configuration ${name}`, async () => {
    const testInfo = test.info();
    const snapshotPath = testInfo.outputPath("configuration.json");
    const app = await launchNativeFixture("ave-window-cursor-", async ({ runtime, assets }) => {
      const main = join(assets, "main.cjs");
      await build({ entryPoints: [join(REPO_ROOT, "test/manual/window-cursor-repro.ts")], outfile: main,
        bundle: true, format: "cjs", platform: "node", external: ["electron"], logLevel: "silent" });
      return launchElectron({ args: [main, `--user-data-dir=${join(runtime, "profile")}`],
        env: buildIsolatedElectronEnv({ AVE_CURSOR_REPRO_CASE: JSON.stringify(config),
          AVE_CURSOR_REPRO_STYLES: join(REPO_ROOT, "dist/src/styles.css"), AVE_CURSOR_REPRO_OUTPUT: snapshotPath }) });
    }, testInfo.project.outputDir);
    try {
      await expect.poll(async () => { try { return JSON.parse(await fs.readFile(snapshotPath, "utf8")); } catch { return null; } }).not.toBeNull();
      const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
      expect(snapshot.config).toEqual(config);
      expect(snapshot.options).not.toHaveProperty("transparent");
      expect(snapshot.options.backgroundColor).toBe("#00000000");
      expect(snapshot.options.vibrancy).toBe(config.vibrancy ? "under-window" : undefined);
      expect(snapshot.native.resizable).toBe(true);
      expect(snapshot.native.focused).toBe(false);
      expect(snapshot.renderer.html.cursor).toBe("auto");
      expect(snapshot.renderer.body.cursor).toBe("auto");
      expect(snapshot.nativeHover).toBe("not-measured");
      if (process.platform === "darwin") {
        expect(snapshot.options.titleBarStyle).toBe(config.nativeFrame ? undefined : "hiddenInset");
        expect(snapshot.options.frame).toBe(true);
      }
      if (config.edgeCover) expect(snapshot.renderer.edges.every((edge: { stack: { id: string }[] }) => edge.stack[0]?.id === "edge-cover")).toBe(true);
      if (config.nativeInset) expect(snapshot.native.children[0]).toEqual({ x: 4, y: 4, width: 942, height: 726 });
      await testInfo.attach("configuration", { path: snapshotPath, contentType: "application/json" });
      await (await app.firstWindow()).screenshot({ path: testInfo.outputPath("window.png") });
    } finally {
      await closeNativeFixture(app, async () => {});
    }
  });
}
