import { statSync } from "node:fs";
import { isAbsolute, posix } from "node:path";
import { canonicalPowerShellName, POWERSHELL_COMMAND_POLICIES, PowerShellAnalysisBudget } from "./powershell-command-policy.js";

/**
 * Associated types: https://support.microsoft.com/en-us/outlook/blocked-attachments-in-outlook
 * and native catalogue extensions from https://lolbas-project.github.io/ (2026-10-15).
 * Document/media/data rows: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/MIME_types/Common_types
 * Unknown types stay opaque. Document rows describe the supported inert default action;
 * explicit execution and same-input file provenance retain their own launcher boundary.
 */
export { POWERSHELL_FILE_TYPES } from "./powershell-file-types.js";
import { POWERSHELL_FILE_TYPES } from "./powershell-file-types.js";

interface MaterializedFile {
  catalogue?: string;
}

/** Monotone facts: uncertainty, overwrites and scope changes never erase provenance. */
export class PowerShellFileProvenance {
  private readonly paths = new Map<string, MaterializedFile>();
  private readonly leaves = new Map<string, MaterializedFile>();
  private readonly roots = new Set<string>();
  private opaque = false;
  private unknownLeaves = false;
  private opaqueEffects = false;
  revision = 0;

  constructor(private readonly budget: PowerShellAnalysisBudget, private readonly cwd: string | undefined) {}

  fork(): PowerShellFileProvenance {
    this.budget.spend(this.paths.size + this.leaves.size + this.roots.size + 1);
    const copy = new PowerShellFileProvenance(this.budget, this.cwd);
    for (const [path, value] of this.paths) copy.paths.set(path, value);
    for (const [leaf, value] of this.leaves) copy.leaves.set(leaf, value);
    for (const root of this.roots) copy.roots.add(root);
    copy.opaque = this.opaque;
    copy.unknownLeaves = this.unknownLeaves;
    copy.opaqueEffects = this.opaqueEffects;
    copy.revision = this.revision;
    return copy;
  }

  private path(text: string): string {
    this.budget.spend(1, text.length);
    const normalized = text.replace(/\\/g, "/").split("/")
      .map((part) => part === "." || part === ".." ? part : part.replace(/[ .]+$/, "")).join("/").toLowerCase();
    return posix.normalize(/^(?:\/|[a-z]:\/)/.test(normalized) ? normalized : `${this.cwd?.replace(/\\/g, "/").toLowerCase() ?? "."}/${normalized}`);
  }

  fileType(text: string): "opaque" | "script" | "document" | undefined {
    return POWERSHELL_FILE_TYPES[posix.extname(this.path(text))];
  }

  isDirectory(text: string): boolean {
    this.budget.spend();
    return /[\\/]$/.test(text) || /^(?:\.{1,2}|[a-z]:[\\/])$/i.test(text);
  }

  /** A pre-call directory observation cannot survive possible filesystem effects. */
  isExistingDirectory(text: string): boolean {
    this.budget.spend(1, text.length);
    if (this.revision !== 0 || /^(?:~|[\\/]{2})/.test(text) || /^[\\/]{2}/.test(this.cwd ?? "")
      || (process.platform !== "win32" && (/^[a-z]:/i.test(text) || /^[a-z]:/i.test(this.cwd ?? "")))
      || (!isAbsolute(text) && (this.cwd === undefined || !isAbsolute(this.cwd)))
      || (process.platform === "win32" && !/^[a-z]:[\\/]/i.test(isAbsolute(text) ? text : this.cwd ?? ""))) return false;
    // Charge metadata queries before issuing them; repeated probes exhaust the shared budget.
    this.budget.spend(256);
    const path = isAbsolute(text) ? text : `${this.cwd}/${text}`;
    try { return statSync(path).isDirectory(); }
    catch { return false; }
  }

  record(text: string | undefined, options: { source?: string; directory?: boolean; tree?: boolean } = {}): void {
    this.budget.spend();
    this.revision += 1;
    if (text === undefined || /[*?\[\]]/.test(text)) {
      this.opaque = true;
      return;
    }
    const path = this.path(text);
    // Attempted creation and future actions establish no successful type proof.
    if (options.directory) return;
    const source = options.source;
    const sourceLeaf = source === undefined ? undefined : posix.basename(this.path(source));
    const catalogue = sourceLeaf && POWERSHELL_COMMAND_POLICIES[canonicalPowerShellName(sourceLeaf)]?.native ? sourceLeaf
      : source ? this.lookup(source)?.catalogue : undefined;
    const file = { catalogue: catalogue ?? this.paths.get(path)?.catalogue };
    this.paths.set(path, file);
    const leaf = posix.basename(path);
    for (const spelling of new Set([leaf, leaf.slice(0, leaf.length - posix.extname(leaf).length)])) {
      this.budget.spend();
      this.leaves.set(spelling, { catalogue: file.catalogue ?? this.leaves.get(spelling)?.catalogue });
    }
    if (options.tree) { this.roots.add(path); this.unknownLeaves = true; }
  }

  lookup(text: string): MaterializedFile | undefined {
    const path = this.path(text);
    const leaf = posix.basename(path);
    const stem = leaf.slice(0, leaf.length - posix.extname(leaf).length);
    for (const candidate of [this.paths.get(path), this.leaves.get(leaf), this.leaves.get(stem)]) {
      this.budget.spend();
      if (candidate) return candidate;
    }
    const short = /^(.+?)~\d+(?:\.([^/]+))?$/.exec(leaf);
    if (short) for (const [candidate, file] of this.leaves) {
      this.budget.spend();
      if (candidate.startsWith(short[1]!) && (!short[2] || posix.extname(candidate).slice(1).startsWith(short[2]))) return file;
    }
    for (const root of this.roots) {
      this.budget.spend();
      if (path.startsWith(`${root}/`)) return {};
    }
    return undefined;
  }

  /** Unknown argv supplies no write paths, but cannot prove a later script untouched. */
  observeOpaqueEffects(): void {
    this.budget.spend();
    if (!this.opaqueEffects) { this.opaqueEffects = true; this.revision += 1; }
  }

  /** Script discovery need not name its executable inputs. */
  hasExecutableWrites(): boolean {
    this.budget.spend();
    if (this.opaque || this.unknownLeaves) return true;
    for (const path of this.paths.keys()) if (this.fileType(path) !== "document") return true;
    return false;
  }

  /** Unresolved writes constrain execution checks; ordinary data lookups stay precise. */
  executionTarget(text: string): MaterializedFile | undefined {
    return this.lookup(text) ?? (this.opaque || this.unknownLeaves || (this.opaqueEffects && this.fileType(text) === "script") ? {} : undefined);
  }
}
