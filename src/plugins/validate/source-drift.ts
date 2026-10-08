/**
 * What a plugin's code names against what its manifest declares
 * (`docs/design/plugin-hostapi-protocol.md` §9.7 P2, §10.2 item 3).
 *
 * Ported from the drift scripts the official repository's plugins carry
 * (`plugins/meeting/source/scripts/validate-hostapi.mjs` checks 4-7 and its
 * `ui-bridge-usage.mjs` scan), so a plugin repository can retire them for the
 * validator:
 *
 *  - `hostApi.emitEvent("…")` / `hostApi.onEvent("…")` literals in
 *    `src/**\/*.ts` and `dist/**\/*.js` against `emittedEvents` /
 *    `eventSubscriptions` — the host refuses an undeclared emit and never
 *    wires an undeclared subscription;
 *  - `bridge.callTool("…")` in `src/ui/**` against the tools that carry `app`
 *    visibility — the host accepts no other;
 *  - `bridge.onEvent("…")` in `src/ui/**` against the events a plugin webview
 *    can receive: the plugin's own emits, its subscriptions, and the host's
 *    public broadcasts.
 *
 * The scripts' three `permissions` checks are not ported: the host enforces no
 * `permissions` entry, so a check on one would be a claim about nothing.
 *
 * A literal is what is matched — a member call whose first argument is a
 * quoted string, after comments are stripped. A name built at run time, a
 * destructured method or bracket access is invisible to the scan, exactly as
 * it is to the scripts it replaces; the scan never guesses at a value.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { PluginManifest } from "../types.js";
import { PUBLIC_HOST_EVENT_TYPES } from "../capabilities.js";
import { failed, notExercised, passed, type ReportRow } from "./report.js";

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
// Only where `//` begins a line: after code it looks the same as `https://`.
const LINE_COMMENT = /^[ \t]*\/\/.*$/gm;

const HOST_EMIT = /\bhostApi\??\.emitEvent\??\.?\(\s*["']([^"']+)["']/g;
const HOST_ON_EVENT = /\bhostApi\??\.onEvent\??\.?\(\s*["']([^"']+)["']/g;
const BRIDGE_CALL_TOOL = /\.callTool\??\.?\(\s*["']([^"']+)["']/g;
const BRIDGE_ON_EVENT = /\.onEvent\??\.?\(\s*["']([^"']+)["']/g;

const isTsSource = (name: string): boolean => name.endsWith(".ts") && !name.endsWith(".d.ts");
const isJsBundle = (name: string): boolean => name.endsWith(".js");
const isUiScript = (name: string): boolean => /\.(js|mjs|cjs)$/u.test(name);

function walk(dir: string, isSource: (name: string) => boolean, skipDist: boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "node_modules" || name.startsWith(".") || (skipDist && name === "dist")) continue;
      walk(path, isSource, skipDist, out);
    } else if (isSource(name)) {
      out.push(path);
    }
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(BLOCK_COMMENT, "").replace(LINE_COMMENT, "");
}

interface Reference {
  readonly name: string;
  readonly file: string;
}

function references(root: string, files: readonly string[], pattern: RegExp): Reference[] {
  const found: Reference[] = [];
  for (const file of files) {
    const source = stripComments(readFileSync(file, "utf-8"));
    const names = new Set([...source.matchAll(pattern)].map((match) => match[1]!));
    const shown = relative(root, file).split(sep).join("/");
    for (const name of names) found.push({ name, file: shown });
  }
  return found;
}

/** One row per undeclared reference, or one passed row when every one is declared. */
function crossCheck(
  check: string,
  scanned: readonly string[],
  scope: string,
  found: readonly Reference[],
  declared: ReadonlySet<string>,
  explain: (name: string) => string,
): ReportRow[] {
  if (scanned.length === 0) return [notExercised(check, `the plugin has no ${scope}`)];
  const undeclared = found.filter((reference) => !declared.has(reference.name));
  if (undeclared.length === 0) {
    return [passed(check, `${found.length} reference(s) in ${scanned.length} file(s), all declared`)];
  }
  return undeclared.map((reference) => failed(check, explain(reference.name), reference.file));
}

/** The source-drift rows for the plugin at `pluginRoot`. */
export function scanSourceDrift(pluginRoot: string, manifest: PluginManifest): ReportRow[] {
  const hostFiles = [
    ...walk(join(pluginRoot, "src"), isTsSource, true),
    ...walk(join(pluginRoot, "dist"), isJsBundle, false),
  ];
  const uiFiles = walk(join(pluginRoot, "src", "ui"), isUiScript, true);

  const emitted = new Set(manifest.emittedEvents ?? []);
  const subscribed = new Set(
    (manifest.eventSubscriptions ?? []).map((entry) => (typeof entry === "string" ? entry : entry.type)),
  );
  const appTools = new Set(
    manifest.tools
      .filter((tool) => tool._meta?.ui?.visibility?.includes("app") === true)
      .map((tool) => tool.name),
  );
  const bridged = new Set([...emitted, ...subscribed, ...PUBLIC_HOST_EVENT_TYPES]);

  const hostScope = "src/**/*.ts or dist/**/*.js to scan";
  const uiScope = "src/ui/**/*.{js,mjs,cjs} to scan";
  return [
    ...crossCheck(
      "events.emit-undeclared",
      hostFiles,
      hostScope,
      references(pluginRoot, hostFiles, HOST_EMIT),
      emitted,
      (name) => `hostApi.emitEvent("${name}") but plugin.json "emittedEvents" does not declare it`,
    ),
    ...crossCheck(
      "events.subscribe-undeclared",
      hostFiles,
      hostScope,
      references(pluginRoot, hostFiles, HOST_ON_EVENT),
      subscribed,
      (name) => `hostApi.onEvent("${name}") but plugin.json "eventSubscriptions" does not declare it`,
    ),
    ...crossCheck(
      "bridge.call-tool",
      uiFiles,
      uiScope,
      references(pluginRoot, uiFiles, BRIDGE_CALL_TOOL),
      appTools,
      (name) => `bridge.callTool("${name}") but no tool named "${name}" carries "app" visibility — the host refuses the call`,
    ),
    ...crossCheck(
      "bridge.on-event",
      uiFiles,
      uiScope,
      references(pluginRoot, uiFiles, BRIDGE_ON_EVENT),
      bridged,
      (name) => `bridge.onEvent("${name}") but plugin.json neither emits nor subscribes to "${name}" — the host never forwards it to the UI`,
    ),
  ];
}
