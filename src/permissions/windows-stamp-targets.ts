import type { FilesystemConfig, FilesystemPathEntry } from "@anthropic-ai/sandbox-runtime";
import { containsGlobCharsWin, expandTilde, expandWindowsEnvRefs, globPatternBaseDir, stripExtendedPathPrefix, toForwardSlashes } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import { expandWindowsFsPaths } from "@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js";
import { join, parse, resolve, sep } from "node:path";
import { admitWindowsReparse, pinWindowsPaths, windowsObjectKey, type WindowsPathFacts } from "../shared/windows-path-facts.js";
import { assertWindowsGrantGrammar, pinWindowsGrantTargets } from "./windows-grant-targets.js";
import { AVE_HOME_ISOLATION_GUARD_ACTIVE, checkSandboxStampTargets } from "../shared/ave-home-test-guard.js";

const missingWindowsGrants = new WeakSet<object>();

export function existingWindowsGrants(entries: readonly FilesystemPathEntry[]): FilesystemPathEntry[] {
  return entries.filter(entry => typeof entry === "string" || !missingWindowsGrants.has(entry));
}

function stampPathChain(path: string): string[] {
  const absolute = resolve(path);
  const { root } = parse(absolute);
  const chain = [root];
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    chain.push(join(chain[chain.length - 1]!, part));
  }
  return chain;
}

function guardedStampLiterals(paths: string[], pins: readonly WindowsPathFacts[]): FilesystemPathEntry[] {
  const identities = new Map<string, string | undefined>();
  const inspect = (path: string, pin: WindowsPathFacts, record: boolean): void => {
    if (admitWindowsReparse(pin, "grant") !== true) throw new Error(`Sandbox stamp target identity changed (reparse point): ${path}`);
    const chain = stampPathChain(path);
    for (const [index, component] of [...pin.ancestors, pin].entries()) {
      if (admitWindowsReparse({ ...component, ancestors: [] }, "grant") !== true) {
        throw new Error(`Sandbox stamp target identity changed (reparse point): ${path}`);
      }
      // Use the requested component so a changed canonical spelling cannot hide an identity change.
      const key = chain[index]!;
      const identity = component.exists === true ? windowsObjectKey(component) : undefined;
      const previous = identities.get(key);
      // A missing component that appears as a non-link cannot redirect the path; record it instead of failing.
      if (!record && identities.has(key) && !(previous === undefined && identity !== undefined) && previous !== identity) {
        throw new Error(`Sandbox stamp target identity changed: ${path}`);
      }
      identities.set(key, identity);
    }
  };
  paths.forEach((path, index) => inspect(path, pins[index]!, true));
  const verify = (): void => {
    if (paths.length === 0) return;
    const current = pinWindowsPaths(paths);
    paths.forEach((path, index) => inspect(path, current[index]!, false));
  };
  verify();
  // The runtime reads marked paths after its async lookups; keep this check on that consumption boundary.
  return paths.map(path => Object.freeze({ get path() { verify(); return path; }, literal: true as const }));
}

// Preserve identity checks when a boundary accepts string arrays instead of literal objects.
export function windowsPinnedPaths(entries: readonly FilesystemPathEntry[]): string[] {
  const paths: string[] = [];
  entries.forEach((entry, index) => Object.defineProperty(paths, index, {
    enumerable: true, get: () => typeof entry === "string" ? entry : entry.path,
  }));
  return Object.freeze(paths) as string[];
}

const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;

// Positive grammar: only a plain drive-absolute path whose every component Win32 opens as spelled, so no later layer can reinterpret it.
export function isPlainWindowsStampPath(path: string): boolean {
  const match = /^[A-Z]:\\(.*)$/s.exec(path);
  if (match === null) return false;
  const body = match[1]!.endsWith("\\") ? match[1]!.slice(0, -1) : match[1]!;
  if (body === "") return true;
  return body.split("\\").every(component =>
    component !== "" && component !== "." && component !== ".." &&
    !/[\x00-\x1f\x7f<>:"/|?*%~]/.test(component) &&
    !/[. ]$/.test(component) &&
    !RESERVED_DEVICE_NAME.test(component.split(".")[0]!.trimEnd()));
}

function assertPlainWindowsStampPath(path: string): void {
  if (!isPlainWindowsStampPath(path)) throw new Error(`Sandbox stamp target is not a plain drive path: ${JSON.stringify(path)}`);
}

// Check the spelling before runtime expansion can replace a link path with its final target.
function checkWindowsCanonicalIntermediates(path: string): void {
  if (process.platform !== "win32") return;
  const homeExpanded = expandWindowsEnvRefs(path) !== path || expandTilde(path) !== path;
  if (homeExpanded && containsGlobCharsWin(expandWindowsEnvRefs("%USERPROFILE%"))) {
    throw new Error(`filesystem-expansion-glob: expanded path cannot be represented literally: ${JSON.stringify(path)}`);
  }
  let expanded = expandTilde(expandWindowsEnvRefs(path)).replace(/\//g, "\\");
  expanded = expanded.replace(/^[a-z]:/, drive => drive.toUpperCase());
  if (!/^[A-Z]:\\/.test(expanded)) assertWindowsGrantGrammar(expanded);
  const prefix = containsGlobCharsWin(expanded)
    ? globPatternBaseDir(toForwardSlashes(expanded)).replace(/\//g, "\\").replace(/^([A-Za-z]:)$/, "$1\\") : expanded;
  // Other spellings still face the strict final grammar at pinning. Do not let normalization hide a dotted component.
  if (/[. ](?:\\|$)/.test(prefix)) assertPlainWindowsStampPath(prefix);
  assertWindowsGrantGrammar(prefix);
  // Canonical resolution belongs exclusively to the non-following handle pin.
}

export function pinWindowsFilesystemConfig<T extends Partial<FilesystemConfig> | undefined>(filesystem: T): T {
  if (process.platform !== "win32" || filesystem === undefined) return filesystem;
  const prefixes: string[] = [];
  // Deny rows are conservative match expressions, not targets receiving allow ACEs.
  for (const entries of [filesystem.allowRead, filesystem.allowWrite]) {
    for (const entry of entries ?? []) {
      const path = typeof entry === "string" ? entry : entry.path;
      checkWindowsCanonicalIntermediates(path);
      const expanded = expandTilde(stripExtendedPathPrefix(expandWindowsEnvRefs(path))).replace(/\//g, "\\")
        .replace(/^[a-z]:/, drive => drive.toUpperCase());
      const prefix = containsGlobCharsWin(expanded) ? globPatternBaseDir(toForwardSlashes(expanded)).replace(/\//g, "\\") : expanded;
      const absolute = resolve(prefix);
      prefixes.push(absolute);
    }
  }
  if (AVE_HOME_ISOLATION_GUARD_ACTIVE) checkSandboxStampTargets(prefixes);
  const prefixPins = pinWindowsGrantTargets(prefixes, { allowMissing: true, validatePath: assertPlainWindowsStampPath });
  const prefixPaths = prefixPins.map(pin => stripExtendedPathPrefix(pin.canonical!));
  if (AVE_HOME_ISOLATION_GUARD_ACTIVE) checkSandboxStampTargets(prefixPaths);
  const prefixLiterals = guardedStampLiterals(prefixPaths, prefixPins);
  // Retain match spellings during expansion so every possible grant identity is checked.
  const lists = [filesystem.allowRead, filesystem.allowWrite]
    .map(entries => (entries ?? []).flatMap(entry => expandWindowsFsPaths([entry], { mode: "deny" }))
      .map(path => path.replace(/\//g, "\\")));
  for (const entry of prefixLiterals) if (typeof entry !== "string") void entry.path;
  const snapshots = pinWindowsGrantTargets(lists.flat(), { allowMissing: true, validatePath: assertPlainWindowsStampPath });
  let snapshotIndex = 0;
  const pin = (paths: readonly string[]): FilesystemPathEntry[] =>
    paths.flatMap(() => {
      const snapshot = snapshots[snapshotIndex++]!;
      const canonical = stripExtendedPathPrefix(snapshot.canonical!).replace(/^(.*[^:])\\$/, "$1");
      assertPlainWindowsStampPath(canonical);
      const literals = [canonical];
      const entries = guardedStampLiterals(literals, [snapshot]);
      // Missing grants still need policy checks and control denies; omit them only at native handoff.
      if (!snapshot.exists) for (const entry of entries) if (typeof entry !== "string") missingWindowsGrants.add(entry);
      return entries;
    });
  return {
    ...filesystem,
    allowRead: pin(lists[0]!),
    allowWrite: pin(lists[1]!),
  };
}
