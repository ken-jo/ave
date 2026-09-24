/**
 * Operations on one source's bare partial clone (design §2, §7.3, §9.3).
 *
 * The repository holds full commit history and trees but no blobs
 * (`--filter=blob:none`): ancestry checks never lack objects, and file
 * contents are fetched only for the paths the app actually reads. Refs under
 * `refs/ave/` name the fetched commits; automatic gc and maintenance are
 * off for every call (run-git.ts), so a commit an install still references
 * stays present after the pin moves on.
 *
 * Only the commands the design lists are used: `ls-remote`, `init --bare`,
 * `fetch`, `rev-parse`, `merge-base --is-ancestor`, `cat-file`, `ls-tree`,
 * `rev-list` and `archive`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Parser, type ReadEntry } from "tar";
import { canonicalZipEntryPathIdentity, sanitizeZipEntryPath } from "../../plugins/zip-entry-path.js";
import { MarketplaceError } from "../errors.js";
import { GitCommandError, type GitRemote, type GitRunner, GIT_TIMEOUTS_MS } from "./run-git.js";

const OID = /^[0-9a-f]{40}$/u;
/** Upper bound on object ids requested in one fetch, to keep the command line bounded. */
const MAX_OIDS_PER_FETCH = 256;

export interface TreeEntry {
  mode: string;
  type: "blob" | "tree" | "commit";
  oid: string;
  path: string;
}

export interface ExportLimits {
  maxFiles: number;
  maxBytes: number;
}

export interface ExportedFile {
  /** Path relative to the exported directory, `/`-separated. */
  path: string;
  size: number;
  executable: boolean;
}

function assertCommitId(value: string, what: string): void {
  if (!OID.test(value)) throw new Error(`${what} is not a 40-hex commit id: ${value}`);
}

/** Refuse a repository path before it reaches git as a pathspec. */
export function assertRepoPath(path: string): void {
  if (
    path === ""
    || path.startsWith("/")
    || path.endsWith("/")
    || path.includes("\\")
    || /[\u0000-\u001f\u007f*?[\]:]/u.test(path)
    || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`invalid repository path: ${JSON.stringify(path)}`);
  }
}

export class BareRepo {
  constructor(
    private readonly runner: GitRunner,
    readonly dir: string,
  ) {}

  static async init(runner: GitRunner, dir: string): Promise<BareRepo> {
    await mkdir(dirname(dir), { recursive: true });
    await runner.run(["init", "--bare", "--quiet", dir], { timeoutMs: GIT_TIMEOUTS_MS.local });
    return new BareRepo(runner, dir);
  }

  /** `refs → oid` advertised by the remote (probe before add, §7.2). */
  async lsRemote(remote: GitRemote, ref?: string, signal?: AbortSignal): Promise<Map<string, string>> {
    const args = ["ls-remote", "--", remote.url.url, ...(ref ? [ref] : ["HEAD"])];
    const result = await this.runner.run(args, { remote, timeoutMs: GIT_TIMEOUTS_MS.lsRemote, ...(signal ? { signal } : {}) });
    const refs = new Map<string, string>();
    for (const line of result.stdout.toString("utf8").split("\n")) {
      const [oid, name] = line.split("\t");
      if (oid && name && OID.test(oid)) refs.set(name, oid);
    }
    return refs;
  }

  /**
   * Fetch `ref` (default: the remote's HEAD) with full commit history and no
   * blobs into `refs/ave/<localRef>`, and return the fetched commit.
   */
  async fetchRef(remote: GitRemote, ref: string | undefined, localRef: string, signal?: AbortSignal): Promise<string> {
    const source = ref ?? "HEAD";
    if (source.startsWith("-") || /[\s:^~?*[\\]/u.test(source)) {
      throw new MarketplaceError("SOURCE_REF_NOT_FOUND", `invalid ref: ${source}`);
    }
    const target = `refs/ave/${localRef}`;
    await this.runner.run(
      ["fetch", "--filter=blob:none", "--no-tags", "--quiet", "--", remote.url.url, `+${source}:${target}`],
      { gitDir: this.dir, remote, timeoutMs: GIT_TIMEOUTS_MS.fetch, ...(signal ? { signal } : {}) },
    );
    return this.resolve(target);
  }

  async resolve(rev: string): Promise<string> {
    const result = await this.runner.run(["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`], {
      gitDir: this.dir,
      timeoutMs: GIT_TIMEOUTS_MS.local,
    });
    const oid = result.stdout.toString("utf8").trim();
    assertCommitId(oid, rev);
    return oid;
  }

  /** Is `commit` a commit object in this repository? */
  async hasCommit(commit: string): Promise<boolean> {
    assertCommitId(commit, "commit");
    try {
      const result = await this.runner.run(["cat-file", "-t", commit], { gitDir: this.dir, timeoutMs: GIT_TIMEOUTS_MS.local });
      return result.stdout.toString("utf8").trim() === "commit";
    } catch (error) {
      if (error instanceof GitCommandError) return false;
      throw error;
    }
  }

  /** Committer time of `commit`, ISO-8601. */
  async commitTime(commit: string): Promise<string> {
    assertCommitId(commit, "commit");
    const result = await this.runner.run(["show", "-s", "--format=%cI", commit], { gitDir: this.dir, timeoutMs: GIT_TIMEOUTS_MS.local });
    return new Date(result.stdout.toString("utf8").trim()).toISOString();
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    assertCommitId(ancestor, "ancestor");
    assertCommitId(descendant, "descendant");
    try {
      await this.runner.run(["merge-base", "--is-ancestor", ancestor, descendant], {
        gitDir: this.dir,
        timeoutMs: GIT_TIMEOUTS_MS.local,
      });
      return true;
    } catch (error) {
      if (error instanceof GitCommandError && error.exitCode === 1) return false;
      throw error;
    }
  }

  /** Entries under `path` at `commit` (optionally recursive); `path: null` lists the root. */
  async lsTree(commit: string, path: string | null, recursive: boolean): Promise<TreeEntry[]> {
    assertCommitId(commit, "commit");
    if (path !== null) assertRepoPath(path);
    const args = ["ls-tree", "-z", "--full-tree", ...(recursive ? ["-r"] : []), commit, ...(path !== null ? ["--", path] : [])];
    const result = await this.runner.run(args, { gitDir: this.dir, timeoutMs: GIT_TIMEOUTS_MS.local });
    const entries: TreeEntry[] = [];
    for (const record of result.stdout.toString("utf8").split("\0")) {
      if (!record) continue;
      const tab = record.indexOf("\t");
      const [mode, type, oid] = record.slice(0, tab).split(" ");
      if (!mode || !oid || (type !== "blob" && type !== "tree" && type !== "commit")) {
        throw new Error(`unexpected ls-tree record: ${record}`);
      }
      entries.push({ mode, type, oid, path: record.slice(tab + 1) });
    }
    return entries;
  }

  /**
   * Make every blob under `paths` at `commit` present locally with one fetch
   * per batch of missing object ids (the request partial-clone lazy fetching
   * issues), then prove none is missing. `--no-walk` limits the listing to
   * that commit's tree (otherwise every historical version of the paths is
   * listed), and `--sparse` keeps the commit even when it did not change the
   * paths (otherwise history simplification drops it and nothing is listed).
   */
  async ensureBlobs(remote: GitRemote, commit: string, paths: readonly string[], signal?: AbortSignal): Promise<void> {
    assertCommitId(commit, "commit");
    for (const path of paths) assertRepoPath(path);
    const missing = await this.missingObjects(commit, paths);
    for (let index = 0; index < missing.length; index += MAX_OIDS_PER_FETCH) {
      await this.runner.run(
        ["fetch", "--filter=blob:none", "--no-tags", "--quiet", "--", remote.url.url, ...missing.slice(index, index + MAX_OIDS_PER_FETCH)],
        { gitDir: this.dir, remote, timeoutMs: GIT_TIMEOUTS_MS.fetch, ...(signal ? { signal } : {}) },
      );
    }
    if (missing.length > 0 && (await this.missingObjects(commit, paths)).length > 0) {
      throw new MarketplaceError("SOURCE_UNREACHABLE", `the remote did not supply every object under ${paths.join(", ")} at ${commit}`);
    }
  }

  private async missingObjects(commit: string, paths: readonly string[]): Promise<string[]> {
    const result = await this.runner.run(
      ["rev-list", "--objects", "--missing=print", "--no-walk", "--sparse", commit, "--", ...paths],
      { gitDir: this.dir, timeoutMs: GIT_TIMEOUTS_MS.local },
    );
    return result.stdout
      .toString("utf8")
      .split("\n")
      .filter((line) => line.startsWith("?"))
      .map((line) => line.slice(1).trim())
      .filter((oid) => OID.test(oid));
  }

  /** Contents of one file at `commit`, or null when the path is absent. Blobs must be present (see ensureBlobs). */
  async readFile(commit: string, path: string, maxBytes: number): Promise<Buffer | null> {
    const [entry] = await this.lsTree(commit, path, false);
    if (!entry || entry.path !== path) return null;
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
      throw new MarketplaceError("CONTENT_RULE_VIOLATION", `${path} is not a regular file at ${commit}`);
    }
    const size = await this.runner.run(["cat-file", "-s", entry.oid], { gitDir: this.dir, timeoutMs: GIT_TIMEOUTS_MS.local });
    if (Number(size.stdout.toString("utf8").trim()) > maxBytes) {
      throw new MarketplaceError("CONTENT_RULE_VIOLATION", `${path} is larger than ${maxBytes} bytes at ${commit}`);
    }
    const result = await this.runner.run(["cat-file", "blob", entry.oid], {
      gitDir: this.dir,
      timeoutMs: GIT_TIMEOUTS_MS.local,
      maxStdoutBytes: maxBytes,
    });
    return result.stdout;
  }

  /**
   * Write the tree at `path` in `commit` into `dest` (§9.3): blobs are made
   * present first, then `git archive` of that subtree streams a tar that is
   * checked entry by entry. Only regular files and directories are accepted; a symlink,
   * submodule or path that is not portable stops the export. Files land
   * relative to `path`; `""` exports the whole tree (a direct source whose
   * package is the repository root).
   */
  async exportPath(
    remote: GitRemote,
    commit: string,
    path: string,
    dest: string,
    limits: ExportLimits,
    signal?: AbortSignal,
  ): Promise<ExportedFile[]> {
    // A gitlink (submodule) becomes an empty directory in the tar and a
    // symlink a link entry; the tree says what each entry really is, and it is
    // present without blobs, so check it before fetching anything.
    const root = path === "";
    let fileCount = 0;
    for (const entry of await this.lsTree(commit, root ? null : path, true)) {
      if (entry.type === "commit") {
        throw new MarketplaceError("CONTENT_RULE_VIOLATION", `submodules are not allowed: ${entry.path}`);
      }
      if (entry.type === "blob" && entry.mode !== "100644" && entry.mode !== "100755") {
        throw new MarketplaceError("CONTENT_RULE_VIOLATION", `only regular files are allowed (mode ${entry.mode}): ${entry.path}`);
      }
      if (entry.type === "blob") fileCount += 1;
    }
    // Refuse an oversized tree before its blobs are downloaded; the byte limit
    // needs the blobs and is checked while the archive streams.
    if (fileCount > limits.maxFiles) {
      throw new MarketplaceError("CONTENT_RULE_VIOLATION", `more than ${limits.maxFiles} files: ${path || "the repository root"}`);
    }
    await this.ensureBlobs(remote, commit, root ? [] : [path], signal);
    // The prefix only tells archive entries from anything else in the stream.
    const prefix = "export/";
    const files = new Map<string, { data: Buffer[]; size: number; executable: boolean }>();
    const identities = new Set<string>();
    let totalBytes = 0;
    let failure: Error | null = null;
    const fail = (error: Error) => {
      failure ??= error;
    };

    const parser = new Parser({ strict: true });
    parser.on("warn", (code: string, message: string) => fail(new MarketplaceError("CONTENT_RULE_VIOLATION", `archive: ${code} ${message}`)));
    parser.on("error", (error: Error) => fail(error));
    parser.on("entry", (entry: ReadEntry) => {
      const rejectEntry = (reason: string) => {
        fail(new MarketplaceError("CONTENT_RULE_VIOLATION", `${reason}: ${entry.path}`));
        entry.resume();
      };
      if (entry.type === "Directory") {
        entry.resume();
        return;
      }
      if (entry.type !== "File") return rejectEntry(`unsupported entry type ${entry.type}`);
      if (!entry.path.startsWith(prefix)) return rejectEntry("entry outside the exported path");
      let relative: string | null;
      try {
        relative = sanitizeZipEntryPath(path || "export", entry.path.slice(prefix.length));
      } catch (error) {
        return rejectEntry((error as Error).message);
      }
      if (!relative) return rejectEntry("empty entry path");
      const identity = canonicalZipEntryPathIdentity(relative);
      if (identities.has(identity)) return rejectEntry("entry path collides with another on a case-insensitive filesystem");
      identities.add(identity);
      if (files.size + 1 > limits.maxFiles) return rejectEntry(`more than ${limits.maxFiles} files`);
      totalBytes += entry.size;
      if (totalBytes > limits.maxBytes) return rejectEntry(`more than ${limits.maxBytes} bytes`);
      const record = { data: [] as Buffer[], size: entry.size, executable: ((entry.mode ?? 0) & 0o111) !== 0 };
      files.set(relative, record);
      entry.on("data", (chunk: Buffer) => record.data.push(chunk));
    });
    const parsed = new Promise<void>((resolve) => parser.on("end", () => resolve()));

    // The tree-ish form reads only this subtree; `archive <commit> -- <path>`
    // also reads blobs outside the path, which a partial clone does not have.
    await this.runner.run(["archive", "--format=tar", `--prefix=${prefix}`, root ? `${commit}^{tree}` : `${commit}:${path}`], {
      gitDir: this.dir,
      timeoutMs: GIT_TIMEOUTS_MS.export,
      ...(signal ? { signal } : {}),
      onStdout: (chunk) => {
        if (!failure) parser.write(chunk);
      },
    });
    parser.end();
    await parsed;
    if (failure) throw failure;

    const exported: ExportedFile[] = [];
    for (const [relative, record] of files) {
      const target = join(dest, ...relative.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.concat(record.data), { mode: record.executable ? 0o755 : 0o644, flag: "wx" });
      exported.push({ path: relative, size: record.size, executable: record.executable });
    }
    return exported.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
}
