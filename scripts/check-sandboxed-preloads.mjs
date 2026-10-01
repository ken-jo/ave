#!/usr/bin/env node
/**
 * check-sandboxed-preloads.mjs — a preload a sandboxed frame runs must load there.
 *
 * Electron's sandboxed preloads get a `require` polyfill that resolves only
 * `electron` and the Node modules `events`, `timers` and `url` (bare or
 * `node:`-prefixed) — and no files, so no webpack chunks either
 * (https://www.electronjs.org/docs/latest/tutorial/sandbox#preload-scripts).
 * Anything else throws `module not found` before the preload exposes its
 * bridge, and the window comes up with nothing behind it. The floating dock
 * shipped exactly that: its preload imported `node:path`, webpack kept
 * `require("node:path")`, and the dock had no bridge at all.
 *
 * This gate reads every built preload in `dist/src` and checks its `require`
 * calls against the sandbox mode of the frames that run it (PRELOADS below).
 * A preload the table does not classify fails too, so a new one cannot ship
 * unexamined. Run after `build:webpack`:
 *   node scripts/check-sandboxed-preloads.mjs [--root <repo>]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** What a sandboxed preload's `require` can resolve. */
export const SANDBOXED_PRELOAD_MODULES = new Set([
  "electron",
  "events",
  "timers",
  "url",
  "node:events",
  "node:timers",
  "node:url",
]);

/**
 * Every built preload, by the frames that run it. Keep `where` true: it is the
 * reason a preload is (not) held to the sandbox list.
 */
export const PRELOADS = {
  "preload.cjs": { sandboxed: false, where: "main, link and auth windows (sandbox: false)" },
  "audio-capture-window-preload.cjs": { sandboxed: false, where: "audio capture window (sandbox: false)" },
  "floating-dock-preload.cjs": { sandboxed: true, where: "floating dock window (sandbox: true)" },
  "plugin-preload.cjs": { sandboxed: true, where: "plugin <webview> guests (sandbox=yes, session frame preload)" },
  "mcp-app-preload.cjs": { sandboxed: true, where: "MCP app <webview> guests (sandbox=yes, session frame preload)" },
};

/** Webpack's lazy chunks of the host preload (`<id>.preload.cjs`), loaded by `preload.cjs`. */
const HOST_PRELOAD_CHUNK = /^\d+\.preload\.cjs$/u;

/** Every `require(` call in a bundle: its literal module, or null when the argument is not a string literal. */
export function requireCalls(source) {
  const calls = [];
  const pattern = /(?<![\w$.])require\s*\(\s*(?:(["'])([^"'\n]+)\1\s*\)|([^)\s][^)]*)\))/gu;
  for (const match of source.matchAll(pattern)) {
    calls.push(match[2] !== undefined ? { module: match[2] } : { module: null, expression: match[3].trim() });
  }
  return calls;
}

/** The problems with the built preloads in `distDir`; empty when every one can load where it runs. */
export function checkPreloads(distDir) {
  const problems = [];
  const built = existsSync(distDir) ? readdirSync(distDir).filter((name) => name.endsWith(".cjs") && name.includes("preload")) : [];
  for (const name of Object.keys(PRELOADS)) {
    if (!built.includes(name)) problems.push(`${name}: not built in ${distDir} (run build:webpack first)`);
  }
  for (const name of built) {
    const entry = PRELOADS[name] ?? (HOST_PRELOAD_CHUNK.test(name) ? PRELOADS["preload.cjs"] : undefined);
    if (!entry) {
      problems.push(`${name}: a preload this gate does not classify; add it to PRELOADS with the sandbox mode of the frames that run it`);
      continue;
    }
    if (!entry.sandboxed) continue;
    for (const call of requireCalls(readFileSync(join(distDir, name), "utf8"))) {
      if (call.module === null) {
        problems.push(`${name}: require(${call.expression}) — a sandboxed preload cannot load files or chunks (${entry.where})`);
      } else if (!SANDBOXED_PRELOAD_MODULES.has(call.module)) {
        problems.push(`${name}: require("${call.module}") — not available to a sandboxed preload (${entry.where})`);
      }
    }
  }
  return problems;
}

function main() {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex === -1 ? process.cwd() : resolve(process.argv[rootIndex + 1]);
  const problems = checkPreloads(join(root, "dist", "src"));
  if (problems.length > 0) {
    console.error("[sandboxed-preloads] a preload would fail to load in its frame:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`[sandboxed-preloads] OK (${Object.keys(PRELOADS).length} preloads)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
