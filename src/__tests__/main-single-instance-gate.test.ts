/** A process without the single-instance lock must quit before bootstrap. Inspect source to avoid entry-point side effects. */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

describe("main.ts — single-instance gate on app.whenReady", () => {
  const source = readFileSync("src/main.ts", "utf-8").replace(/\r\n/g, "\n");

  function extractSingleInstanceElseBlock(text: string): string | null {
    const m = text.match(/if\s*\(\s*!gotSingleInstanceLock\s*\)\s*\{[\s\S]*?\}\s*else\s*\{/);
    if (!m || m.index === undefined) return null;
    const elseOpen = m.index + m[0].length - 1; // position of '{'
    let depth = 1;
    let i = elseOpen + 1;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    return depth === 0 ? text.slice(elseOpen + 1, i - 1) : null;
  }

  it("exactly one `app.whenReady().then` call exists in the file", () => {
    const matches = source.match(/app\.whenReady\s*\(\s*\)\s*\.\s*then\s*\(/g) ?? [];
    expect(matches.length, "main.ts must register whenReady().then exactly once").toBe(1);
  });

  it("`app.whenReady().then` runs inside the primary-instance else block", () => {
    const elseBlock = extractSingleInstanceElseBlock(source);
    expect(elseBlock, "could not locate the `else` block following `if (!gotSingleInstanceLock)`").not.toBeNull();
    expect(elseBlock!).toMatch(/app\.whenReady\s*\(\s*\)\s*\.\s*then\s*\(/);
  });

  it("`app.quit()` runs immediately in the second-instance branch (no main() call)", () => {
    // Strip comments before matching so prose cannot satisfy the boot guard.
    const m = source.match(/if\s*\(\s*!gotSingleInstanceLock\s*\)\s*\{([\s\S]*?)\}\s*else\s*\{/);
    expect(m, "single-instance lock check missing").not.toBeNull();
    const negBranchCode = m![1]!
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(negBranchCode).toMatch(/app\.quit\s*\(\s*\)/);
    expect(negBranchCode, "second-instance must not bootstrap").not.toMatch(/\bmain\s*\(\s*\)/);
    expect(negBranchCode, "second-instance must not call whenReady").not.toMatch(/whenReady/);
  });

  it("calls the OS protocol setter only at the guarded src/main.ts site, and nowhere in tests", () => {
    // Every launch path must use the shared protocol-registration decision.
    const roots = ["src", "test", "scripts"];
    const files = roots.flatMap(function walk(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(path);
        return /\.(ts|tsx|mts|mjs|cjs|js)$/.test(entry.name) ? [path] : [];
      });
    });
    const callers = files
      .filter((path) => !/__tests__|main-single-instance-gate/.test(path))
      .filter((path) => /\b(set|remove)AsDefaultProtocolClient\s*[(=]/.test(readFileSync(path, "utf-8")))
      .map((path) => path.split("\\").join("/"));
    expect(callers).toEqual(["src/main.ts"]);
  });

  it("decides ave:// self-registration synchronously before the lock, with one setter", () => {
    const decision = source.indexOf("decideAveProtocolClientRegistration({");
    const markerProbe = source.indexOf(
      "probeWindowsMarker: () => getPackagedWindowsProtocolMarkerState(process.execPath)",
    );
    const protocolSetter = source.indexOf(
      'app.setAsDefaultProtocolClient("ave")',
    );
    const lock = source.indexOf("app.requestSingleInstanceLock()");

    expect(decision).toBeGreaterThanOrEqual(0);
    expect(markerProbe).toBeGreaterThan(decision);
    expect(protocolSetter).toBeGreaterThan(markerProbe);
    expect(lock).toBeGreaterThan(protocolSetter);
    expect(source.split("setAsDefaultProtocolClient(").length - 1).toBe(2);
    expect(source).toContain("if (aveProtocolClientRegistration.register) {");
    expect(source).toContain('hasUserDataDirSwitch: app.commandLine.hasSwitch("user-data-dir")');
    expect(source).toContain("defaultAveHome: defaultAveHome()");
    expect(source).not.toContain("buildDevProtocolArgs");
    expect(source).not.toContain("removeAsDefaultProtocolClient");
    expect(source).toContain(
      'aveProtocolClientRegistration.reason === "nsis-marker-unknown"',
    );
    expect(source).toContain("skipped self-registration");
    expect(source).toContain("app.whenReady().then(() => {");
    expect(source).not.toContain("ensurePackagedWindowsAveProtocolClient");
    expect(source).not.toContain("getApplicationInfoForProtocol");
    expect(source).not.toContain("app.isDefaultProtocolClient");

    const helper = readFileSync(
      "src/main/ave-protocol-registration.ts",
      "utf-8",
    );
    expect(helper).toContain('import { lstatSync } from "node:fs"');
    expect(helper).toContain(".ave-nsis-per-machine-v1");
    expect(helper).toContain("inspectMarker(markerPath, { throwIfNoEntry: false })");
    expect(helper).toContain('return "unknown"');
    expect(helper).not.toContain("realpath");
    expect(helper).not.toMatch(/\bstatSync\s*\(/);
    expect(helper).toContain("win32.parse");
    expect(helper).not.toMatch(/\blog\./);
  });

  it("a second launch without a deep link brings the primary window back; a deep link keeps handle-and-focus", () => {
    const start = source.indexOf('app.on("second-instance"');
    expect(start).toBeGreaterThanOrEqual(0);
    const handler = source.slice(start, source.indexOf("app.whenReady()", start));
    const urlBranch = handler.indexOf("if (url) {");
    const surfacePrimary = handler.indexOf('showOrCreatePrimaryMainWindow("second-instance")');
    expect(urlBranch).toBeGreaterThanOrEqual(0);
    expect(surfacePrimary).toBeGreaterThan(urlBranch);
    expect(handler.slice(urlBranch, surfacePrimary)).toMatch(/handleAveUri\(url\)[\s\S]*showMainWindow\(mainWindow\)[\s\S]*return;/);
    // Only an explicit New Window action may open another window.
    expect(handler).not.toContain("openNewMainWindow(");
  });

  it("awaits browser policy inside main before bootstrap, and continues only for an installed refusal policy", () => {
    const start = source.indexOf("async function main() {");
    const install = source.indexOf("await installSideBrowserPartitionPolicy(", start);
    const bootstrap = source.indexOf("desktopBoot.bootstrap(", start);
    expect(install).toBeGreaterThan(start);
    expect(install).toBeLessThan(bootstrap);
    const guard = source.slice(start, source.indexOf("if (isAppQuitRequested())", start));
    expect(guard).toMatch(/if \(!\(error instanceof SideBrowserPolicyInstallError\)\) throw error;/u);
    const ready = source.slice(source.indexOf("app.whenReady().then(() => {"));
    expect(ready).not.toContain("installSideBrowserPartitionPolicy(");
    expect(ready).toContain("void main().catch(");
  });

  it("creates the browser download staging folder before bootstrap can start any confined process", () => {
    // Every confined lane is admitted only by state bootstrap() sets up, and bootstrap runs inside main(). Installing the side browser's
    // session policy creates the staging folder synchronously, so it exists before any confinement projection is composed; a profile-child
    // Ave home on Windows denies only the top-level children that exist when a projection is taken.
    const opening = "async function main() {";
    const start = source.indexOf(opening);
    expect(start).toBeGreaterThanOrEqual(0);
    const callback = source.slice(start + opening.length, source.indexOf("if (isAppQuitRequested())", start));
    expect(callback).toContain("await installSideBrowserPartitionPolicy(desktopResourcePath(projectRoot));");
    expect(callback, "the policy must finish before confinement is composed").not.toMatch(/setImmediate|setTimeout|queueMicrotask/);
    const policy = readFileSync("src/main/side-browser-webview.ts", "utf-8");
    const install = policy.slice(policy.indexOf("export async function installSideBrowserPartitionPolicy(resourcePath: string): Promise<void> {"));
    expect(install.slice(0, install.indexOf("\n}\n"))).toMatch(/stagingRoot = prepareBrowserDownloadStaging\(resourcePath\);/);
  });

  it("does not reach bootstrap on an incomplete install, and awaits the policy before continuing", async () => {
    const start = source.indexOf("async function main() {") + "async function main() {".length;
    const prefix = source.slice(start, source.indexOf("if (isAppQuitRequested())", start));
    class SideBrowserPolicyInstallError extends Error {}
    // Execute the actual entry-point policy barrier without importing the entry point's app-wide side effects.
    const run = new Function("installSideBrowserPartitionPolicy", "SideBrowserPolicyInstallError", "desktopResourcePath", "projectRoot", "log", "bootstrapErrorForLog",
      `return async function () { ${prefix}\n return "bootstrapped"; }`);
    const boot = (install: () => Promise<void>) => run(install, SideBrowserPolicyInstallError, () => "/resources", "/project", { error: () => {} }, (error: unknown) => error)();
    const failure = new Error("session unavailable");
    await expect(boot(async () => { throw failure; })).rejects.toBe(failure);
    await expect(boot(async () => { throw new SideBrowserPolicyInstallError(); })).resolves.toBe("bootstrapped");
    let release!: () => void;
    let continued = false;
    const waiting = boot(() => new Promise<void>((resolve) => { release = resolve; })).then(() => { continued = true; });
    await Promise.resolve();
    expect(continued).toBe(false);
    release();
    await waiting;
    expect(continued).toBe(true);
  });
});
