import { type BigIntStats, chmodSync, closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { replaceStagedFile } from "../../lib/atomic-file.js";

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
/**
 * A folder as a record names it: its `NodeId`, and for a folder held by an anchor, `+<name>:<ino>` of that file. A file system can hand
 * a removed folder's id to the next one made, at once; what then holds that id is not the folder unless the anchor in it is the same
 * file. Each anchor has a second name, its pin, outside every folder a stage can write: while the pin is there the anchor's id is never
 * handed out again, so a copy of the anchor (a new file) or a folder made anew (none) never carries it.
 */
export type FolderId = string;
/** Where an anchor's pin is: a name in a folder the host alone writes, on the anchor's volume. */
export interface Pin { readonly dir: OwnedDir; readonly name: string }
const ANCHORED = /^(\d+:[1-9]\d*)\+([._a-z-]+):([1-9]\d*)$/u;
/** A folder id; with `anchor`, one held by that anchor. */
export const isFolderId = (value: unknown, anchor?: string): value is FolderId => typeof value === "string"
  && (anchor === undefined ? /^\d+:[1-9]\d*$/u.test(value) || ANCHORED.test(value) : ANCHORED.exec(value)?.[2] === anchor);
type OwnedFsReason = "moved" | "not-plain" | "exists" | "changed" | "no-id" | "no-link";
export class OwnedFsError extends Error {
  constructor(readonly reason: OwnedFsReason, message: string) { super(message); this.name = "OwnedFsError"; }
}

const stats = (path: string | Buffer): BigIntStats | undefined => lstatSync(path, { bigint: true, throwIfNoEntry: false });
const idOf = (stat: BigIntStats): NodeId => {
  // A file system that reports no file id gives nothing to hold a folder by.
  if (stat.ino === 0n) throw new OwnedFsError("no-id", "the file system reports no file id");
  return `${stat.dev}:${stat.ino}`;
};
/** `<name>:<ino>` of the anchor in the folder at `path`, on that folder's device: a regular file with exactly two names, itself and its pin. */
function anchorOf(path: string, dev: bigint, name: string): string {
  const stat = stats(join(path, entryName(name)));
  if (stat === undefined || !stat.isFile() || stat.nlink !== 2n || stat.dev !== dev) throw new OwnedFsError("changed", "the folder holds no pinned anchor of its own");
  idOf(stat);
  return `${name}:${stat.ino}`;
}
/** Whether the directory at `path`, as `stat` read it, is the folder `id` names. */
function isRecorded(path: string, stat: BigIntStats, id: FolderId): boolean {
  const anchored = ANCHORED.exec(id);
  if (idOf(stat) !== (anchored?.[1] ?? id)) return false;
  if (anchored === null) return true;
  try { return anchorOf(path, stat.dev, anchored[2] as string) === `${anchored[2]}:${anchored[3]}`; } catch (error) {
    if (error instanceof OwnedFsError) return false;
    throw error;
  }
}
/** What a volume answers when it cannot give a file a second name. */
const NO_LINK = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EMLINK", "ENOSYS", "EINVAL", "EISDIR"]);
/** Whether the volume of `dir` gives a file a second name there at all: a refusal it gives the probe too is the volume's, any other is
 * the pin's own. */
function linksIn(dir: OwnedDir, name: string): boolean {
  const probe = dir.makeTemp(".probe-");
  const file = join(probe.path, "a");
  try {
    closeSync(probe.createFile("a").fd);
    probe.check();
    linkSync(file, join(probe.path, entryName(name)));
    return true;
  } catch (error) {
    if (NO_LINK.has(codeOf(error) ?? "")) return false;
    throw error;
  } finally {
    unlinkEntry(join(probe.path, name));
    unlinkEntry(file);
    rmdirSync(probe.path);
  }
}
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
function unlinkEntry(path: string | Buffer): void {
  try { unlinkSync(path); } catch (error) {
    if (codeOf(error) === "ENOENT") return;
    if (codeOf(error) !== "EPERM" && codeOf(error) !== "EISDIR") throw error;
    rmdirSync(path);
  }
}

export interface SourceRoot { readonly path: string; readonly id: NodeId }

/** One level of a chain: `own` checks that level alone, `check` every level from the root down. */
interface Level { own(): void; check(): void }

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
  /** The folder at `name` only while it is the folder `id` names; undefined when nothing is there, `changed` for anything else. */
  child(name: string, id: FolderId): OwnedDir | undefined;
  /** This folder's id with its anchor file `name`, read with every level still the one held; with `pin`, only while the pin is that
   * same file. `changed` when the folder holds no pinned anchor of its own. */
  mark(name: string, pin?: Pin): FolderId;
  /** `mark`, with the anchor made first when the folder has none and the pin made as its second name when that name is free; `no-link`
   * on a volume that gives a file no second name. */
  anchor(name: string, pin: Pin): FolderId;
  /** Which entry `name` is now, a link as the link itself; undefined when nothing is there. Read with every level still the one held,
   * before and after (`moved` otherwise): a folder that took a held one's place says nothing of what the held one holds. */
  entryId(name: string, kind?: "single-link-file"): NodeId | undefined;
  list(): string[];
  /** A new regular file. With `replace`, a file or link of that name is unlinked first: the name, never what it points at. */
  createFile(name: string, options?: { replace?: boolean }): { fd: number; id: NodeId };
  /** Written beside the name and renamed over it, so a link planted at either name is replaced, not written through. */
  writeFileAtomic(name: string, data: string): void;
  /** A regular file with one name, verified by identity; undefined when nothing is there. */
  readFile(name: string): Buffer | undefined;
  /** Removes one entry and everything below it without following a link. With `expect`, only while the entry is what that id names. */
  remove(name: string, expect?: FolderId): Promise<void>;
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

  child(name: string, id: FolderId): Dir | undefined {
    const path = join(this.path, entryName(name));
    this.check();
    const stat = stats(path);
    if (stat === undefined) return undefined;
    if (!realDir(stat) || !isRecorded(path, stat, id)) throw new OwnedFsError("changed", "the entry is not the folder that was recorded");
    return new Dir(this, path, idOf(stat));
  }

  mark(name: string, pin?: Pin): FolderId {
    this.check();
    const dev = BigInt(this.id.slice(0, this.id.indexOf(":")));
    const mark = anchorOf(this.path, dev, name);
    if (pin !== undefined && pin.dir.entryId(pin.name) !== `${dev}:${mark.slice(name.length + 1)}`) throw new OwnedFsError("changed", "the anchor's pin is not that file");
    this.check();
    return `${this.id}+${mark}`;
  }

  anchor(name: string, pin: Pin): FolderId {
    const path = join(this.path, entryName(name));
    this.check();
    if (stats(path) === undefined) closeSync(this.createFile(name).fd);
    if (pin.dir.entryId(pin.name) === undefined) {
      // Only a file with no other name is pinned: a link would pin what it points at, a second name another file's id.
      const stat = stats(path);
      if (stat === undefined || !stat.isFile() || stat.nlink !== 1n) throw new OwnedFsError("changed", "the anchor is not a file of its own");
      this.check();
      try { linkSync(path, join(pin.dir.path, entryName(pin.name))); } catch (error) {
        if (NO_LINK.has(codeOf(error) ?? "") && !linksIn(pin.dir, pin.name)) throw new OwnedFsError("no-link", "the volume gives a file no second name");
        if (codeOf(error) === "EEXIST") throw new OwnedFsError("exists", "the pin's name is taken");
        throw error;
      }
    }
    return this.mark(name, pin);
  }

  entryId(name: string, kind?: "single-link-file"): NodeId | undefined {
    const path = join(this.path, entryName(name));
    this.check();
    const stat = stats(path);
    this.check();
    if (stat === undefined || (kind === "single-link-file" && (!stat.isFile() || stat.nlink !== 1n))) return undefined;
    return idOf(stat);
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
    replaceStagedFile(`${path}.tmp`, path);
  }

  readFile(name: string): Buffer | undefined {
    const path = join(this.path, entryName(name));
    this.check();
    const stat = stats(path);
    if (stat === undefined) return undefined;
    if (!stat.isFile() || stat.nlink !== 1n) throw new OwnedFsError("not-plain", "the entry is not a regular file with one name");
    const id = idOf(stat);
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (idOf(fstatSync(fd, { bigint: true })) !== id) throw new OwnedFsError("changed", "the file changed while it was opened");
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  async remove(name: string, expect?: FolderId): Promise<void> {
    const path = join(this.path, entryName(name));
    this.check();
    const stat = stats(path);
    if (stat === undefined) return;
    if (expect !== undefined && !isRecorded(path, stat, expect)) throw new OwnedFsError("changed", "the entry is not the one that was recorded");
    await this.removeEntry(Buffer.from(path), stat, { own: () => this.own(), check: () => this.check() });
  }

  /** One removal system call, repeated a few times while the entry is busy; `act` checks before it acts. `level` holds the entry. */
  private async retried(path: Buffer, level: Level, act: () => void): Promise<void> {
    let writable = false;
    for (let attempt = 0; ; attempt += 1) {
      try { act(); return; } catch (error) {
        const code = codeOf(error);
        if (code === "ENOENT") return;
        const stat = code === "EPERM" && !writable ? stats(path) : undefined;
        if (stat?.isFile() === true && stat.nlink === 1n) {
          // A read-only file. One with a second name is left as it is: the mode is the other name's too.
          writable = true;
          level.own();
          chmodSync(path, 0o666);
          continue;
        }
        if ((code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") || attempt >= 3) throw error;
        await delay(100 * (attempt + 1));
        level.check();
      }
    }
  }

  /** Below a held folder every name is taken as the bytes it was listed as: one an agent wrote need not be text, and read as text it
   * would name another entry, or none. */
  private async removeEntry(path: Buffer, stat: BigIntStats, parent: Level): Promise<void> {
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      await this.retried(path, parent, () => {
        parent.own();
        if (stat.isSymbolicLink()) unlinkEntry(path); else unlinkSync(path);
      });
      return;
    }
    const id = idOf(stat);
    parent.check();
    const now = stats(path);
    if (now === undefined) return;
    if (!realDir(now) || idOf(now) !== id) throw new OwnedFsError("changed", "the entry is not the folder that was recorded");
    const own = (): void => {
      const held = stats(path);
      if (!realDir(held) || idOf(held) !== id) throw new OwnedFsError("moved", "a held folder is no longer the one that was held");
    };
    const level: Level = { own, check: () => { parent.check(); own(); } };
    for (const entry of readdirSync(path, { encoding: "buffer" })) {
      const at = Buffer.concat([path, Buffer.from(sep), entry]);
      const found = stats(at);
      if (found === undefined) continue;
      // On Windows a folder name that ends in a dot or a space would be another entry.
      if (found.isDirectory() && process.platform === "win32" && (entry.at(-1) === 0x2e || entry.at(-1) === 0x20)) throw new OwnedFsError("not-plain", "not a single name");
      own();
      await this.removeEntry(at, found, level);
    }
    await this.retried(path, parent, () => {
      level.check();
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
