import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every place the app hands a frame a preload, or says what sandbox a preload
 * runs in, takes both from the one table (`src/shared/preload-bundles.json`).
 * `scripts/check-sandboxed-preloads.mjs` checks each built preload against that
 * table's sandbox, so a site that named its own `sandbox` or preload file could
 * run a preload in a sandbox the gate never checked it for. This holds the
 * sites to the table:
 *   - `new BrowserWindow` with a preload spreads `preloadPreferences(id)` and
 *     names neither `sandbox` nor `preload` (a window without one names no
 *     `preload` at all);
 *   - `session.registerPreloadScript` takes `preloadBundlePath(id)`;
 *   - no source names a preload file the table owns;
 *   - a main-side guard that sets a guest's `sandbox` reads it from the table,
 *     and the renderer's `<webview>` requests agree with it.
 */

type Row = { entry: string; file: string; build: "webpack" | "copy"; sandbox: boolean; runsIn: string };
type Sources = Map<string, string>;

const ROOT = process.cwd();
const TABLE: Record<string, Row> = JSON.parse(readFileSync(resolve(ROOT, "src/shared/preload-bundles.json"), "utf-8"));

function readSources(): Sources {
  const sources: Sources = new Map();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(path);
      } else if (/\.(?:ts|tsx|cjs|mjs|js)$/u.test(entry.name) && !/\.(?:test|spec)\./u.test(entry.name)) {
        sources.set(relative(ROOT, path), readFileSync(path, "utf-8"));
      }
    }
  };
  walk(resolve(ROOT, "src"));
  return sources;
}

/**
 * The source without its comments; strings, template literals and regex
 * literals are kept as written, and a `//` or `/*` inside one is not a comment.
 */
function stripComments(source: string): string {
  let out = "";
  let index = 0;
  const regexMayStart = (): boolean => /(?:^|[(,=:[!&|?{};+\-*%~^]|\breturn|\btypeof)\s*$/u.test(out.slice(-40));
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
    } else if (char === '"' || char === "'" || char === "`" || (char === "/" && regexMayStart())) {
      let end = index + 1;
      let inClass = false;
      while (end < source.length) {
        const at = source[end];
        if (at === "\\") end += 1;
        else if (char === "/" && at === "[") inClass = true;
        else if (char === "/" && at === "]") inClass = false;
        else if (at === char && !inClass) break;
        else if (char !== "`" && at === "\n") break;
        end += 1;
      }
      out += source.slice(index, end + 1);
      index = end + 1;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

/** The text from `open` (a `(` or `{`) to its matching close, skipping string literals. */
function balanced(source: string, open: number): string {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  let quote: string | null = null;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (pairs[char]) stack.push(pairs[char]);
    else if (char === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`unbalanced from offset ${open}`);
}

/** The preload id a `preloadPreferences`/`preloadBundlePath` call or a `const x = …` alias of one names. */
function preloadIds(text: string, file: string, fn: "preloadPreferences" | "preloadBundlePath"): string[] {
  const ids = [...text.matchAll(new RegExp(`\\b${fn}\\(\\s*"([^"]+)"\\s*\\)`, "gu"))].map((match) => match[1]);
  for (const [, alias] of text.matchAll(/(?:\.\.\.|filePath:\s*)([A-Za-z_$][\w$]*)\b(?!\s*\()/gu)) {
    const declared = new RegExp(`\\bconst\\s+${alias}\\s*=\\s*${fn}\\(\\s*"([^"]+)"\\s*\\)`, "u").exec(file);
    if (declared) ids.push(declared[1]);
  }
  return ids;
}

type Site = { file: string; kind: "window" | "session"; id: string | null };

/** The preload sites in `sources`, and every way one departs from the table. */
function auditSites(sources: Sources, table: Record<string, Row>): { sites: Site[]; problems: string[] } {
  const sites: Site[] = [];
  const problems: string[] = [];
  for (const [path, raw] of sources) {
    const source = stripComments(raw);

    for (const match of source.matchAll(/new\s+BrowserWindow\s*\(/gu)) {
      const args = balanced(source, match.index + match[0].length - 1);
      const prefsAt = /webPreferences\s*:\s*\{/u.exec(args);
      if (!prefsAt) {
        sites.push({ file: path, kind: "window", id: null });
        continue;
      }
      const prefs = balanced(args, prefsAt.index + prefsAt[0].length - 1);
      const ids = preloadIds(prefs, source, "preloadPreferences");
      const preloadKeys = [...prefs.matchAll(/\bpreload\s*:\s*([^,}\n]+)/gu)].map((key) => key[1].trim());
      if (ids.length === 0) {
        sites.push({ file: path, kind: "window", id: null });
        if (preloadKeys.length > 0) problems.push(`${path}: a window names a preload (${preloadKeys.join(", ")}) instead of spreading preloadPreferences(id)`);
        continue;
      }
      for (const id of ids) {
        sites.push({ file: path, kind: "window", id });
        if (!table[id]) problems.push(`${path}: preloadPreferences("${id}") names no row of the preload table`);
      }
      if (ids.length > 1) problems.push(`${path}: a window spreads ${ids.length} preloads`);
      if (/\bsandbox\s*:/u.test(prefs)) problems.push(`${path}: a window running preload ${ids.join(", ")} names its own sandbox; the table sets it`);
      for (const value of preloadKeys.filter((key) => key !== "undefined")) problems.push(`${path}: a window running preload ${ids.join(", ")} names its own preload (${value}); the table sets it`);
    }

    for (const match of source.matchAll(/\bregisterPreloadScript\s*\(/gu)) {
      const args = balanced(source, match.index + match[0].length - 1);
      const ids = preloadIds(args, source, "preloadBundlePath");
      if (ids.length !== 1 || !table[ids[0]]) {
        problems.push(`${path}: registerPreloadScript${args.replace(/\s+/gu, " ")} does not take preloadBundlePath(id) of a table row`);
        continue;
      }
      sites.push({ file: path, kind: "session", id: ids[0] });
      if (!table[ids[0]].sandbox) problems.push(`${path}: session frame preload ${ids[0]} runs in sandboxed <webview> guests, but its row says sandbox: false`);
    }

    if (/\bsetPreloads\s*\(/u.test(source)) problems.push(`${path}: session.setPreloads bypasses the preload table; use registerPreloadScript with preloadBundlePath(id)`);

    for (const row of Object.values(table)) {
      if (new RegExp(`["'\`][^"'\`\\n]*(?<![\\w-])${row.file.replace(/\./gu, "\\.")}["'\`]`, "u").test(source)) {
        problems.push(`${path}: names ${row.file} itself; take it from the preload table`);
      }
    }

    for (const assignment of source.matchAll(/\bwebPreferences\.sandbox\s*=\s*([^;\n]+)/gu)) {
      const value = assignment[1].trim();
      const fromTable = /^PRELOAD_BUNDLES\.(\w+)\.sandbox$/u.exec(value);
      const strippedPreload = /\bdelete\s+[\w.]*webPreferences\.preload\b/u.test(source);
      if (!(fromTable && table[fromTable[1]]) && !strippedPreload) {
        problems.push(`${path}: sets a guest's sandbox to ${value}, not from the preload table, while leaving its preload in place`);
      }
    }
  }
  return { sites, problems };
}

/** The renderer `<webview>` requests for the guests a session preload runs in. */
const GUEST_REQUESTS = [
  { file: "src/plugin-ui-host.tsx", id: "pluginPreload" },
  { file: "src/ui/renderer/components/McpAppView.tsx", id: "mcpAppPreload" },
] as const;

function auditGuestRequests(sources: Sources, table: Record<string, Row>): string[] {
  const problems: string[] = [];
  for (const { file, id } of GUEST_REQUESTS) {
    const requests = [...stripComments(sources.get(file) ?? "").matchAll(/webpreferences(?:=|:\s*)"([^"]*)"/gu)].map((match) => match[1]);
    if (requests.length === 0) problems.push(`${file}: no <webview> webpreferences request found`);
    for (const request of requests) {
      const sandboxed = /\bsandbox\s*=\s*yes\b/u.test(request);
      if (sandboxed !== table[id].sandbox) problems.push(`${file}: a <webview> requests sandbox=${sandboxed ? "yes" : "no"}, but ${id} runs with sandbox: ${table[id].sandbox}`);
    }
  }
  return problems;
}

const mutate = (sources: Sources, file: string, from: string | RegExp, to: string): Sources => {
  const next = new Map(sources);
  const before = sources.get(file);
  if (before === undefined) throw new Error(`no source ${file}`);
  const after = before.replace(from, to);
  if (after === before) throw new Error(`mutation did not apply to ${file}`);
  next.set(file, after);
  return next;
};

describe("preload sites follow the preload table", () => {
  const sources = readSources();

  it("finds every preload site, each taking its preload and sandbox from the table", () => {
    expect(sources.size).toBeGreaterThan(100);
    const { sites, problems } = auditSites(sources, TABLE);
    expect(problems).toEqual([]);
    expect(sites.filter((site) => site.id !== null).map((site) => `${site.kind} ${site.file} ${site.id}`).sort()).toEqual([
      "session src/main/html-preview-partition.ts mcpAppPreload",
      "session src/main/html-preview-partition.ts pluginPreload",
      "window src/main/audio-capture-surface.ts audioCaptureWindowPreload",
      "window src/main/auth-window-service.ts preload",
      "window src/main/floating-dock-surface.ts floatingDockPreload",
      "window src/main/link-window-service.ts preload",
      "window src/main/main-window.ts preload",
    ]);
    const used = new Set(sites.map((site) => site.id));
    expect(Object.keys(TABLE).filter((id) => !used.has(id))).toEqual([]);
    expect(sites.filter((site) => site.id === null).length).toBeGreaterThan(0);
  });

  it("has the plugin attach guard, the host preload and the dock take the plugin preload from the table", () => {
    expect(sources.get("src/main/plugin-webview-attach.ts")).toMatch(/webPreferences\.sandbox = PRELOAD_BUNDLES\.pluginPreload\.sandbox;/u);
    expect(sources.get("src/preload.ts")).toMatch(/safeResolveFileUrl\(PRELOAD_BUNDLES\.pluginPreload\.file\)/u);
    expect(sources.get("src/main/floating-dock-surface.ts")).toMatch(/pluginPreloadUrl: pathToFileURL\(preloadBundlePath\("pluginPreload"\)\)/u);
  });

  it("has the renderer's <webview> requests agree with the table's sandbox for their guests", () => {
    expect(auditGuestRequests(sources, TABLE)).toEqual([]);
  });

  it.each([
    ["src/main/audio-capture-surface.ts", '...preloadPreferences("audioCaptureWindowPreload"),', '...preloadPreferences("audioCaptureWindowPreload"),\n        sandbox: true,', "src/main/audio-capture-surface.ts: a window running preload audioCaptureWindowPreload names its own sandbox"],
    ["src/main/floating-dock-surface.ts", '...preloadPreferences("floatingDockPreload"),', 'preload: runtimeAssetPath("floating-dock-preload.cjs"),\n        sandbox: false,', "src/main/floating-dock-surface.ts: a window names a preload"],
    ["src/main/main-window.ts", "...hostPreload,", "...hostPreload,\n      sandbox: true,", "src/main/main-window.ts: a window running preload preload names its own sandbox"],
    ["src/main/auth-window-service.ts", '...preloadPreferences("preload"),', '...preloadPreferences("preload"),\n      preload: runtimeAssetPath("preload.cjs"),', "src/main/auth-window-service.ts: a window running preload preload names its own preload"],
    ["src/main/html-preview-partition.ts", 'preloadBundlePath("mcpAppPreload")', 'runtimeAssetPath("mcp-app-preload.cjs")', "src/main/html-preview-partition.ts: registerPreloadScript"],
    ["src/main/plugin-webview-attach.ts", "PRELOAD_BUNDLES.pluginPreload.sandbox", "true", "src/main/plugin-webview-attach.ts: sets a guest's sandbox to true, not from the preload table"],
  ])("fails when %s stops taking its preload or sandbox from the table", (file, from, to, problem) => {
    const { problems } = auditSites(mutate(sources, file, from, to), TABLE);
    expect(problems.join("\n")).toContain(problem);
  });

  it("fails when a row's sandbox flips without the renderer's <webview> request following", () => {
    const flipped = structuredClone(TABLE);
    flipped.pluginPreload.sandbox = false;
    expect(auditGuestRequests(sources, flipped)).toContain("src/plugin-ui-host.tsx: a <webview> requests sandbox=yes, but pluginPreload runs with sandbox: false");
    expect(auditSites(sources, flipped).problems).toContain("src/main/html-preview-partition.ts: session frame preload pluginPreload runs in sandboxed <webview> guests, but its row says sandbox: false");

    const unrequested = mutate(sources, "src/ui/renderer/components/McpAppView.tsx", /(webpreferences: "[^"]*)sandbox=yes/u, "$1sandbox=no");
    expect(auditGuestRequests(unrequested, TABLE)).toContain("src/ui/renderer/components/McpAppView.tsx: a <webview> requests sandbox=no, but mcpAppPreload runs with sandbox: true");
  });

  it("fails on a new window that names a preload file, whatever it is called", () => {
    const added = new Map(sources).set(
      "src/main/settings-window.ts",
      'import { BrowserWindow } from "electron";\nexport const open = () => new BrowserWindow({ webPreferences: { preload: join(__dirname, "new-bridge.cjs"), sandbox: false } });\n',
    );
    expect(auditSites(added, TABLE).problems.join("\n")).toContain("src/main/settings-window.ts: a window names a preload (join(__dirname");
  });
});
