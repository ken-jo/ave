import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGateScript } from "./gate-script-runner.js";

const SCRIPT = resolve(process.cwd(), "scripts/check-sandboxed-preloads.mjs");
const TABLE = "src/shared/preload-bundles.json";
const roots: string[] = [];
const junctions: Array<{ path: string; target: string }> = [];

type Row = { entry: string; file: string; build: "webpack" | "copy"; sandbox: boolean; runsIn: string };
const realTable = (): Record<string, Row> => JSON.parse(readFileSync(resolve(process.cwd(), TABLE), "utf-8"));

/**
 * A repo root with this tree's preload table, webpack config and build-asset
 * list, and a `dist/src` holding every preload the table names, each requiring
 * only `electron` unless overridden (null leaves it unbuilt).
 */
function createRoot(options: { dist?: Record<string, string | null>; table?: (table: Record<string, Row>) => void; webpackTail?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "ave-sandboxed-preloads-"));
  roots.push(root);
  const target = resolve(process.cwd(), "node_modules");
  const path = join(root, "node_modules");
  symlinkSync(target, path, "junction");
  junctions.push({ path, target });
  const table = realTable();
  options.table?.(table);
  for (const [path, content] of [[TABLE, `${JSON.stringify(table, null, 2)}\n`], ["package.json", "{}\n"]] as const) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content, "utf-8");
  }
  for (const path of ["webpack.config.cjs", "scripts/lib/build-assets.mjs"]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(resolve(process.cwd(), path), join(root, path));
  }
  if (options.webpackTail) appendFileSync(join(root, "webpack.config.cjs"), `\n${options.webpackTail}\n`, "utf-8");
  const dist = join(root, "dist", "src");
  mkdirSync(dist, { recursive: true });
  const files = { ...Object.fromEntries(Object.values(table).map((row) => [row.file, 'const { contextBridge } = require("electron");\n'])), ...options.dist };
  for (const [name, source] of Object.entries(files)) {
    if (source !== null) writeFileSync(join(dist, name), source, "utf-8");
  }
  return root;
}

afterEach(() => {
  const linked = junctions.splice(0);
  for (const { path } of linked) unlinkSync(path);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const { target } of linked) {
    expect(statSync(target).isDirectory()).toBe(true);
    expect(statSync(join(target, "esbuild-loader/package.json")).isFile()).toBe(true);
  }
});

describe("check-sandboxed-preloads", () => {
  it("accepts sandboxed preloads that require only what a sandboxed preload can", () => {
    const root = createRoot({ dist: { "floating-dock-preload.cjs": 'require("electron"); require("node:url"); require("events"); __webpack_require__(12);\n' } });
    const result = runGateScript(SCRIPT, root);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[sandboxed-preloads] OK (5 preloads)");
  });

  it("refuses node:path in the dock's preload, naming the window that would lose its bridge", () => {
    const root = createRoot({ dist: { "floating-dock-preload.cjs": 'require("electron");\nconst path = require("node:path");\n' } });
    const result = runGateScript(SCRIPT, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('floating-dock-preload.cjs: require("node:path") — not available to a sandboxed preload (floating dock window)');
  });

  it.each([
    ["plugin-preload.cjs", 'require("fs");\n', 'plugin-preload.cjs: require("fs") — not available'],
    ["mcp-app-preload.cjs", 'require("./12.mcp.cjs");\n', 'mcp-app-preload.cjs: require("./12.mcp.cjs") — not available'],
    ["plugin-preload.cjs", 'var chunk = require("./" + __webpack_require__.u(id));\n', 'plugin-preload.cjs: require("./" + __webpack_require__.u(id) — a sandboxed preload cannot load files or chunks'],
  ])("refuses %s requiring a module or file a sandboxed preload cannot load", (name, source, named) => {
    const result = runGateScript(SCRIPT, createRoot({ dist: { [name]: source } }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(named);
  });

  it("refuses a chunk of a sandboxed preload, and leaves the unsandboxed ones and their chunks free to use Node", () => {
    const chunked = runGateScript(SCRIPT, createRoot({ dist: { "12.floating-dock-preload.cjs": 'require("electron");\n' } }));
    expect(chunked.status).toBe(1);
    expect(chunked.stderr).toContain("12.floating-dock-preload.cjs: a chunk of floating-dock-preload.cjs");

    const host = createRoot({ dist: { "preload.cjs": 'require("node:path"); require("./" + chunk);\n', "176.preload.cjs": 'require("node:crypto");\n', "audio-capture-window-preload.cjs": 'require("node:fs");\n' } });
    expect(runGateScript(SCRIPT, host).status).toBe(0);
  });

  it("holds each preload to its row's sandbox, so a row flipped to sandboxed holds its bundle to the sandbox list", () => {
    const root = createRoot({
      dist: { "audio-capture-window-preload.cjs": 'require("node:fs");\n' },
      table: (table) => {
        table.audioCaptureWindowPreload.sandbox = true;
      },
    });
    const result = runGateScript(SCRIPT, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('audio-capture-window-preload.cjs: require("node:fs") — not available to a sandboxed preload (audio capture window)');
  });

  it("refuses a preload webpack builds that the table does not classify, whatever its file is called", () => {
    const root = createRoot({ webpackTail: 'module.exports.push(preloadConfig("settingsBridge", "src/settings-bridge.ts", "new-bridge.cjs"));' });
    const result = runGateScript(SCRIPT, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("webpack config settingsBridge: a preload src/shared/preload-bundles.json does not classify");
  });

  it("refuses a webpack config that drifted from its row, and a row with no config or copy behind it", () => {
    const drifted = runGateScript(SCRIPT, createRoot({ webpackTail: 'Object.assign(module.exports.find((config) => config.name === "pluginPreload"), { entry: { pluginPreload: "src/other.ts" }, output: { filename: "plugin.cjs" } });' }));
    expect(drifted.status).toBe(1);
    expect(drifted.stderr).toContain("webpack config pluginPreload: it outputs plugin.cjs, the table says plugin-preload.cjs");
    expect(drifted.stderr).toContain("webpack config pluginPreload: its entry is not src/plugin-preload.ts");

    const missing = runGateScript(SCRIPT, createRoot({ webpackTail: 'module.exports = module.exports.filter((config) => config.name !== "mcpAppPreload");' }));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("mcp-app-preload.cjs: the table builds it with webpack, but webpack.config.cjs has no mcpAppPreload preload config");

    const uncopied = runGateScript(SCRIPT, createRoot({
      table: (table) => {
        table.audioCaptureWindowPreload.entry = "src/audio-capture-preload.cjs";
      },
    }));
    expect(uncopied.status).toBe(1);
    expect(uncopied.stderr).toContain("audio-capture-window-preload.cjs: the table ships it as a copy of src/audio-capture-preload.cjs, but scripts/lib/build-assets.mjs does not copy it");
  });

  it("refuses a row whose build or sandbox is not one the table defines", () => {
    const result = runGateScript(SCRIPT, createRoot({
      table: (table) => {
        Object.assign(table.floatingDockPreload, { build: "esbuild", sandbox: "yes" });
      },
    }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('floatingDockPreload: build is "esbuild", not "webpack" or "copy"');
    expect(result.stderr).toContain("floatingDockPreload: needs a string entry and file and a boolean sandbox");
  });

  it("refuses a classified preload that was not built", () => {
    const result = runGateScript(SCRIPT, createRoot({ dist: { "mcp-app-preload.cjs": null } }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("mcp-app-preload.cjs: not built");
  });

  it("passes the preloads the production webpack config builds from this tree", async () => {
    const root = createRoot();
    const dist = join(root, "dist", "src");
    rmSync(dist, { recursive: true, force: true });
    const require = createRequire(import.meta.url);
    const webpack = require("webpack") as typeof import("webpack");
    const configs = (require(resolve(process.cwd(), "webpack.config.cjs")) as Array<{ name: string; target: unknown; output: Record<string, unknown> }>)
      .filter((config) => config.target === "electron-preload")
      .map((config) => ({ ...config, mode: "production", cache: false, plugins: [], output: { ...config.output, path: dist } }));
    expect(configs.map((config) => config.name).sort()).toEqual(
      Object.entries(realTable()).filter(([, row]) => row.build === "webpack").map(([id]) => id).sort(),
    );
    await new Promise<void>((done, fail) => {
      webpack(configs as never, (error, stats) => {
        if (error) return fail(error);
        if (stats?.hasErrors()) return fail(new Error(stats.toString("errors-only")));
        done();
      });
    });
    for (const row of Object.values(realTable()).filter((candidate) => candidate.build === "copy")) {
      copyFileSync(resolve(process.cwd(), row.entry), join(dist, row.file));
    }

    const result = runGateScript(SCRIPT, root);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  }, 180_000);
});
