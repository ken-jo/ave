/**
 * Every filesystem call a folder source makes (design §18.4.5): the stage-4
 * walk, the folder reader and the network classification of a drive letter
 * go through this interface and nothing else, so the tests replace it with a
 * recording fake and can prove which paths were touched, and when.
 *
 * Nothing here follows a link on purpose: `lstat` and `readlink` describe a
 * link without touching its target, `readdir` lists a directory the caller
 * has already checked, and `open` refuses a final component that is a link
 * where the OS can (`O_NOFOLLOW` on macOS and Linux). On Windows Node's open
 * follows reparse points; §18.4.5 states that residual.
 */
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, readlink, type FileHandle } from "node:fs/promises";

type FolderEntryKind = "file" | "directory" | "link" | "special";

/** What `lstat` or `fstat` reports, in the terms the reader judges. */
export interface FolderStat {
  kind: FolderEntryKind;
  /** Volume and file identity; zero where the filesystem reports none (some network filesystems). */
  dev: bigint;
  ino: bigint;
  size: number;
  /** An execute bit is set (macOS and Linux; never on Windows). */
  executable: boolean;
}

/** An open file. Opaque to the reader: it only hands it back to `fstat`, `read` and `close`. */
export interface FolderFileHandle {
  readonly path: string;
}

export interface FolderFs {
  lstat(path: string): Promise<FolderStat>;
  /** The link's own text, never resolved. */
  readlink(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  /** Open for reading; refuses a final component that is a link where the OS can. */
  open(path: string): Promise<FolderFileHandle>;
  fstat(handle: FolderFileHandle): Promise<FolderStat>;
  /** The file's bytes, at most `maxBytes + 1` of them, so a caller sees a file larger than its limit. */
  read(handle: FolderFileHandle, maxBytes: number): Promise<Buffer>;
  close(handle: FolderFileHandle): Promise<void>;
  /**
   * The current MS-DOS device mapping of a drive letter (`"Z:"` →
   * `\Device\Mup\…`), read without opening anything on the drive
   * (§18.4.1 stage 2), or null when the OS has no mapping for it. Windows
   * only; it throws elsewhere, and when the lookup itself cannot run or
   * answers outside its protocol: that is a broken install, not a drive.
   */
  queryDosDevice(drive: string): Promise<string | null>;
}

function kindOf(stats: { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }): FolderEntryKind {
  if (stats.isSymbolicLink()) return "link";
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "special";
}

interface NodeHandle extends FolderFileHandle {
  readonly file: FileHandle;
}

function nodeHandle(handle: FolderFileHandle): FileHandle {
  const file = (handle as Partial<NodeHandle>).file;
  if (!file) throw new TypeError(`${handle.path} was not opened by this filesystem`);
  return file;
}

/** `O_NOFOLLOW` where the platform has it; Windows has none, and Node's open there follows reparse points. */
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const READ_CHUNK = 64 * 1024;

/**
 * The real filesystem. `queryDosDevice` is the Windows helper
 * (`native/windows-path-kind/`), supplied by the composition root.
 */
export function createNodeFolderFs(options: { platform: NodeJS.Platform; queryDosDevice: (drive: string) => Promise<string | null> }): FolderFs {
  const executable = (mode: bigint) => options.platform !== "win32" && (mode & 0o111n) !== 0n;
  const stat = (info: BigIntStats): FolderStat => ({
    kind: kindOf(info),
    dev: info.dev,
    ino: info.ino,
    size: Number(info.size),
    executable: executable(info.mode),
  });
  return {
    async lstat(path) {
      return stat(await lstat(path, { bigint: true }));
    },
    readlink: (path) => readlink(path),
    readdir: (path) => readdir(path),
    async open(path) {
      const file = await open(path, constants.O_RDONLY | NO_FOLLOW);
      const handle: NodeHandle = { path, file };
      return handle;
    },
    async fstat(handle) {
      return stat(await nodeHandle(handle).stat({ bigint: true }));
    },
    async read(handle, maxBytes) {
      const file = nodeHandle(handle);
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK, maxBytes + 1 - total));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        chunks.push(buffer.subarray(0, bytesRead));
        total += bytesRead;
        if (total > maxBytes) break;
      }
      return Buffer.concat(chunks, total);
    },
    async close(handle) {
      await nodeHandle(handle).close();
    },
    queryDosDevice: (drive) => options.queryDosDevice(drive),
  };
}
