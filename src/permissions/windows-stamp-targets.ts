import type { FilesystemConfig, FilesystemPathEntry } from "@anthropic-ai/sandbox-runtime";
import { containsGlobCharsWin, expandTilde, expandWindowsEnvRefs, globPatternBaseDir, normalizePathForSandbox, stripExtendedPathPrefix, toForwardSlashes } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import { expandWindowsFsPaths } from "@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js";
import { lstatSync, type BigIntStats } from "node:fs";
import { join, parse, resolve, sep } from "node:path";
import { sameFileIdentity, type FileIdentity } from "../lib/file-identity.js";
import { pinWindowsPaths, type WindowsPathPin } from "./windows-path-pin.js";
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

function guardedStampLiterals(paths: string[], pins: readonly WindowsPathPin[]): FilesystemPathEntry[] {
  const identities = new Map<string, FileIdentity | undefined>();
  for (const pin of pins) {
    for (const component of pin.components) {
      const entry = lstatSync(component.path, { bigint: true, throwIfNoEntry: false });
      if (entry === undefined || entry.isSymbolicLink() || entry.ino.toString() !== component.ino) {
        throw new Error(`Sandbox stamp target identity changed: ${component.path}`);
      }
      identities.set(component.path.toLowerCase(), entry);
    }
  }
  const verify = (): void => {
    const checked = new Set<string>();
    const verifyPath = (path: string): void => {
      if (checked.has(path)) return;
      checked.add(path);
      let missing = false;
      for (const component of stampPathChain(path)) {
        const entry: BigIntStats | undefined = missing ? undefined : lstatSync(component, { bigint: true, throwIfNoEntry: false });
        if (entry?.isSymbolicLink()) throw new Error(`Sandbox stamp target identity changed (reparse point): ${path}`);
        const key = component.toLowerCase();
        const previous = identities.get(key);
        // A missing component that appears as a non-link cannot redirect the path; record it instead of failing.
        if (identities.has(key) && !(previous === undefined && entry !== undefined)) {
          if (entry === undefined ? previous !== undefined : previous === undefined ||
              !sameFileIdentity(previous, entry)) {
            throw new Error(`Sandbox stamp target identity changed: ${path}`);
          }
        } else {
          identities.set(key, entry);
        }
        missing ||= entry === undefined;
      }
    };
    for (const path of paths) verifyPath(path);
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
  let expanded = expandTilde(stripExtendedPathPrefix(expandWindowsEnvRefs(path))).replace(/\//g, "\\");
  expanded = expanded.replace(/^[a-z]:/, drive => drive.toUpperCase());
  const prefix = containsGlobCharsWin(expanded)
    ? globPatternBaseDir(toForwardSlashes(expanded)).replace(/\//g, "\\").replace(/^([A-Za-z]:)$/, "$1\\") : expanded;
  // Other spellings still face the strict final grammar at pinning. Do not let normalization hide a dotted component.
  if (/[. ](?:\\|$)/.test(prefix)) assertPlainWindowsStampPath(prefix);
  // Canonical resolution belongs exclusively to the non-following handle pin.
}

// The runtime normalizes a marked literal again (environment references, tilde, prefix, realpath) before any existence check; hand one off only if that string is exactly a spelling checked here.
function assertRuntimeReadsAs(path: string, target: string): void {
  assertPlainWindowsStampPath(path);
  const exact = (spelling: string) => spelling.replace(/\\$/, "");
  const reread = exact(normalizePathForSandbox(path, { literal: true }));
  if (![path, target].some(checked => exact(checked) === reread)) {
    throw new Error(`Sandbox stamp target is reinterpreted by the runtime: ${path}`);
  }
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
      assertPlainWindowsStampPath(absolute);
      prefixes.push(absolute);
    }
  }
  if (AVE_HOME_ISOLATION_GUARD_ACTIVE) checkSandboxStampTargets(prefixes);
  const prefixPins = pinWindowsPaths(prefixes);
  const prefixLiterals = guardedStampLiterals(prefixes, prefixPins);
  // Retain match spellings during expansion so every possible grant identity is checked.
  const lists = [filesystem.allowRead, filesystem.allowWrite]
    .map(entries => expandWindowsFsPaths(entries ?? [], { mode: "deny" }).map(path => path.replace(/\//g, "\\")));
  for (const entry of prefixLiterals) if (typeof entry !== "string") void entry.path;
  const snapshots = pinWindowsPaths(lists.flat());
  let snapshotIndex = 0;
  const pin = (paths: readonly string[]): FilesystemPathEntry[] =>
    paths.flatMap(path => {
      assertPlainWindowsStampPath(path);
      const snapshot = snapshots[snapshotIndex++]!;
      const canonical = snapshot.path.replace(/^(.*[^:])\\$/, "$1");
      assertPlainWindowsStampPath(canonical);
      const literals = [canonical];
      for (const literal of literals) assertRuntimeReadsAs(literal, canonical);
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
