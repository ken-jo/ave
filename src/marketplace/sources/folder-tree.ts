/**
 * A folder source read in place (design §18.4.2, §18.4.5): the snapshot
 * builder reads it like a commit, and an install plan captures one package's
 * bytes from it into its staging directory.
 *
 * Every call goes through {@link FolderFs}. Beneath the canonical root
 * (stage 4's result) the rules are:
 *
 *   - directories are walked and regular files read; a device, socket or
 *     FIFO fails the package (`special-file`);
 *   - a link (a junction too) is never followed by the OS. Its text is read
 *     and judged before anything touches its target: text naming a network
 *     location is `link-to-network`; otherwise it is resolved lexically
 *     against the link's directory, and text leaving the root is
 *     `link-outside-folder`; inside, the walk continues at the target, with
 *     the same rule for every link it meets. A directory reached twice, or
 *     more than 40 links in one resolution, is a loop. The installed copy
 *     holds the target's bytes as a regular file;
 *   - a file is opened without following its last component where the OS
 *     can, and `fstat` must report the identity the walk's `lstat` saw;
 *   - each directory's identity is recorded when it is first reached, and
 *     after every file the directory chain from the root to that file is
 *     `lstat`ed again and compared, so a swap still in place when the file
 *     has been read fails the read (`changed-during-read`);
 *   - `.git/`, `.DS_Store`, `._*`, `Thumbs.db` and `desktop.ini` are skipped
 *     at any depth; names are NFC; names equal after NFC or ignoring case
 *     fail the package; the execute bit comes from `lstat` (none on Windows).
 *
 * The residual §18.4.5 states holds here too: a concurrent writer that swaps
 * an intermediate directory and restores it between the checks can redirect
 * one read, since Node offers no traversal anchored to held directory
 * handles.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalZipEntryPathIdentity, sanitizeZipEntryPath } from "../../plugins/zip-entry-path.js";
import type { PackageKind } from "../catalog/types.js";
import { MarketplaceError } from "../errors.js";
import type { ExportedFile, ExportLimits } from "../git/repo.js";
import {
  folderUnreadable,
  isNetworkLinkText,
  joinFolderPath,
  MAX_LINKS_PER_RESOLUTION,
  resolveLinkText,
  splitFolderPath,
  unreadable,
  type FolderRoot,
} from "../net/source-input.js";
import { treeDigest } from "../resolve/tree-digest.js";
import type { FolderFs, FolderStat } from "./folder-fs.js";
import { packageInstalls, type SourceTree } from "./source-tree.js";

/** Never read, digested or installed, at any depth (§18.4.5). */
function isSkippedFolderEntry(name: string): boolean {
  return name === ".git" || name === ".DS_Store" || name.startsWith("._") || name === "Thumbs.db" || name === "desktop.ini";
}

/** Top-level files a package's readers open beside what it installs: the descriptor and the files a direct source is detected from. */
/** The package's descriptor: read by the marketplace, never part of what a plugin installs, and not listed as left out. */
const DESCRIPTOR_FILE = "ave-package.json";
const PACKAGE_READ_FILES = [DESCRIPTOR_FILE, "plugin.json", "SKILL.md", "AGENTS.md", "server.json"] as const;
const PACKAGE_READ_LIMIT = 1024 * 1024;

export interface FolderFile {
  /** Package-relative, `/`-separated, NFC. */
  path: string;
  data: Buffer;
  executable: boolean;
}

export interface FolderPackage {
  /** The tree digest (§6.4) of the files the package installs. */
  treeSha256: string;
  files: FolderFile[];
  /** A plugin's top-level entries that are not installed (`src/`, `package.json`), sorted. */
  notInstalled: string[];
}

export interface FolderCapture {
  treeSha256: string;
  notInstalled: string[];
  /** Captured paths, relative to the folder root, whose execute bit is set. */
  executable: Set<string>;
}

interface Resolved {
  /** Canonical components beneath the root: no link among them. */
  segments: string[];
  stat: FolderStat;
}

export interface FolderTreeOptions {
  fs: FolderFs;
  platform: NodeJS.Platform;
  root: FolderRoot;
  /** When this read began: the revision's time. */
  readAt: string;
  /** The ceiling on one package's files and bytes while reading it (§5.4). */
  limits: ExportLimits;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function identity(stat: FolderStat): string {
  return `${stat.dev}:${stat.ino}`;
}

export class FolderTree implements SourceTree {
  /** sha256 of every file the snapshot read through {@link readFile}, by path: the revision's file lines (§18.4.3). */
  readonly reads = new Map<string, string>();
  private readonly packages = new Map<string, Promise<FolderPackage>>();
  /** The identity of every directory this read reached, by canonical path beneath the root ("" is the root). */
  private readonly dirs = new Map<string, FolderStat>();
  private readonly rootSplit: { root: string; segments: string[] };

  constructor(private readonly options: FolderTreeOptions) {
    this.rootSplit = splitFolderPath(options.root.path, options.platform);
    this.dirs.set("", { kind: "directory", dev: options.root.dev, ino: options.root.ino, size: 0, executable: false });
  }

  get root(): FolderRoot {
    return this.options.root;
  }

  private abs(segments: readonly string[]): string {
    return joinFolderPath({ root: this.rootSplit.root, segments: [...this.rootSplit.segments, ...segments] }, this.options.platform);
  }

  /** The components beneath the root that `path` names, or null when it lies outside (compared byte for byte). */
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
      return await this.options.fs.lstat(at);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw folderUnreadable(at, error);
    }
  }

  private changed(segments: readonly string[], why: string): MarketplaceError {
    return unreadable("changed-during-read", this.abs(segments), why);
  }

  /** Record a directory's identity when first reached; reaching it again with another identity is a change. */
  private recordDir(segments: readonly string[], stat: FolderStat): void {
    const key = segments.join("/");
    const seen = this.dirs.get(key);
    if (!seen) {
      this.dirs.set(key, stat);
      return;
    }
    if (seen.dev !== stat.dev || seen.ino !== stat.ino) throw this.changed(segments, `${key} was replaced during the read`);
  }

  /**
   * Follow `path` (beneath the root, `/`-separated) component by component.
   * Links are judged by their text: network → `link-to-network`, outside
   * the root → `link-outside-folder`, neither touching the target; inside,
   * the walk continues at the target. Null when nothing is there.
   */
  private async resolve(path: string): Promise<Resolved | null> {
    let stack: string[] = [];
    let queue = path.split("/").filter((segment) => segment !== "");
    let links = 0;
    let stat: FolderStat = this.dirs.get("")!;
    while (queue.length > 0) {
      const name = queue.shift()!;
      const segments = [...stack, name];
      const entry = await this.lstat(segments);
      if (!entry) return null;
      if (entry.kind === "link") {
        links += 1;
        const shown = segments.join("/");
        if (links > MAX_LINKS_PER_RESOLUTION) {
          throw new MarketplaceError("CONTENT_RULE_VIOLATION", `${shown}: more than ${MAX_LINKS_PER_RESOLUTION} links, a link loop`, {
            detail: { reason: "limit", path: shown, limit: `${MAX_LINKS_PER_RESOLUTION} links in one resolution (a link loop)` },
          });
        }
        const text = await this.readlink(segments);
        if (await isNetworkLinkText(text, this.options.platform, this.options.fs)) {
          throw new MarketplaceError("CONTENT_RULE_VIOLATION", `${shown} links to a network location (${text})`, {
            detail: { reason: "link-to-network", path: shown, target: text },
          });
        }
        const target = resolveLinkText(this.abs(stack), text, this.options.platform);
        const within = target === null ? null : this.inside(target);
        if (within === null) {
          throw new MarketplaceError("CONTENT_RULE_VIOLATION", `${shown} links outside the folder (${text})`, {
            detail: { reason: "link-outside-folder", path: shown, target: text },
          });
        }
        stack = [];
        queue = [...within, ...queue];
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
      return await this.options.fs.readlink(at);
    } catch (error) {
      throw folderUnreadable(at, error);
    }
  }

  /**
   * Read a regular file the walk found with `seen`: open it, check that
   * `fstat` is the file `lstat` saw, read at most `maxBytes`, then check the
   * directory chain from the root again (§18.4.5).
   */
  private async readRegular(segments: readonly string[], seen: FolderStat, maxBytes: number, shown: string, limit = `${maxBytes} bytes per file`): Promise<Buffer> {
    const at = this.abs(segments);
    const fs = this.options.fs;
    let handle;
    try {
      handle = await fs.open(at);
    } catch (error) {
      // O_NOFOLLOW refuses a final component that became a link after the walk saw a file.
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

  // ─── SourceTree ───────────────────────────────────────────────────────────

  async ensure(): Promise<void> {}

  /** One file the snapshot reads (the index, a descriptor, a revocations file); its digest joins the revision. */
  async readFile(path: string, maxBytes: number): Promise<Buffer | null> {
    const bytes = await this.readOnce(path, maxBytes);
    if (bytes !== null) this.reads.set(path, sha256(bytes));
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

  // ─── packages ─────────────────────────────────────────────────────────────

  /** The files package `path` of `kind` installs and their tree digest, read once per read (§18.4.3). */
  packageAt(path: string, kind: PackageKind): Promise<FolderPackage> {
    const key = `${kind}\u0000${path}`;
    let read = this.packages.get(key);
    if (!read) {
      read = this.walk(path, kind, this.options.limits).then(({ files, notInstalled }) => ({ treeSha256: treeDigest(files), files, notInstalled }));
      this.packages.set(key, read);
    }
    return read;
  }

  /** The digest of every package the snapshot listed, by package path: the revision's package lines. */
  async packageDigests(packages: ReadonlyArray<{ path: string; kind: PackageKind }>): Promise<Map<string, string>> {
    const digests = new Map<string, string>();
    for (const item of packages) digests.set(item.path, (await this.packageAt(item.path, item.kind)).treeSha256);
    return digests;
  }

  /**
   * Copy package `path` into `dest` (under the same relative path) for an
   * install plan (§18.4.2): what it installs, read again now, and the
   * top-level files its readers open (the descriptor, the detected file).
   * A read file whose bytes differ from what this read's snapshot saw fails
   * as `changed-during-read`, and the caller compares `treeSha256` with the
   * snapshot's, so a package that changed since the snapshot was read is
   * never captured.
   */
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
      if (seen !== undefined && seen !== sha256(bytes)) throw unreadable("changed-during-read", this.abs(at.split("/")), `${at} changed after the folder was read`);
      await write(at, bytes, false);
    }
    return { treeSha256: treeDigest(files), notInstalled, executable };
  }

  /**
   * Every file under `path`, read under the rules above: all of them
   * (`kind` null, an export) or the ones a package of `kind` installs.
   * Stops at the first limit exceeded.
   */
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
      // A directory reached twice through links is a loop (§18.4.5 rule 4); zero identities cannot tell, so they are not compared.
      if (stat.ino !== 0n && visited.has(key)) {
        throw new MarketplaceError("CONTENT_RULE_VIOLATION", `${shown(relative)} is reached twice: a link loop`, {
          detail: { reason: "limit", path: shown(relative) || ".", limit: "each directory once (a link loop)" },
        });
      }
      visited.add(key);
      let names: string[];
      try {
        names = await this.options.fs.readdir(this.abs(segments));
      } catch (error) {
        throw folderUnreadable(this.abs(segments), error);
      }
      for (const name of [...names].sort()) {
        if (isSkippedFolderEntry(name)) continue;
        const childSegments = [...segments, name];
        const childRelative = [...relative, name];
        let entry = await this.lstat(childSegments);
        // Gone between readdir and lstat: the folder changed under the read.
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
          if (kind === "plugin" && name !== DESCRIPTOR_FILE) notInstalled.push(entry.kind === "directory" ? `${name}/` : name);
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
