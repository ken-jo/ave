import { stripExtendedPathPrefix } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import type { FilesystemPathEntry } from "@anthropic-ai/sandbox-runtime";
import { homedir } from "node:os";
import { win32 } from "node:path";
import { routeLocality, withLocalityDecision } from "../shared/local-path-io.js";
import { admitWindowsReparse, pinWindowsPaths, type WindowsPathFacts } from "../shared/windows-path-facts.js";
import { containsGlobChars, containsGlobCharsWin, expandWindowsEnvRefs } from "./sandbox-path-spelling.js";

export interface ExpandedWindowsGrant {
  readonly original: string;
  readonly entry: FilesystemPathEntry;
  readonly literalPrefixLength: number;
  readonly patternTail: string | undefined;
}

export function expandWindowsGrantPath(entry: FilesystemPathEntry): ExpandedWindowsGrant {
  const original = typeof entry === "string" ? entry : entry.path;
  const home = homedir();
  const tilde = original === "~" || /^~[\\/]/.test(original);
  let prefixEnd = tilde ? 1 : 0;
  let shift = tilde ? home.length - 1 : 0;
  let globExpansionVariable = tilde && containsGlobChars(home) ? "USERPROFILE" : undefined;
  const envExpanded = expandWindowsEnvRefs(original, {
    home,
    onReference(replacement, offset, length) {
      prefixEnd = offset + length;
      shift += replacement.length - length;
      if (globExpansionVariable === undefined && containsGlobChars(replacement)) {
        globExpansionVariable = original.slice(offset + 1, prefixEnd - 1).toUpperCase();
      }
    },
  });
  const expanded = tilde ? home + envExpanded.slice(1) : envExpanded;
  if (expanded.includes("%")) throw new Error("Windows filesystem grant is not a plain drive path: percent sign after expansion");
  const isPattern = typeof entry === "string" && containsGlobCharsWin(original);
  // The grant walk has no escape for a literal prefix inside a pattern.
  if (globExpansionVariable !== undefined) {
    throw new Error(`filesystem-expansion-glob: ${globExpansionVariable} value contains glob characters. Use the explicit absolute path without a wildcard.`);
  }
  if (isPattern && containsGlobChars(original.slice(0, prefixEnd))) {
    throw new Error("filesystem-expansion-glob: Glob characters appear before a profile reference in the grant. Put the reference before any glob characters.");
  }
  const path = expanded.replace(/\//g, "\\").replace(/^[a-z]:/, drive => drive.toUpperCase());
  return {
    original,
    entry: typeof entry === "string" ? path : { ...entry, path },
    literalPrefixLength: prefixEnd + shift,
    patternTail: isPattern ? original.slice(prefixEnd) : undefined,
  };
}

export function windowsGrantBase({ entry, literalPrefixLength, patternTail }: ExpandedWindowsGrant): string {
  const path = typeof entry === "string" ? entry : entry.path;
  if (patternTail === undefined) return path;
  const fixed = path.slice(0, literalPrefixLength + patternTail.search(/[*?[\]]/));
  return fixed.endsWith("\\") ? fixed : win32.dirname(fixed);
}

export function assertWindowsGrantGrammar(path: string): void {
  if (!/^[a-z]:[\\/]/i.test(path) || /[\0*?]/.test(path) || /:/.test(path.slice(2))) {
    throw new Error(`Windows filesystem grant requires a literal local absolute path: ${path}`);
  }
  const normalized = win32.normalize(path);
  if (normalized.slice(win32.parse(normalized).root.length).split(/[\\/]/).filter(Boolean).length < 2) {
    throw new Error(`Windows filesystem grant refuses a root or one-component path: ${path}`);
  }
}

/** Resolve one admitted link per pin so a later surrogate cannot hide behind it. */
export function pinWindowsGrantTargets(...args: Parameters<typeof pinWindowsGrantTargetsInDecision>): WindowsPathFacts[] {
  return withLocalityDecision(() => pinWindowsGrantTargetsInDecision(...args));
}

function pinWindowsGrantTargetsInDecision(paths: readonly string[], options: {
  allowMissing?: boolean;
  validatePath: (path: string) => void;
}): WindowsPathFacts[] {
  paths.forEach(options.validatePath);
  let pending = paths.map((path, index) => ({ path, index }));
  const result: WindowsPathFacts[] = [];
  for (let hop = 0; pending.length > 0 && hop < 40; hop++) {
    // The pin opens each path from its volume root, so its route, and each link target it reaches, is proven local first.
    const unproven = pending.find(row => routeLocality(row.path) !== "local");
    if (unproven !== undefined) throw new Error(`Windows filesystem grant names no proven local path: ${unproven.path}`);
    const rows = pinWindowsPaths(pending.map(row => row.path));
    const next: typeof pending = [];
    for (const [offset, request] of pending.entries()) {
      const row = rows[offset]!;
      const admission = admitWindowsReparse(row, "grant");
      if (admission === "resolve") {
        const components = [...row.ancestors, row];
        const linkIndex = components.findIndex(component => admitWindowsReparse({ ...component, ancestors: [] }, "grant") === "resolve");
        const component = components[linkIndex]!;
        const link = stripExtendedPathPrefix(component.canonical!);
        if (!component.reparseTarget) throw new Error(`Windows filesystem grant link target is unproven: ${link}`);
        const normalized = win32.normalize(request.path);
        const remaining = normalized.slice(win32.parse(normalized).root.length).split(/[\\/]/).filter(Boolean).slice(linkIndex);
        const target = stripExtendedPathPrefix(component.reparseTarget);
        // Validate before normalization or opening can trim a component of the substitute name.
        if (win32.isAbsolute(target)) options.validatePath(target);
        else if (target.split(/[\\/]/).some(part => part !== "." && part !== ".." && /[. ]$/.test(part))) {
          options.validatePath(`${win32.dirname(link)}\\${target}`);
        }
        const resolved = win32.resolve(win32.dirname(link), target, ...remaining);
        options.validatePath(resolved);
        next.push({ ...request, path: resolved });
      } else {
        if (!admission || row.exists === null || (!options.allowMissing && row.exists !== true)) {
          throw new Error(`Windows filesystem grant identity is unproven (reparse point refused): ${request.path}`);
        }
        let canonical = row.canonical === null ? null : stripExtendedPathPrefix(row.canonical);
        if (row.exists === false) {
          const components = [...row.ancestors, row];
          const lastExisting = components.findIndex(component => component.exists !== true) - 1;
          const parent = components[lastExisting];
          if (!parent?.canonical) throw new Error(`Windows filesystem grant identity is unproven: ${request.path}`);
          const normalized = win32.normalize(request.path);
          const remaining = normalized.slice(win32.parse(normalized).root.length).split(/[\\/]/).filter(Boolean).slice(lastExisting);
          canonical = win32.join(stripExtendedPathPrefix(parent.canonical), ...remaining);
        }
        if (canonical === null) throw new Error(`Windows filesystem grant identity is unproven: ${request.path}`);
        options.validatePath(canonical);
        result[request.index] = { ...row, canonical };
      }
    }
    pending = next;
  }
  if (pending.length) throw new Error(`Windows filesystem grant link resolution limit: ${pending[0]!.path}`);
  return result;
}
