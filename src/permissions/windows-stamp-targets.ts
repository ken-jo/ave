import type { FilesystemConfig, FilesystemPathEntry } from "@anthropic-ai/sandbox-runtime";
import { normalizePathForSandbox } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import { expandWindowsFsPaths } from "@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js";
import { lstatSync, readlinkSync, realpathSync, type BigIntStats } from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";
import { sameFileIdentity, type FileIdentity } from "../lib/file-identity.js";
import { AVE_HOME_ISOLATION_GUARD_ACTIVE } from "../shared/ave-home-test-guard.js";

function canonicalStampPath(path: string): string {
  const absolute = resolve(path);
  const { root } = parse(absolute);
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  let ancestor = realpathSync.native(root);
  for (let index = 0; index < parts.length; index++) {
    const candidate = join(ancestor, parts[index]!);
    const entry = lstatSync(candidate, { throwIfNoEntry: false });
    if (entry === undefined) {
      ancestor = join(ancestor, ...parts.slice(index));
      break;
    }
    ancestor = realpathSync.native(candidate);
  }
  return /[\\/]$/.test(path) && !ancestor.endsWith(sep) ? ancestor + sep : ancestor;
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

function guardedStampLiterals(paths: string[]): FilesystemPathEntry[] {
  if (!AVE_HOME_ISOLATION_GUARD_ACTIVE) return paths.map(path => ({ path, literal: true }));
  const identities = new Map<string, { identity: FileIdentity; linkTarget: string | undefined } | undefined>();
  const verify = (): void => {
    const checked = new Set<string>();
    const verifyPath = (path: string): void => {
      if (checked.has(path)) return;
      checked.add(path);
      let missing = false;
      for (const component of stampPathChain(path)) {
        const entry: BigIntStats | undefined = missing ? undefined : lstatSync(component, { bigint: true, throwIfNoEntry: false });
        const linkTarget = entry?.isSymbolicLink() ? readlinkSync(component) : undefined;
        const previous = identities.get(component);
        // A missing component that appears as a non-link cannot redirect the path; record it instead of failing.
        if (identities.has(component) && !(previous === undefined && entry !== undefined && linkTarget === undefined)) {
          if (entry === undefined ? previous !== undefined : previous === undefined ||
              !sameFileIdentity(previous.identity, entry) || previous.linkTarget !== linkTarget) {
            throw new Error(`Sandbox stamp target identity changed: ${path}`);
          }
        } else {
          identities.set(component, entry === undefined ? undefined : { identity: entry, linkTarget });
        }
        if (linkTarget !== undefined) verifyPath(resolve(dirname(component), linkTarget));
        missing ||= entry === undefined;
      }
    };
    for (const path of paths) verifyPath(path);
  };
  verify();
  // The runtime reads marked paths after its async lookups; keep this check on that consumption boundary.
  return paths.map(path => ({ get path() { verify(); return path; }, literal: true }));
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

// The runtime normalizes a marked literal again (environment references, tilde, prefix, realpath) before any existence check; hand one off only if that string is exactly a spelling checked here.
function assertRuntimeReadsAs(path: string, target: string): void {
  if (!isPlainWindowsStampPath(path)) throw new Error(`Sandbox stamp target is not a plain drive path: ${JSON.stringify(path)}`);
  const exact = (spelling: string) => spelling.replace(/\\$/, "");
  const reread = exact(normalizePathForSandbox(path, { literal: true }));
  if (![path, target].some(checked => exact(checked) === reread)) {
    throw new Error(`Sandbox stamp target is reinterpreted by the runtime: ${path}`);
  }
}

export function pinWindowsFilesystemConfig<T extends Partial<FilesystemConfig> | undefined>(filesystem: T): T {
  if (process.platform !== "win32" || filesystem === undefined) return filesystem;
  const pin = (entries: readonly FilesystemPathEntry[], mode: "grant" | "deny"): FilesystemPathEntry[] =>
    expandWindowsFsPaths(entries, { mode }).map(path => path.replace(/\//g, "\\")).flatMap(path => {
      if (!isPlainWindowsStampPath(path)) throw new Error(`Sandbox stamp target is not a plain drive path: ${JSON.stringify(path)}`);
      const canonical = canonicalStampPath(path);
      const literals = mode === "deny" && path !== canonical ? [path, canonical] : [canonical];
      for (const literal of literals) assertRuntimeReadsAs(literal, canonical);
      // The runtime drops a grant whose target is missing; drop it here too rather than hand off a string nothing checked.
      if (mode === "grant" && lstatSync(canonical, { throwIfNoEntry: false }) === undefined) return [];
      return guardedStampLiterals(literals);
    });
  return {
    ...filesystem,
    allowRead: pin(filesystem.allowRead ?? [], "grant"),
    allowWrite: pin(filesystem.allowWrite ?? [], "grant"),
    denyRead: pin(filesystem.denyRead ?? [], "deny"),
    denyWrite: pin(filesystem.denyWrite ?? [], "deny"),
  };
}
