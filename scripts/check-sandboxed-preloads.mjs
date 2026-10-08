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
 * Where each fact comes from:
 *   - The preloads and the sandbox each runs in: `src/shared/preload-bundles.json`,
 *     the table the window and session code take their `preload` and `sandbox`
 *     values from (`test/scripts/preload-sites.test.ts` holds every site to it).
 *   - Which preloads are built: every `electron-preload` config in
 *     `webpack.config.cjs` must be a `webpack` row of the table with the same
 *     entry and output, and every `webpack` row must have its config. A `copy`
 *     row must be one `scripts/lib/build-assets.mjs` copies into `dist/src`.
 *   - Each row's built file in `dist/src`: a sandboxed one may require only the
 *     modules above, nothing by a computed name, and may have no chunks.
 * It does not scan `dist/src` for other files: a preload reaches a frame only
 * through a site the sites test holds to the table. Run after the build has
 * bundled and copied the preloads:
 *   node scripts/check-sandboxed-preloads.mjs [--root <repo>]
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
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

/** Every `require(` call in a bundle: its literal module, or null when the argument is not a string literal. */
export function requireCalls(source) {
  const calls = [];
  const pattern = /(?<![\w$.])require\s*\(\s*(?:(["'])([^"'\n]+)\1\s*\)|([^)\s][^)]*)\))/gu;
  for (const match of source.matchAll(pattern)) {
    calls.push(match[2] !== undefined ? { module: match[2] } : { module: null, expression: match[3].trim() });
  }
  return calls;
}

const isPreloadTarget = (target) => (Array.isArray(target) ? target : [target]).some((value) => String(value).startsWith("electron-preload"));
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** The problems with the preloads under `root`; empty when every one is classified and can load where it runs. */
export async function checkPreloads(rootPath) {
  // The config resolves its entries from its real `__dirname`; compare in the same terms.
  const root = realpathSync(rootPath);
  const problems = [];
  const table = JSON.parse(readFileSync(join(root, "src/shared/preload-bundles.json"), "utf8"));
  const rows = Object.entries(table);
  const requireFromRoot = createRequire(join(root, "package.json"));
  const configs = requireFromRoot(join(root, "webpack.config.cjs")).filter((config) => isPreloadTarget(config.target));

  for (const config of configs) {
    const row = table[config.name];
    if (!row || row.build !== "webpack") {
      problems.push(`webpack config ${config.name}: a preload src/shared/preload-bundles.json does not classify; add it with the sandbox of the frames that run it`);
      continue;
    }
    const entries = Object.values(config.entry ?? {}).map((entry) => resolve(root, String(entry)));
    if (entries.length !== 1 || entries[0] !== resolve(root, row.entry)) problems.push(`webpack config ${config.name}: its entry is not ${row.entry}`);
    if (config.output?.filename !== row.file) problems.push(`webpack config ${config.name}: it outputs ${config.output?.filename}, the table says ${row.file}`);
  }
  for (const [id, row] of rows) {
    if (row.build !== "webpack" && row.build !== "copy") problems.push(`${id}: build is ${JSON.stringify(row.build)}, not "webpack" or "copy"`);
    if (typeof row.sandbox !== "boolean" || typeof row.file !== "string" || typeof row.entry !== "string") problems.push(`${id}: needs a string entry and file and a boolean sandbox`);
    if (row.build === "webpack" &&!configs.some((config) => config.name === id)) problems.push(`${row.file}: the table builds it with webpack, but webpack.config.cjs has no ${id} preload config`);
  }
  const copied = rows.filter(([, row]) => row.build === "copy");
  if (copied.length > 0) {
    const { BUILD_ASSETS } = await import(pathToFileURL(join(root, "scripts/lib/build-assets.mjs")).href);
    for (const [, row] of copied) {
      if (!BUILD_ASSETS.some((asset) => asset.src === row.entry && asset.out === `dist/src/${row.file}`)) problems.push(`${row.file}: the table ships it as a copy of ${row.entry}, but scripts/lib/build-assets.mjs does not copy it to dist/src`);
    }
  }

  const dist = join(root, "dist", "src");
  const built = existsSync(dist) ? readdirSync(dist) : [];
  for (const [, row] of rows) {
    if (!built.includes(row.file)) {
      problems.push(`${row.file}: not built in ${dist} (run the build first)`);
      continue;
    }
    if (!row.sandbox) continue;
    const chunk = new RegExp(`^[^.]+\\.${escapeRegExp(row.file)}$`, "u");
    for (const name of built.filter((candidate) => chunk.test(candidate))) {
      problems.push(`${name}: a chunk of ${row.file}, which a sandboxed preload cannot load (${row.runsIn})`);
    }
    for (const call of requireCalls(readFileSync(join(dist, row.file), "utf8"))) {
      if (call.module === null) {
        problems.push(`${row.file}: require(${call.expression}) — a sandboxed preload cannot load files or chunks (${row.runsIn})`);
      } else if (!SANDBOXED_PRELOAD_MODULES.has(call.module)) {
        problems.push(`${row.file}: require("${call.module}") — not available to a sandboxed preload (${row.runsIn})`);
      }
    }
  }
  return { problems, count: rows.length };
}

async function main() {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex === -1 ? process.cwd() : resolve(process.argv[rootIndex + 1]);
  const { problems, count } = await checkPreloads(root);
  if (problems.length > 0) {
    console.error("[sandboxed-preloads] a preload is unclassified, or would fail to load in its frame:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`[sandboxed-preloads] OK (${count} preloads)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
