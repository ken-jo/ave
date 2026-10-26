import { stripExtendedPathPrefix } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import { win32 } from "node:path";
import { admitWindowsReparse, pinWindowsPaths, type WindowsPathFacts } from "../shared/windows-path-facts.js";

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
export function pinWindowsGrantTargets(paths: readonly string[], options: {
  allowMissing?: boolean;
  validatePath: (path: string) => void;
}): WindowsPathFacts[] {
  paths.forEach(options.validatePath);
  let pending = paths.map((path, index) => ({ path, index }));
  const result: WindowsPathFacts[] = [];
  for (let hop = 0; pending.length > 0 && hop < 40; hop++) {
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
