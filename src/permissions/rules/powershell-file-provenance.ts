import { statSync } from "node:fs";
import { isAbsolute, posix } from "node:path";
import { canonicalPowerShellName, POWERSHELL_COMMAND_POLICIES, PowerShellAnalysisContext, joinPowerShellText, lowerPowerShellText } from "./powershell-command-policy.js";

// Unknown file types stay opaque; inert default actions never authorize explicit execution or same-input file provenance.
export { POWERSHELL_FILE_TYPES } from "./powershell-file-types.js";
import { POWERSHELL_FILE_TYPES } from "./powershell-file-types.js";

interface MaterializedFile { catalogue?: string }
interface FileRevision { file: MaterializedFile; revision: number; previous?: FileRevision }
interface ProvenanceSnapshot {
  paths: ReadonlyMap<string, FileRevision>;
  leaves: ReadonlyMap<string, FileRevision>;
  roots: ReadonlyMap<string, number>;
  revision: number;
  previous?: ProvenanceSnapshot;
}

// Monotone facts: uncertainty, overwrites and scope changes never erase provenance.
export class PowerShellFileProvenance {
  private readonly paths = new Map<string, FileRevision>();
  private readonly leaves = new Map<string, FileRevision>();
  private readonly roots = new Map<string, number>();
  private parent?: ProvenanceSnapshot;
  private executableWrites = false;
  private opaque = false;
  private unknownLeaves = false;
  private opaqueEffects = false;
  revision = 0;

  constructor(private readonly analysis: PowerShellAnalysisContext, private readonly cwd: string | undefined) {}

  fork(): PowerShellFileProvenance {
    const copy = new PowerShellFileProvenance(this.analysis, this.cwd);
    copy.parent = this.snapshot();
    copy.opaque = this.opaque;
    copy.unknownLeaves = this.unknownLeaves;
    copy.opaqueEffects = this.opaqueEffects;
    copy.executableWrites = this.executableWrites;
    copy.revision = this.revision;
    return copy;
  }

  private snapshot(): ProvenanceSnapshot {
    return { paths: this.paths, leaves: this.leaves, roots: this.roots, revision: this.revision, previous: this.parent };
  }

  private findFile(kind: "paths" | "leaves", path: string): MaterializedFile | undefined {
    for (let scope: ProvenanceSnapshot | undefined = this.snapshot(); scope !== undefined; scope = scope.previous) {
      let entry = scope[kind].get(path);
      while (entry !== undefined && entry.revision > scope.revision) entry = entry.previous;
      if (entry !== undefined) return entry.file;
    }
    return undefined;
  }

  private *visibleKeys(kind: "paths" | "leaves" | "roots"): Generator<string> {
    const scopes: ProvenanceSnapshot[] = [];
    for (let scope: ProvenanceSnapshot | undefined = this.snapshot(); scope !== undefined; scope = scope.previous) scopes.push(scope);
    const seen = new Set<string>();
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const scope = scopes[index]!;
      for (const [path, entry] of scope[kind]) {
        let visible: typeof entry | undefined = entry;
        while (typeof visible !== "number" && visible !== undefined && visible.revision > scope.revision) visible = visible.previous;
        if (visible === undefined) continue;
        const revision = typeof visible === "number" ? visible : visible.revision;
        if (seen.has(path) || revision > scope.revision) continue;
        seen.add(path);
        yield path;
      }
    }
  }

  private path(text: string): string {

    const normalized = lowerPowerShellText(joinPowerShellText(text.replace(/\\/g, "/").split("/")
      .map((part) => part === "." || part === ".." ? part : part.replace(/[ .]+$/, "")), "/"));
    return posix.normalize(/^(?:\/|[a-z]:\/)/.test(normalized) ? normalized : joinPowerShellText([this.cwd?.replace(/\\/g, "/").toLowerCase() ?? ".", normalized], "/"));
  }

  fileType(text: string): "opaque" | "script" | "document" | undefined {
    return POWERSHELL_FILE_TYPES[posix.extname(this.path(text))];
  }

  isDirectory(text: string): boolean {

    return /[\\/]$/.test(text) || /^(?:\.{1,2}|[a-z]:[\\/])$/i.test(text);
  }

  // A pre-call directory observation cannot survive possible filesystem effects.
  isExistingDirectory(text: string): boolean {

    if (this.revision !== 0 || /^(?:~|[\\/]{2})/.test(text) || /^[\\/]{2}/.test(this.cwd ?? "")
      || (process.platform !== "win32" && (/^[a-z]:/i.test(text) || /^[a-z]:/i.test(this.cwd ?? "")))
      || (!isAbsolute(text) && (this.cwd === undefined || !isAbsolute(this.cwd)))
      || (process.platform === "win32" && !/^[a-z]:[\\/]/i.test(isAbsolute(text) ? text : this.cwd ?? ""))) return false;

    const path = isAbsolute(text) ? text : joinPowerShellText([this.cwd ?? ".", text], "/");
    try { return statSync(path).isDirectory(); }
    catch { return false; }
  }

  record(text: string | undefined, options: { source?: string; directory?: boolean; tree?: boolean } = {}): void {

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
    const file = { catalogue: catalogue ?? this.findFile("paths", path)?.catalogue };
    this.paths.set(path, { file, revision: this.revision, previous: this.paths.get(path) });
    this.executableWrites ||= this.fileType(path) !== "document";
    const leaf = posix.basename(path);
    for (const spelling of new Set([leaf, leaf.slice(0, leaf.length - posix.extname(leaf).length)])) {

      this.leaves.set(spelling, { file: { catalogue: file.catalogue ?? this.findFile("leaves", spelling)?.catalogue }, revision: this.revision, previous: this.leaves.get(spelling) });
    }
    if (options.tree) { if (!this.roots.has(path)) this.roots.set(path, this.revision); this.unknownLeaves = true; }
  }

  lookup(text: string): MaterializedFile | undefined {
    const path = this.path(text);
    const leaf = posix.basename(path);
    const stem = leaf.slice(0, leaf.length - posix.extname(leaf).length);
    for (const candidate of [this.findFile("paths", path), this.findFile("leaves", leaf), this.findFile("leaves", stem)]) {

      if (candidate) return candidate;
    }
    const short = /^(.+?)~\d+(?:\.([^/]+))?$/.exec(leaf);
    if (short) for (const candidate of this.visibleKeys("leaves")) {
      const file = this.findFile("leaves", candidate)!;

      if (candidate.startsWith(short[1]!) && (!short[2] || posix.extname(candidate).slice(1).startsWith(short[2]))) return file;
    }
    for (const root of this.visibleKeys("roots")) {

      if (path.startsWith(`${root}/`)) return {};
    }
    return undefined;
  }

  // Unknown argv supplies no write paths, but cannot prove a later script untouched.
  observeOpaqueEffects(): void {

    if (!this.opaqueEffects) { this.opaqueEffects = true; this.revision += 1; }
  }

  // Script discovery need not name its executable inputs.
  hasExecutableWrites(): boolean {
    return this.opaque || this.unknownLeaves || this.executableWrites;
  }

  // Unresolved writes constrain execution checks; ordinary data lookups stay precise.
  executionTarget(text: string): MaterializedFile | undefined {
    return this.lookup(text) ?? (this.opaque || this.unknownLeaves || (this.opaqueEffects && this.fileType(text) === "script") ? {} : undefined);
  }
}
