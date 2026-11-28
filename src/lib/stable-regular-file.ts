import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { platform } from "node:process";
import { isMissingPathError } from "./atomic-file.js";

function sameIdentity(
  left: { readonly dev: bigint; readonly ino: bigint },
  right: { readonly dev: bigint; readonly ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Reject links and special files without blocking; require matching path/descriptor identity before and after reading, with unchanged size and timestamps. Null means absent only. */
export function readStableRegularFileUtf8(
  filePath: string,
  maxBytes: number,
  label: string,
  requirePrivateOwnerFile = false,
): string | null {
  const flags = constants.O_RDONLY |
    (platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let fd: number | undefined;
  try {
    try {
      fd = openSync(filePath, flags);
    } catch (error) {
      if (isMissingPathError(error)) return null;
      throw error;
    }
    const before = fstatSync(fd, { bigint: true });
    const pathAtOpen = lstatSync(filePath, { bigint: true });
    if (!before.isFile() || pathAtOpen.isSymbolicLink() ||
        !pathAtOpen.isFile() || !sameIdentity(pathAtOpen, before)) {
      throw new Error(`${label} path is not a stable regular file`);
    }
    if (requirePrivateOwnerFile) {
      if (platform === "win32" || typeof process.geteuid !== "function") {
        throw new Error(`${label} private ownership cannot be verified on this platform`);
      }
      const mode = Number(before.mode & 0o7777n);
      if (before.uid !== BigInt(process.geteuid()) || before.nlink !== 1n || mode !== 0o600) {
        throw new Error(`${label} must be an owner-only single-link file`);
      }
    }
    const size = Number(before.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
      throw new Error(`${label} exceeds read byte limit`);
    }
    const buffer = Buffer.alloc(size);
    let completed = 0;
    while (completed < size) {
      const read = readSync(fd, buffer, completed, size - completed, completed);
      if (read === 0) {
        throw new Error(`${label} was truncated during read`);
      }
      completed += read;
    }
    const after = fstatSync(fd, { bigint: true });
    const pathAfter = lstatSync(filePath, { bigint: true });
    if (!after.isFile() || pathAfter.isSymbolicLink() || !pathAfter.isFile() ||
        !sameIdentity(before, after) ||
        !sameIdentity(after, pathAfter) ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs) {
      throw new Error(`${label} changed during read`);
    }
    const text = buffer.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(buffer)) {
      throw new Error(`${label} is not valid UTF-8`);
    }
    return text;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
