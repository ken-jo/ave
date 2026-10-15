import { posix } from "node:path";
import { POWERSHELL_COMMAND_POLICIES, PowerShellAnalysisBudget } from "./powershell-command-policy.js";

/**
 * Associated types: https://support.microsoft.com/en-us/outlook/blocked-attachments-in-outlook
 * and native catalogue extensions from https://lolbas-project.github.io/ (2026-10-15).
 * Unknown types stay opaque. Document rows describe the supported inert default action;
 * explicit execution and same-input file provenance retain their own launcher boundary.
 */
export const POWERSHELL_FILE_TYPES: Readonly<Record<string, "opaque" | "script" | "document">> = Object.freeze({
  ...Object.fromEntries((
    ".ade .adp .apk .app .appcontent-ms .application .appref-ms .appx .asp .aspx .asx .bas .bat .bgi .cab .cdxml .cer .chm .cmd .cnt .com .cpl .crt .csh .der .diagcab .exe .fxp .gadget .grp .hlp .hpj .hta .htc .img .inf .ins .iso .isp .its .jar .jnlp .js .jse .ksh .library-ms .lnk .mad .maf .mag .mam .maq .mar .mas .mat .mau .mav .maw .mcf .mda .mdb .mde .mdt .mdw .mdz .msc .mht .mhtml .msh .msh1 .msh2 .mshxml .msh1xml .msh2xml .msi .msp .mst .msu .ops .osd .pcd .pif .pl .plg .prf .prg .printerexport .ps1 .ps1xml .ps2 .ps2xml .psc1 .psc2 .psd1 .psdm1 .pssc .pst .py .pyc .pyo .pyw .pyz .pyzw .reg .scf .scr .sct .search-ms .settingcontent-ms .shb .shs .theme .tmp .udl .url .vb .vbe .vbp .vbs .vhd .vhdx .vsmacros .vsw .webpnp .website .ws .wsb .wsc .wsf .wsh .xbap .xll .xnk"
  ).split(" ").map((extension) => [extension, "opaque" as const])),
  ...Object.fromEntries(Object.entries(POWERSHELL_COMMAND_POLICIES).filter(([, policy]) => policy.native)
    .map(([name]) => [posix.extname(name), "opaque" as const])),
  ".ps1": "script", ".psm1": "script",
  ".txt": "document", ".md": "document", ".png": "document",
});

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
    const catalogue = sourceLeaf && POWERSHELL_COMMAND_POLICIES[sourceLeaf]?.native ? sourceLeaf
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
    return this.opaque || this.unknownLeaves ? {} : undefined;
  }
}
