import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGateScript } from "./gate-script-runner.js";

const SCRIPT = resolve(process.cwd(), "scripts/check-sandboxed-preloads.mjs");
const roots: string[] = [];

const PRELOAD_NAMES = ["preload.cjs", "audio-capture-window-preload.cjs", "floating-dock-preload.cjs", "plugin-preload.cjs", "mcp-app-preload.cjs"] as const;

/** A repo root whose `dist/src` holds every preload, each requiring only `electron` unless overridden. */
function createRoot(overrides: Record<string, string | null> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "ave-sandboxed-preloads-"));
  roots.push(root);
  const dist = join(root, "dist", "src");
  mkdirSync(dist, { recursive: true });
  for (const name of PRELOAD_NAMES) {
    const source = name in overrides ? overrides[name] : 'const { contextBridge } = require("electron");\n';
    if (source !== null) writeFileSync(join(dist, name), source, "utf-8");
  }
  for (const [name, source] of Object.entries(overrides)) {
    if (!(PRELOAD_NAMES as readonly string[]).includes(name) && source !== null) writeFileSync(join(dist, name), source, "utf-8");
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("check-sandboxed-preloads", () => {
  it("accepts sandboxed preloads that require only what a sandboxed preload can", () => {
    const root = createRoot({ "floating-dock-preload.cjs": 'require("electron"); require("node:url"); require("events"); __webpack_require__(12);\n' });
    const result = runGateScript(SCRIPT, root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[sandboxed-preloads] OK");
  });

  it("refuses node:path in the dock's preload, naming the window that would lose its bridge", () => {
    const root = createRoot({ "floating-dock-preload.cjs": 'require("electron");\nconst path = require("node:path");\n' });
    const result = runGateScript(SCRIPT, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('floating-dock-preload.cjs: require("node:path") — not available to a sandboxed preload (floating dock window (sandbox: true))');
  });

  it.each([
    ["plugin-preload.cjs", 'require("fs");\n', 'require("fs")'],
    ["mcp-app-preload.cjs", 'require("./12.mcp.cjs");\n', 'require("./12.mcp.cjs")'],
    ["plugin-preload.cjs", 'var chunk = require("./" + __webpack_require__.u(id));\n', 'require("./" + __webpack_require__.u(id))'],
  ])("refuses %s requiring a module or file a sandboxed preload cannot load", (name, source, named) => {
    const result = runGateScript(SCRIPT, createRoot({ [name]: source }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(name);
    expect(result.stderr).toContain(named.startsWith('require("./"') ? "cannot load files or chunks" : named);
  });

  it("leaves the unsandboxed host preload and its chunks free to use Node", () => {
    const root = createRoot({ "preload.cjs": 'require("node:path"); require("./" + chunk);\n', "176.preload.cjs": 'require("node:crypto");\n' });
    expect(runGateScript(SCRIPT, root).status).toBe(0);
  });

  it("refuses a preload it does not classify, and a classified one that was not built", () => {
    const unknown = runGateScript(SCRIPT, createRoot({ "settings-preload.cjs": 'require("electron");\n' }));
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("settings-preload.cjs: a preload this gate does not classify");

    const missing = runGateScript(SCRIPT, createRoot({ "mcp-app-preload.cjs": null }));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("mcp-app-preload.cjs: not built");
  });

  it("passes the preloads the production webpack config builds from this tree", async () => {
    const root = createRoot();
    const dist = join(root, "dist", "src");
    const require = createRequire(import.meta.url);
    const webpack = require("webpack") as typeof import("webpack");
    const configs = (require(resolve(process.cwd(), "webpack.config.cjs")) as Array<{ name: string; mode: string; output: Record<string, unknown> }>)
      .filter((config) => config.name !== "renderer")
      .map((config) => ({ ...config, mode: "production", cache: false, plugins: [], output: { ...config.output, path: dist } }));
    expect(configs.map((config) => config.name).sort()).toEqual(["floatingDockPreload", "mcpAppPreload", "pluginPreload", "preload"]);
    await new Promise<void>((done, fail) => {
      webpack(configs as never, (error, stats) => {
        if (error) return fail(error);
        if (stats?.hasErrors()) return fail(new Error(stats.toString("errors-only")));
        done();
      });
    });
    copyFileSync(resolve(process.cwd(), "src/audio-capture-window-preload.cjs"), join(dist, "audio-capture-window-preload.cjs"));

    const result = runGateScript(SCRIPT, root);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  }, 180_000);
});
