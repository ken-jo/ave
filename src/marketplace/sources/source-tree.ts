/** Readers share one revision interface across git commits, live folders and staged captures. */
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

export function isFolderRevision(value: string): boolean {
  return FOLDER_REVISION_RE.test(value);
}

export function isSourcePin(value: unknown): value is string {
  return typeof value === "string" && (GIT_COMMIT_RE.test(value) || FOLDER_REVISION_RE.test(value));
}

export interface SourceTree {
  /** Partial clones fetch blobs; folder sources already have readable files. */
  ensure(paths: readonly string[]): Promise<void>;
  /** Missing regular files return null; oversized reads fail content rules. */
  readFile(path: string, maxBytes: number): Promise<Buffer | null>;
  exportPath(path: string, dest: string, limits: ExportLimits): Promise<ExportedFile[]>;
  revisionTime(): Promise<string>;
  /** Missing versions derive from commit or payload digests so tree changes become updates. */
  synthesizedVersion(path: string, kind: PackageKind): Promise<string>;
}

export interface RepositoryAccess {
  treeAt(revision: string): SourceTree;
  direct: boolean;
  rootName: string;
  signal?: AbortSignal;
}

/** Plugins install built trees, MCP installs server files, other kinds exclude only the descriptor. */
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

export function rootNameOf(location: string): string {
  const segments = location.split(/[\\/]/u).filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

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

export function gitAccess(repo: BareRepo, remote: GitRemote, direct: boolean, signal?: AbortSignal): RepositoryAccess {
  return { treeAt: (commit) => new GitTree(repo, remote, commit, signal), direct, rootName: rootNameOf(remote.url.path), ...(signal ? { signal } : {}) };
}

/** Folder execution reads only the reviewed capture, never the live source again. */
export class StagedTree implements SourceTree {
  constructor(
    readonly dir: string,
    readonly revision: string,
    private readonly readAt: string,
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

/** Folder revisions hash sorted file and package digest lines under the local- prefix. */
export function folderRevision(read: ReadonlyMap<string, string>, packages: ReadonlyMap<string, string>): string {
  const lines = [
    ...[...read].map(([path, digest]) => ({ key: Buffer.from(path, "utf8"), line: `${digest} ${path}\n` })),
    ...[...packages].map(([path, digest]) => ({ key: Buffer.from(`${path}/`, "utf8"), line: `${digest} ${path}/\n` })),
  ].sort((a, b) => Buffer.compare(a.key, b.key));
  const hash = createHash("sha256");
  for (const { line } of lines) hash.update(line, "utf8");
  return `local-${hash.digest("hex")}`;
}
