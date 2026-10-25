/** Fence every path, reject escaping/network links and verify file and ancestor identities after reads.
 * A writer restoring an intermediate directory between checks can still redirect one read. */
import { sha256Hex } from "../../lib/hex-digest-equal.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalZipEntryPathIdentity, sanitizeZipEntryPath } from "../../plugins/zip-entry-path.js";
import { MARKETPLACE_DESCRIPTOR_FILE, type PackageKind } from "../catalog/types.js";
import { MarketplaceError } from "../errors.js";
import type { ExportedFile, ExportLimits } from "../git/repo.js";
import {
  fenceFolderFs,
  folderUnreadable,
  isNetworkLinkText,
  joinFolderPath,
  linkLeavesForNetwork,
  MAX_LINKS_PER_RESOLUTION,
  resolveLinkText,
  splitFolderPath,
  unreadable,
  type FolderRoot,
} from "../net/source-input.js";
import { treeDigest } from "../resolve/tree-digest.js";
import type { FolderFs, FolderStat } from "./folder-fs.js";
import { packageInstalls, type SourceTree } from "./source-tree.js";

/** Skip metadata at every depth, case-insensitively; never read, digest or install it. */
function isSkippedFolderEntry(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === ".git" || lower === ".ds_store" || name.startsWith("._") || lower === "thumbs.db" || lower === "desktop.ini";
}

function folded(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/** Descriptors are read separately and excluded from payload and left-out lists. */
const PACKAGE_READ_FILES = [MARKETPLACE_DESCRIPTOR_FILE, "plugin.json", "SKILL.md", "AGENTS.md", "server.json"] as const;
const PACKAGE_READ_LIMIT = 1024 * 1024;

export interface FolderFile {
  path: string;
  data: Buffer;
  executable: boolean;
}

export interface FolderPackage {
  treeSha256: string;
  files: FolderFile[];
  notInstalled: string[];
}

export interface FolderCapture {
  treeSha256: string;
  notInstalled: string[];
  executable: Set<string>;
}

interface Resolved {
  segments: string[];
  stat: FolderStat;
}

export interface FolderTreeOptions {
  fs: FolderFs;
  platform: NodeJS.Platform;
  root: FolderRoot;
  readAt: string;
  limits: ExportLimits;
  /** Network paths require network-folder consent before access. */
  networkConsented: boolean;
}

function identity(stat: FolderStat): string {
  return `${stat.dev}:${stat.ino}`;
}

export class FolderTree implements SourceTree {
  readonly reads = new Map<string, string>();
  private readonly packages = new Map<string, Promise<FolderPackage>>();
  private readonly dirs = new Map<string, FolderStat>();
  private readonly rootSplit: { root: string; segments: string[] };
  private readonly fs: FolderFs;
  /** Cache listings for spelling only, not filesystem authority. */
  private readonly listings = new Map<string, Promise<string[]>>();

  constructor(private readonly options: FolderTreeOptions) {
    this.fs = fenceFolderFs(options.fs, options.platform, { consented: options.networkConsented, address: options.root.path });
    this.rootSplit = splitFolderPath(options.root.path, options.platform);
    this.dirs.set("", { kind: "directory", dev: options.root.dev, ino: options.root.ino, size: 0, executable: false });
  }

  get root(): FolderRoot {
    return this.options.root;
  }

  private abs(segments: readonly string[]): string {
    return joinFolderPath({ root: this.rootSplit.root, segments: [...this.rootSplit.segments, ...segments] }, this.options.platform);
  }

  private inside(path: string): string[] | null {
    const split = splitFolderPath(path, this.options.platform);
    if (split.root !== this.rootSplit.root) return null;
    const base = this.rootSplit.segments;
    if (split.segments.length < base.length || base.some((segment, index) => split.segments[index] !== segment)) return null;
    return split.segments.slice(base.length);
  }

  private async lstat(segments: readonly string[]): Promise<FolderStat | null> {
    const at = this.abs(segments);
    try {
      return await this.fs.lstat(at);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw folderUnreadable(at, error);
    }
  }

  private changed(segments: readonly string[], why: string): MarketplaceError {
    return unreadable("changed-during-read", this.abs(segments), why);
  }

  /** A previously recorded directory identity must not change during the read. */
  private recordDir(segments: readonly string[], stat: FolderStat): void {
    const key = segments.join("/");
    const seen = this.dirs.get(key);
    if (!seen) {
      this.dirs.set(key, stat);
      return;
    }
    if (seen.dev !== stat.dev || seen.ino !== stat.ino) throw this.changed(segments, `${key} was replaced during the read`);
  }

  /** Refresh cached listings when resolving an unlisted name or enumerating. */
  private list(segments: readonly string[], fresh = false): Promise<string[]> {
    const at = this.abs(segments);
    let listing = fresh ? undefined : this.listings.get(at);
    if (!listing) {
      listing = this.fs.readdir(at).catch((error: unknown) => {
        throw folderUnreadable(at, error);
      });
      this.listings.set(at, listing);
    }
    return listing;
  }

  /** Resolve aliases by listed identity, preferring case variants; ambiguous or unidentifiable entries are absent. */
  private async onDisk(parent: readonly string[], name: string, stat: FolderStat): Promise<string | null> {
    let names = await this.list(parent);
    if (names.includes(name)) return name;
    names = await this.list(parent, true);
    if (names.includes(name)) return name;
    const wanted = folded(name);
    const likely = names.filter((entry) => folded(entry) === wanted);
    if (stat.ino === 0n) return likely.length === 1 ? likely[0]! : null;
    for (const entry of [...likely, ...names.filter((other) => !likely.includes(other))]) {
      const other = await this.lstat([...parent, entry]);
      if (other && other.dev === stat.dev && other.ino === stat.ino) return entry;
    }
    return null;
  }

  /** Resolve links lexically before access; reject network, escaping and skipped targets without touching them. */
  private async resolve(path: string): Promise<Resolved | null> {
    let stack: string[] = [];
    let queue = path.split("/").filter((segment) => segment !== "").map((name) => ({ name, linked: null as string | null }));
    let links = 0;
    let stat: FolderStat = this.dirs.get("")!;
    while (queue.length > 0) {
      const { name: typed, linked } = queue.shift()!;
      const found = await this.lstat([...stack, typed]);
      if (!found) return null;
      const name = await this.onDisk(stack, typed, found);
      if (name === null) return null;
      if (isSkippedFolderEntry(name)) {
        if (linked === null) return null;
        const shown = linked;
        throw new MarketplaceError("CONTENT_RULE_VIOLATION", `${shown} links into ${[...stack, name].join("/")}, which is never read`, {
          detail: { reason: "link-to-skipped", path: shown, target: [...stack, name].join("/") },
        });
      }
      const segments = [...stack, name];
      const entry = found;
      if (entry.kind === "link") {
        links += 1;
        const shown = segments.join("/");
        if (links > MAX_LINKS_PER_RESOLUTION) {
          throw new MarketplaceError("CONTENT_RULE_VIOLATION", `${shown}: more than ${MAX_LINKS_PER_RESOLUTION} links, a link loop`, {
            detail: { reason: "limit", path: shown, limit: `${MAX_LINKS_PER_RESOLUTION} links in one resolution (a link loop)` },
          });
        }
        const text = await this.readlink(segments);
        const linkDir = this.abs(stack);
        const target = resolveLinkText(linkDir, text, this.options.platform);
        if (
          (await isNetworkLinkText(text, this.options.platform, this.fs)) ||
          (target !== null && (await linkLeavesForNetwork(linkDir, target, this.options.platform, this.fs)))
        ) {
          throw new MarketplaceError("CONTENT_RULE_VIOLATION", `${shown} links to a network location (${text})`, {
            detail: { reason: "link-to-network", path: shown, target: text },
          });
        }
        const within = target === null ? null : this.inside(target);
        if (within === null) {
          throw new MarketplaceError("CONTENT_RULE_VIOLATION", `${shown} links outside the folder (${text})`, {
            detail: { reason: "link-outside-folder", path: shown, target: text },
          });
        }
        stack = [];
        queue = [...within.map((segment) => ({ name: segment, linked: shown })), ...queue];
        stat = this.dirs.get("")!;
        continue;
      }
      if (queue.length > 0) {
        if (entry.kind !== "directory") return null;
        this.recordDir(segments, entry);
      }
      stack = segments;
      stat = entry;
    }
    if (stat.kind === "directory") this.recordDir(stack, stat);
    return { segments: stack, stat };
  }

  private async readlink(segments: readonly string[]): Promise<string> {
    const at = this.abs(segments);
    try {
      return await this.fs.readlink(at);
    } catch (error) {
      throw folderUnreadable(at, error);
    }
  }

  /** Match opened file identity to the walk, then recheck every ancestor after the bounded read. */
  private async readRegular(segments: readonly string[], seen: FolderStat, maxBytes: number, shown: string, limit = `${maxBytes} bytes per file`): Promise<Buffer> {
    const at = this.abs(segments);
    const fs = this.fs;
    let handle;
    try {
      handle = await fs.open(at);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw this.changed(segments, `${shown} became a link during the read`);
      throw folderUnreadable(at, error);
    }
    let bytes: Buffer;
    try {
      const opened = await fs.fstat(handle);
      if (opened.kind !== "file" || opened.dev !== seen.dev || opened.ino !== seen.ino) {
        throw this.changed(segments, `${shown} is not the file the walk saw`);
      }
      try {
        bytes = await fs.read(handle, maxBytes);
      } catch (error) {
        throw folderUnreadable(at, error);
      }
    } finally {
      await fs.close(handle);
    }
    if (bytes.length > maxBytes) {
      throw new MarketplaceError("CONTENT_RULE_VIOLATION", `${shown} is larger than ${maxBytes} bytes`, {
        detail: { reason: "limit", path: shown, limit },
      });
    }
    await this.recheckChain(segments.slice(0, -1));
    return bytes;
  }

  /** `lstat` every directory from the root to `segments` again; one replaced or turned into a link fails the read. */
  private async recheckChain(segments: readonly string[]): Promise<void> {
    for (let depth = 0; depth <= segments.length; depth += 1) {
      const prefix = segments.slice(0, depth);
      const recorded = this.dirs.get(prefix.join("/"));
      if (!recorded) throw new Error(`the walk never recorded ${prefix.join("/") || "the root"}`);
      const now = await this.lstat(prefix);
      if (!now || now.kind !== "directory" || now.dev !== recorded.dev || now.ino !== recorded.ino) {
        throw this.changed(prefix, `${prefix.join("/") || "the folder"} changed while a file in it was read`);
      }
    }
  }

  async ensure(): Promise<void> {}

  async readFile(path: string, maxBytes: number): Promise<Buffer | null> {
    const bytes = await this.readOnce(path, maxBytes);
    if (bytes !== null) this.reads.set(path, sha256Hex(bytes));
    return bytes;
  }

  private async readOnce(path: string, maxBytes: number): Promise<Buffer | null> {
    const found = await this.resolve(path);
    if (!found) return null;
    if (found.stat.kind !== "file") {
      if (found.stat.kind === "directory") return null;
      throw new MarketplaceError("CONTENT_RULE_VIOLATION", `${path} is not a regular file`, { detail: { reason: "special-file", path } });
    }
    return this.readRegular(found.segments, found.stat, maxBytes, path);
  }

  async exportPath(path: string, dest: string, limits: ExportLimits): Promise<ExportedFile[]> {
    const { files } = await this.walk(path, null, limits);
    for (const file of files) {
      const target = join(dest, ...file.path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.data, { mode: file.executable ? 0o755 : 0o644, flag: "wx" });
    }
    return files.map((file) => ({ path: file.path, size: file.data.length, executable: file.executable }));
  }

  async revisionTime(): Promise<string> {
    return this.options.readAt;
  }

  async synthesizedVersion(path: string, kind: PackageKind): Promise<string> {
    return `0.0.0+t${(await this.packageAt(path, kind)).treeSha256.slice(0, 12)}`;
  }

  packageAt(path: string, kind: PackageKind): Promise<FolderPackage> {
    const key = `${kind}\u0000${path}`;
    let read = this.packages.get(key);
    if (!read) {
      read = this.walk(path, kind, this.options.limits).then(({ files, notInstalled }) => ({ treeSha256: treeDigest(files), files, notInstalled }));
      this.packages.set(key, read);
    }
    return read;
  }

  async packageDigests(packages: ReadonlyArray<{ path: string; kind: PackageKind }>): Promise<Map<string, string>> {
    const digests = new Map<string, string>();
    for (const item of packages) digests.set(item.path, (await this.packageAt(item.path, item.kind)).treeSha256);
    return digests;
  }

  /** Capture fresh package bytes and compare them with snapshot digests; concurrent changes fail the plan. */
  async capture(path: string, kind: PackageKind, dest: string): Promise<FolderCapture> {
    const { files, notInstalled } = await this.walk(path, kind, this.options.limits);
    const executable = new Set<string>();
    const write = async (relative: string, data: Buffer, exec: boolean) => {
      const target = join(dest, ...relative.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data, { mode: exec ? 0o755 : 0o644 });
      if (exec) executable.add(relative);
    };
    const prefix = path === "" ? "" : `${path}/`;
    for (const file of files) await write(`${prefix}${file.path}`, file.data, file.executable);
    for (const name of PACKAGE_READ_FILES) {
      if (files.some((file) => file.path === name)) continue;
      const at = `${prefix}${name}`;
      const bytes = await this.readOnce(at, PACKAGE_READ_LIMIT);
      if (bytes === null) continue;
      const seen = this.reads.get(at);
      if (seen !== undefined && seen !== sha256Hex(bytes)) throw unreadable("changed-during-read", this.abs(at.split("/")), `${at} changed after the folder was read`);
      await write(at, bytes, false);
    }
    return { treeSha256: treeDigest(files), notInstalled, executable };
  }

  /** Read only installed payload when kind is specified; abort at the first resource limit. */
  private async walk(path: string, kind: PackageKind | null, limits: ExportLimits): Promise<{ files: FolderFile[]; notInstalled: string[] }> {
    const files: FolderFile[] = [];
    const notInstalled: string[] = [];
    const identities = new Set<string>();
    const visited = new Set<string>();
    let total = 0;
    const shown = (relative: readonly string[]) => [path, ...relative].filter(Boolean).join("/");
    const base = await this.resolve(path);
    if (!base) return { files, notInstalled };
    if (base.stat.kind !== "directory") {
      throw new MarketplaceError("CONTENT_RULE_VIOLATION", `${path || "the folder root"} is not a directory`, { detail: { reason: "special-file", path: path || "." } });
    }

    const addFile = async (segments: readonly string[], stat: FolderStat, relative: readonly string[]) => {
      const name = relative.map((segment) => segment.normalize("NFC")).join("/");
      try {
        if (sanitizeZipEntryPath(path || "folder", name) === null) throw new Error("empty path");
      } catch (error) {
        throw new MarketplaceError("CONTENT_RULE_VIOLATION", `${shown(relative)}: ${(error as Error).message}`);
      }
      const id = canonicalZipEntryPathIdentity(name);
      if (identities.has(id)) {
        throw new MarketplaceError("CONTENT_RULE_VIOLATION", `${shown(relative)} collides with another name after NFC or ignoring case`, {
          detail: { reason: "case-collision", path: shown(relative) },
        });
      }
      identities.add(id);
      if (files.length + 1 > limits.maxFiles) {
        throw new MarketplaceError("CONTENT_RULE_VIOLATION", `${shown([])}: more than ${limits.maxFiles} files`, {
          detail: { reason: "limit", path: shown([]) || ".", limit: `${limits.maxFiles} files` },
        });
      }
      const data = await this.readRegular(segments, stat, Math.max(limits.maxBytes - total, 0), shown(relative), `${limits.maxBytes} bytes in ${shown([]) || "the folder"}`);
      total += data.length;
      files.push({ path: name, data, executable: stat.executable });
    };

    const walkDir = async (segments: readonly string[], stat: FolderStat, relative: readonly string[]): Promise<void> => {
      const key = identity(stat);
      // Repeated directory identities through links are loops; zero identities cannot prove equality.
      if (stat.ino !== 0n && visited.has(key)) {
        throw new MarketplaceError("CONTENT_RULE_VIOLATION", `${shown(relative)} is reached twice: a link loop`, {
          detail: { reason: "limit", path: shown(relative) || ".", limit: "each directory once (a link loop)" },
        });
      }
      visited.add(key);
      const names = await this.list(segments, true);
      for (const name of [...names].sort()) {
        if (isSkippedFolderEntry(name)) continue;
        const childSegments = [...segments, name];
        const childRelative = [...relative, name];
        let entry = await this.lstat(childSegments);
        if (!entry) throw this.changed(childSegments, `${shown(childRelative)} disappeared during the read`);
        let at = childSegments;
        if (entry.kind === "link") {
          const target = await this.resolve(childSegments.join("/"));
          if (!target) {
            throw new MarketplaceError("CONTENT_RULE_VIOLATION", `${shown(childRelative)} links to something that does not exist`);
          }
          entry = target.stat;
          at = target.segments;
        }
        if (relative.length === 0 && kind !== null && !packageInstalls(kind, name, entry.kind === "directory")) {
          if (kind === "plugin" && name !== MARKETPLACE_DESCRIPTOR_FILE) notInstalled.push(entry.kind === "directory" ? `${name}/` : name);
          continue;
        }
        if (entry.kind === "directory") {
          this.recordDir(at, entry);
          await walkDir(at, entry, childRelative);
        } else if (entry.kind === "file") {
          await addFile(at, entry, childRelative);
        } else {
          throw new MarketplaceError("CONTENT_RULE_VIOLATION", `${shown(childRelative)} is a device, socket or FIFO`, {
            detail: { reason: "special-file", path: shown(childRelative) },
          });
        }
      }
    };
    await walkDir(base.segments, base.stat, []);
    files.sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));
    return { files, notInstalled: notInstalled.sort() };
  }
}
