/** All folder access uses this interface so reads can be fenced before touching paths.
 * Unix opens reject final symlinks; Windows follows reparse points, leaving a concurrent-swap risk. */
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, readlink, type FileHandle } from "node:fs/promises";

type FolderEntryKind = "file" | "directory" | "link" | "special";

export interface FolderStat {
  kind: FolderEntryKind;
  /** Volume and file identity; zero where the filesystem reports none (some network filesystems). */
  dev: bigint;
  ino: bigint;
  size: number;
  /** An execute bit is set (macOS and Linux; never on Windows). */
  executable: boolean;
}

export interface FolderFileHandle {
  readonly path: string;
}

export interface FolderFs {
  lstat(path: string): Promise<FolderStat>;
  readlink(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  /** Open for reading; refuses a final component that is a link where the OS can. */
  open(path: string): Promise<FolderFileHandle>;
  fstat(handle: FolderFileHandle): Promise<FolderStat>;
  /** The file's bytes, at most `maxBytes + 1` of them, so a caller sees a file larger than its limit. */
  read(handle: FolderFileHandle, maxBytes: number): Promise<Buffer>;
  close(handle: FolderFileHandle): Promise<void>;
  /** Query drive mappings without opening the drive; missing mappings are null, helper failures throw. */
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
