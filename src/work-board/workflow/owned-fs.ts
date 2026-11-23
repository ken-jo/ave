import { type BigIntStats, chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

/**
 * Every host change under a run folder goes through here. A folder is held by its device and file id, made one component at a time, and
 * each level from the chain's root down is compared with its held id right before every system call that changes something.
 *
 * Each check and the operation it guards are separate system calls on a path. Another process of the same user can swap a level between
 * them, and nothing here prevents that: it is the accepted same-user final-operation window (owner decision 2026-11-21), since whoever
 * wins it already acts as that user. A write git makes is checked right before and after the git call and lies in the same window
 * while git runs; that includes git's own rollback of a failed `worktree add`, which removes by path the folder it was given.
 */

/** `<dev>:<ino>` of what a path names, a link never followed. */
export type NodeId = string;
type OwnedFsReason = "moved" | "not-plain" | "exists" | "changed" | "no-id";
export class OwnedFsError extends Error {
  constructor(readonly reason: OwnedFsReason, message: string) { super(message); this.name = "OwnedFsError"; }
}

const stats = (path: string): BigIntStats | undefined => lstatSync(path, { bigint: true, throwIfNoEntry: false });
const idOf = (stat: BigIntStats): NodeId => {
  // A file system that reports no file id gives nothing to hold a folder by.
  if (stat.ino === 0n) throw new OwnedFsError("no-id", "the file system reports no file id");
  return `${stat.dev}:${stat.ino}`;
};
/** A junction or any other link is no real directory. */
const realDir = (stat: BigIntStats | undefined): stat is BigIntStats => stat?.isDirectory() === true && !stat.isSymbolicLink();
const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;
const delay = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));

export function nodeIdOf(path: string): NodeId | undefined {
  const stat = stats(path);
  return stat === undefined ? undefined : idOf(stat);
}

/** Which directory a path is, when it is a real one; a link, a file or a path that cannot be read is none. With "known", a path that
 * cannot be read is a throw instead: it may be any directory. */
export function realDirId(path: string, unread?: "known"): NodeId | undefined {
  try {
    const stat = stats(path);
    return realDir(stat) ? idOf(stat) : undefined;
  } catch (error) {
    if (unread === "known") throw error;
    return undefined;
  }
}

/** Whether `inner` is `outer` or lies beneath it, as both really are on disk. */
export function realWithin(outer: string, inner: string): boolean {
  const real = (value: string): string => process.platform === "win32" ? realpathSync.native(value).toLowerCase() : realpathSync.native(value);
  const rel = relative(real(outer), real(inner));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** One name inside a held folder: never a path, and on Windows never one that ends in a dot or a space, which is dropped there: such
 * a name would be another entry, or the folder itself. */
function entryName(name: string): string {
  if (name === "" || name === "." || name === ".." || /[\\/\0]/u.test(name) || (process.platform === "win32" && /[. ]$/u.test(name))) throw new OwnedFsError("not-plain", "not a single name");
  return name;
}

/** Removes a link itself, whatever it points at. */
function unlinkEntry(path: string): void {
  try { unlinkSync(path); } catch (error) {
    if (codeOf(error) === "ENOENT") return;
    if (codeOf(error) !== "EPERM" && codeOf(error) !== "EISDIR") throw error;
    rmdirSync(path);
  }
}

export interface SourceRoot { readonly path: string; readonly id: NodeId }

/**
 * Opens a regular file for reading under a root that must still be the real directory with `id`. No parent is a link, and the handle is
 * the file that was looked at: its id equals the one its name had.
 */
export async function openSource(root: SourceRoot, segments: readonly string[]): Promise<FileHandle> {
  const top = stats(root.path);
  if (!realDir(top)) throw new OwnedFsError("not-plain", "the source folder is not a real directory");
  if (idOf(top) !== root.id) throw new OwnedFsError("changed", "the source folder is not the one that was held");
  let path = root.path;
  for (const segment of segments.slice(0, -1)) {
    path = join(path, entryName(segment));
    if (!realDir(stats(path))) throw new OwnedFsError("not-plain", "a source parent is not a real directory");
  }
  path = join(path, entryName(segments.at(-1) ?? ""));
  const seen = stats(path);
  if (seen === undefined || !seen.isFile()) throw new OwnedFsError("not-plain", "the source is not a regular file");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || idOf(opened) !== idOf(seen)) throw new OwnedFsError("changed", "the source changed while it was opened");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export interface OwnedDir {
  readonly path: string;
  readonly id: NodeId;
  /** Every level from the chain's root down is still the real directory that was held; throws `moved` otherwise. */
  check(): void;
  /** A new folder, which must not be there yet (`exists`). */
  make(name: string): OwnedDir;
  makeTemp(prefix: string): OwnedDir;
  /** The folder at `name` as it is now; undefined when nothing is there, `not-plain` for anything but a real directory. */
  existing(name: string): OwnedDir | undefined;
  /** Whether the entry at `name` is a regular file, itself and through no link: it then holds no entry of its own. Read with every
   * level still the one held, before and after (`moved` otherwise); an entry that cannot be read throws as well. */
  isFile(name: string): boolean;
  ensure(name: string): OwnedDir;
  ensurePath(segments: readonly string[]): OwnedDir;
  walk(segments: readonly string[]): OwnedDir | undefined;
  /** The folder at `name` only while it has `id`; undefined when nothing is there, `changed` for anything else. */
  child(name: string, id: NodeId): OwnedDir | undefined;
  /** Which entry `name` is now, a link as the link itself; undefined when nothing is there. Read with every level still the one held,
   * before and after (`moved` otherwise): a folder that took a held one's place says nothing of what the held one holds. */
  entryId(name: string): NodeId | undefined;
  list(): string[];
  /** A new regular file. With `replace`, a file or link of that name is unlinked first: the name, never what it points at. */
  createFile(name: string, options?: { replace?: boolean }): { fd: number; id: NodeId };
  /** Written beside the name and renamed over it, so a link planted at either name is replaced, not written through. */
  writeFileAtomic(name: string, data: string): void;
  /** A regular file with one name; undefined when nothing is there, `not-plain` for a link or a file with a second name. */
  readFile(name: string): Buffer | undefined;
  /** Removes one entry and everything below it without following a link. With `expect`, only while the entry has that id. */
  remove(name: string, expect?: NodeId): Promise<void>;
  removeSelfIfEmpty(): boolean;
}

class Dir implements OwnedDir {
  constructor(private readonly parent: Dir | undefined, readonly path: string, readonly id: NodeId) {}

  /** This level alone. */
  private own(): void {
    const stat = stats(this.path);
    if (!realDir(stat) || idOf(stat) !== this.id) throw new OwnedFsError("moved", "a held folder is no longer the one that was held");
  }

  check(): void {
    this.parent?.check();
    this.own();
  }

  private made(path: string): Dir {
    const stat = stats(path);
    if (!realDir(stat)) throw new OwnedFsError("not-plain", "what was made is not a real directory");
    const dir = new Dir(this, path, idOf(stat));
    this.check();
    return dir;
  }

  make(name: string): OwnedDir {
    const path = join(this.path, entryName(name));
    this.check();
    try { mkdirSync(path, { recursive: false, mode: 0o700 }); } catch (error) {
      if (codeOf(error) === "EEXIST") throw new OwnedFsError("exists", "the name is taken");
      throw error;
    }
    return this.made(path);
  }

  makeTemp(prefix: string): OwnedDir {
    entryName(prefix);
    this.check();
    return this.made(mkdtempSync(join(this.path, prefix)));
  }

  existing(name: string): OwnedDir | undefined {
    const path = join(this.path, entryName(name));
    this.check();
    const stat = stats(path);
    if (stat === undefined) return undefined;
    if (!realDir(stat)) throw new OwnedFsError("not-plain", "the entry is not a real directory");
    return new Dir(this, path, idOf(stat));
  }

  isFile(name: string): boolean {
    const path = join(this.path, entryName(name));
    this.check();
    const stat = stats(path);
    this.check();
    return stat?.isFile() === true;
  }

  ensure(name: string): OwnedDir {
    const found = this.existing(name);
    if (found !== undefined) return found;
    try { return this.make(name); } catch (error) {
      const raced = error instanceof OwnedFsError && error.reason === "exists" ? this.existing(name) : undefined;
      if (raced === undefined) throw error;
      return raced;
    }
  }

  ensurePath(segments: readonly string[]): OwnedDir {
    return segments.reduce<OwnedDir>((dir, segment) => dir.ensure(segment), this);
  }

  walk(segments: readonly string[]): OwnedDir | undefined {
    return segments.reduce<OwnedDir | undefined>((dir, segment) => dir?.existing(segment), this);
  }

  child(name: string, id: NodeId): Dir | undefined {
    const path = join(this.path, entryName(name));
    this.check();
    const stat = stats(path);
    if (stat === undefined) return undefined;
    if (!realDir(stat) || idOf(stat) !== id) throw new OwnedFsError("changed", "the entry is not the folder that was recorded");
    return new Dir(this, path, id);
  }

  entryId(name: string): NodeId | undefined {
    const path = join(this.path, entryName(name));
    this.check();
    const id = nodeIdOf(path);
    this.check();
    return id;
  }

  list(): string[] {
    this.check();
    return readdirSync(this.path);
  }

  createFile(name: string, options: { replace?: boolean } = {}): { fd: number; id: NodeId } {
    const path = join(this.path, entryName(name));
    const stat = stats(path);
    if (stat !== undefined) {
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new OwnedFsError("not-plain", "the name holds something that is no file");
      if (options.replace !== true) throw new OwnedFsError("exists", "the name is taken");
      this.check();
      unlinkEntry(path);
    }
    this.check();
    // Exclusive creation follows no link.
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      return { fd, id: idOf(fstatSync(fd, { bigint: true })) };
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  writeFileAtomic(name: string, data: string): void {
    const path = join(this.path, entryName(name));
    const { fd, id } = this.createFile(`${name}.tmp`, { replace: true });
    try { writeFileSync(fd, data); } finally { closeSync(fd); }
    this.check();
    const written = stats(`${path}.tmp`);
    if (written === undefined || !written.isFile() || written.nlink !== 1n || idOf(written) !== id) throw new OwnedFsError("changed", "the file was replaced while it was written");
    renameSync(`${path}.tmp`, path);
  }

  readFile(name: string): Buffer | undefined {
    const path = join(this.path, entryName(name));
    this.check();
    const stat = stats(path);
    if (stat === undefined) return undefined;
    if (!stat.isFile() || stat.nlink !== 1n) throw new OwnedFsError("not-plain", "the entry is not a regular file with one name");
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (idOf(fstatSync(fd, { bigint: true })) !== idOf(stat)) throw new OwnedFsError("changed", "the file changed while it was opened");
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  async remove(name: string, expect?: NodeId): Promise<void> {
    const path = join(this.path, entryName(name));
    this.check();
    const stat = stats(path);
    if (stat === undefined) return;
    if (expect !== undefined && idOf(stat) !== expect) throw new OwnedFsError("changed", "the entry is not the one that was recorded");
    await this.removeEntry(name, stat);
  }

  /** One removal system call, repeated a few times while the entry is busy; `act` checks before it acts. */
  private async retried(path: string, act: () => void): Promise<void> {
    let writable = false;
    for (let attempt = 0; ; attempt += 1) {
      try { act(); return; } catch (error) {
        const code = codeOf(error);
        if (code === "ENOENT") return;
        const stat = code === "EPERM" && !writable ? stats(path) : undefined;
        if (stat?.isFile() === true && stat.nlink === 1n) {
          // A read-only file. One with a second name is left as it is: the mode is the other name's too.
          writable = true;
          this.own();
          chmodSync(path, 0o666);
          continue;
        }
        if ((code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") || attempt >= 3) throw error;
        await delay(100 * (attempt + 1));
        this.check();
      }
    }
  }

  private async removeEntry(name: string, stat: BigIntStats): Promise<void> {
    const path = join(this.path, name);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      await this.retried(path, () => {
        this.own();
        if (stat.isSymbolicLink()) unlinkEntry(path); else unlinkSync(path);
      });
      return;
    }
    const sub = this.child(name, idOf(stat));
    if (sub === undefined) return;
    for (const entry of readdirSync(sub.path)) {
      const found = stats(join(sub.path, entry));
      if (found === undefined) continue;
      sub.own();
      await sub.removeEntry(entry, found);
    }
    await this.retried(path, () => {
      sub.check();
      rmdirSync(path);
    });
  }

  removeSelfIfEmpty(): boolean {
    this.check();
    if (readdirSync(this.path).length > 0) return false;
    rmdirSync(this.path);
    return true;
  }
}

/** The root of a chain: a real directory now, and the one with `id` when that is given. */
export function holdDir(path: string, id?: NodeId): OwnedDir {
  const stat = stats(path);
  if (!realDir(stat)) throw new OwnedFsError("not-plain", "not a real directory");
  if (id !== undefined && idOf(stat) !== id) throw new OwnedFsError("changed", "not the directory that was recorded");
  return new Dir(undefined, path, idOf(stat));
}
