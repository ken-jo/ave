/**
 * One revision of a source's files, as the snapshot builder, the descriptor
 * reads and every kind's staging read them (design §18.4.2): a git commit of
 * the source's bare partial clone ({@link GitTree}), a folder read in place
 * (`FolderTree`), or the copy of a folder package an install plan captured
 * ({@link StagedTree}). The readers are the git ones; only how bytes are
 * reached differs.
 *
 * A source's pin names its revision: a 40-hex commit for a git source,
 * `local-<sha256>` for a folder source (§18.4.3), never the other way round.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { MARKETPLACE_DESCRIPTOR_FILE, type PackageKind } from "../catalog/types.js";
import { MarketplaceError } from "../errors.js";
import type { BareRepo, ExportedFile, ExportLimits } from "../git/repo.js";
import type { GitRemote } from "../git/run-git.js";
import { treeDigest } from "../resolve/tree-digest.js";

export const GIT_COMMIT_RE = /^[0-9a-f]{40}$/u;
export const FOLDER_REVISION_RE = /^local-[0-9a-f]{64}$/u;

/** A folder source's pin (§18.4.3). */
export function isFolderRevision(value: string): boolean {
  return FOLDER_REVISION_RE.test(value);
}

/** Either kind of pin: what a state file, a snapshot name or an install origin may hold. */
export function isSourcePin(value: unknown): value is string {
  return typeof value === "string" && (GIT_COMMIT_RE.test(value) || FOLDER_REVISION_RE.test(value));
}

export interface SourceTree {
  /** Make the files under these paths readable: a partial clone fetches their blobs; a folder has them. */
  ensure(paths: readonly string[]): Promise<void>;
  /** One regular file's bytes, or null when the path holds none; larger than `maxBytes` is CONTENT_RULE_VIOLATION. */
  readFile(path: string, maxBytes: number): Promise<Buffer | null>;
  /** Write every file under `path` ("" is the root) into `dest`, relative to `path`, under `limits`. */
  exportPath(path: string, dest: string, limits: ExportLimits): Promise<ExportedFile[]>;
  /** When this revision was made: a commit's committer time, a folder's read time. */
  revisionTime(): Promise<string>;
  /**
   * The version a package at `path` that declares none gets here (§8.2,
   * §18.4.7): `0.0.0+g<commit12>` at a commit, `0.0.0+t<digest12>` from the
   * tree digest of what a folder package installs.
   */
  synthesizedVersion(path: string, kind: PackageKind): Promise<string>;
}

/** What an install plan reads its package through: the tree at the revision it was bound to. */
export interface RepositoryAccess {
  treeAt(revision: string): SourceTree;
  /** The source is direct: its one package is detected rather than described by an index (§8.1). */
  direct: boolean;
  /** The repository's or folder's own name, which names a direct package at its root that names none. */
  rootName: string;
  signal?: AbortSignal;
}

/**
 * Whether a package of `kind` installs the top-level entry `name` of its
 * folder (§18.4.2): a plugin its built tree (`plugin.json`, `dist/`,
 * `assets/`), an MCP server its `server/` files, every other kind every
 * entry but its descriptor.
 */
export function packageInstalls(kind: PackageKind, name: string, isDirectory: boolean): boolean {
  switch (kind) {
    case "plugin":
      return isDirectory ? name === "dist" || name === "assets" : name === "plugin.json";
    case "mcp":
      return isDirectory && name === "server";
    default:
      return isDirectory || name !== MARKETPLACE_DESCRIPTOR_FILE;
  }
}

/** The last segment of a repository path or folder: what names a direct package at its root. */
export function rootNameOf(location: string): string {
  const segments = location.split(/[\\/]/u).filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

/** One commit of a git source: blobs are fetched from `remote` as the partial clone needs them. */
export class GitTree implements SourceTree {
  constructor(
    readonly repo: BareRepo,
    readonly remote: GitRemote,
    readonly commit: string,
    private readonly signal?: AbortSignal,
  ) {
    if (!GIT_COMMIT_RE.test(commit)) throw new Error(`a git tree needs a 40-hex commit, not ${commit}`);
  }

  ensure(paths: readonly string[]): Promise<void> {
    return this.repo.ensureBlobs(this.remote, this.commit, paths, this.signal);
  }

  readFile(path: string, maxBytes: number): Promise<Buffer | null> {
    return this.repo.readFile(this.commit, path, maxBytes);
  }

  exportPath(path: string, dest: string, limits: ExportLimits): Promise<ExportedFile[]> {
    return this.repo.exportPath(this.remote, this.commit, path, dest, limits, this.signal);
  }

  revisionTime(): Promise<string> {
    return this.repo.commitTime(this.commit);
  }

  async synthesizedVersion(): Promise<string> {
    return `0.0.0+g${this.commit.slice(0, 12)}`;
  }
}

/** Every commit of one git source's clone, read through `remote`. */
export function gitAccess(repo: BareRepo, remote: GitRemote, direct: boolean, signal?: AbortSignal): RepositoryAccess {
  return { treeAt: (commit) => new GitTree(repo, remote, commit, signal), direct, rootName: rootNameOf(remote.url.path), ...(signal ? { signal } : {}) };
}

/**
 * The files a folder install plan captured into its staging directory under
 * `workRoot` (§18.4.2): what was reviewed is what installs, so execution
 * reads this copy and never the folder. The directory is Ave's own and
 * holds only regular files and directories the capture wrote.
 */
export class StagedTree implements SourceTree {
  constructor(
    readonly dir: string,
    readonly revision: string,
    private readonly readAt: string,
    /** The execute bit of every captured file, by `/`-separated path. */
    private readonly executable: ReadonlySet<string>,
  ) {
    if (!isFolderRevision(revision)) throw new Error(`a staged folder tree needs a folder revision, not ${revision}`);
  }

  async ensure(): Promise<void> {}

  async readFile(path: string, maxBytes: number): Promise<Buffer | null> {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(this.dir, ...path.split("/")));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    }
    if (bytes.length > maxBytes) throw new MarketplaceError("CONTENT_RULE_VIOLATION", `${path} is larger than ${maxBytes} bytes`);
    return bytes;
  }

  async exportPath(path: string, dest: string, limits: ExportLimits): Promise<ExportedFile[]> {
    const base = path === "" ? this.dir : join(this.dir, ...path.split("/"));
    const files: ExportedFile[] = [];
    let total = 0;
    const walk = async (dir: string): Promise<void> => {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && dir === base) return;
        throw error;
      }
      for (const name of names.sort()) {
        const at = join(dir, name);
        const info = await lstat(at);
        if (info.isDirectory()) {
          await walk(at);
          continue;
        }
        if (!info.isFile()) throw new Error(`the staged copy holds something other than a file: ${at}`);
        const rel = relative(base, at).split(sep).join("/");
        if (files.length + 1 > limits.maxFiles) throw new MarketplaceError("CONTENT_RULE_VIOLATION", `more than ${limits.maxFiles} files: ${path || "the folder root"}`);
        total += info.size;
        if (total > limits.maxBytes) throw new MarketplaceError("CONTENT_RULE_VIOLATION", `more than ${limits.maxBytes} bytes: ${path || "the folder root"}`);
        const executable = this.executable.has(path === "" ? rel : `${path}/${rel}`);
        const target = join(dest, ...rel.split("/"));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, await readFile(at), { mode: executable ? 0o755 : 0o644, flag: "wx" });
        files.push({ path: rel, size: info.size, executable });
      }
    };
    await walk(base);
    return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async revisionTime(): Promise<string> {
    return this.readAt;
  }

  async synthesizedVersion(path: string, kind: PackageKind): Promise<string> {
    const dest = await mkdtemp(join(tmpdir(), "ave-staged-version-"));
    try {
      const exported = await this.exportPath(path, dest, { maxFiles: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER });
      const files = [];
      for (const file of exported) {
        const [top, ...rest] = file.path.split("/");
        if (!packageInstalls(kind, top!, rest.length > 0)) continue;
        files.push({ path: file.path, data: await readFile(join(dest, ...file.path.split("/"))), executable: file.executable });
      }
      return `0.0.0+t${treeDigest(files).slice(0, 12)}`;
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  }
}

/** A folder plan's access: the captured copy at the plan's revision, and nothing else. */
export function stagedAccess(tree: StagedTree, direct: boolean, rootName: string): RepositoryAccess {
  return {
    treeAt: (revision) => {
      if (revision !== tree.revision) throw new Error(`the captured folder package is at ${tree.revision}, not ${revision}`);
      return tree;
    },
    direct,
    rootName,
  };
}

/** The revision a folder read's files and package digests name (§18.4.3): `local-` + sha256 of the sorted lines. */
export function folderRevision(read: ReadonlyMap<string, string>, packages: ReadonlyMap<string, string>): string {
  const lines = [
    ...[...read].map(([path, digest]) => ({ key: Buffer.from(path, "utf8"), line: `${digest} ${path}\n` })),
    ...[...packages].map(([path, digest]) => ({ key: Buffer.from(`${path}/`, "utf8"), line: `${digest} ${path}/\n` })),
  ].sort((a, b) => Buffer.compare(a.key, b.key));
  const hash = createHash("sha256");
  for (const { line } of lines) hash.update(line, "utf8");
  return `local-${hash.digest("hex")}`;
}
