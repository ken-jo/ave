import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const FILE_LIST_DIRECTORY = 1;
const GENERIC_READ = 0x80000000;
const FILE_SHARE_READ = 1;
const FILE_SHARE_ALL = 7;
const OPEN_EXISTING = 3;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const FILE_ATTRIBUTE_TAG_INFO = 9;
const VOLUME_NAME_NT = 2;
const GLOBAL_ROOT = String.raw`\\?\GLOBALROOT`;
const MAX_PATH_CHARS = 32768;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const require = createRequire(import.meta.url);
let api;

function windowsFiles() {
  if (api !== undefined) return api;
  const kernel = require("koffi").load("kernel32.dll");
  api = {
    open: kernel.func("intptr_t __stdcall CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, void *)"),
    close: kernel.func("int __stdcall CloseHandle(intptr_t)"),
    finalPath: kernel.func("uint32_t __stdcall GetFinalPathNameByHandleW(intptr_t, void *, uint32_t, uint32_t)"),
    attributes: kernel.func("int __stdcall GetFileInformationByHandleEx(intptr_t, int, void *, uint32_t)"),
    size: kernel.func("int __stdcall GetFileSizeEx(intptr_t, void *)"),
    read: kernel.func("int __stdcall ReadFile(intptr_t, void *, uint32_t, void *, void *)"),
  };
  return api;
}

function checkedOpen(api, path, access, sharing, flags) {
  const handle = api.open(path, access, sharing, null, OPEN_EXISTING, flags, null);
  if (handle === -1 || handle === -1n) throw new Error("Could not hold the Windows executable path");
  return handle;
}

function volumePath(api, executable) {
  const handle = checkedOpen(api, executable, 0, FILE_SHARE_ALL, 0);
  try {
    const buffer = Buffer.alloc(MAX_PATH_CHARS * 2);
    const length = api.finalPath(handle, buffer, MAX_PATH_CHARS, VOLUME_NAME_NT);
    if (length === 0 || length >= MAX_PATH_CHARS) throw new Error("Could not resolve the Windows executable volume");
    return GLOBAL_ROOT + buffer.toString("utf16le", 0, length * 2);
  } finally {
    api.close(handle);
  }
}

function readImage(api, handle) {
  const size = Buffer.alloc(8);
  if (!api.size(handle, size)) throw new Error("Could not measure the Windows executable");
  const length = Number(size.readBigInt64LE());
  if (length <= 0 || length > MAX_IMAGE_BYTES) throw new Error("Invalid Windows executable size");
  const bytes = Buffer.alloc(length);
  const count = Buffer.alloc(4);
  if (!api.read(handle, bytes, length, count, null) || count.readUInt32LE() !== length) {
    throw new Error("Could not read the Windows executable");
  }
  return bytes;
}

/** Hold the resolved image and directory entries across the synchronous process creation call. */
export function lockWindowsExecutable(executable) {
  if (process.platform !== "win32") throw new Error("Executable locking requires Windows");
  const api = windowsFiles();
  const path = volumePath(api, executable);
  const volume = /^\\Device\\HarddiskVolume[0-9]+\\/iu.exec(path.slice(GLOBAL_ROOT.length))?.[0];
  const root = volume === undefined ? undefined : GLOBAL_ROOT + volume;
  if (!root || path === root) throw new Error("Expected an executable on a local Windows volume");

  // Lock top-down and open each entry itself. A redirected drive, junction or parent rename cannot retarget the spawn.
  const parts = path.slice(root.length).split("\\");
  const handles = [];
  const close = () => {
    for (const handle of handles.reverse()) api.close(handle);
    handles.length = 0;
  };
  try {
    const info = Buffer.alloc(8);
    let entry = root;
    for (const [index, part] of parts.entries()) {
      const directory = index < parts.length - 1;
      entry += part;
      const handle = checkedOpen(api, entry, directory ? FILE_LIST_DIRECTORY : GENERIC_READ,
        FILE_SHARE_READ, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
      handles.push(handle);
      if (!api.attributes(handle, FILE_ATTRIBUTE_TAG_INFO, info, info.length)) {
        throw new Error("Could not inspect the Windows executable path");
      }
      const attributes = info.readUInt32LE();
      if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0 || ((attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0) !== directory) {
        throw new Error("The Windows executable path changed while opening it");
      }
      entry += "\\";
    }
    return { path, bytes: readImage(api, handles.at(-1)), close };
  } catch (error) {
    close();
    throw error;
  }
}

export function withVerifiedWindowsExecutable(executable, expectedSha256, launch) {
  const locked = lockWindowsExecutable(executable);
  try {
    const actualSha256 = createHash("sha256").update(locked.bytes).digest("hex");
    if (actualSha256 !== expectedSha256) throw new Error("Windows test executable does not match the producing build");
    return launch(locked.path);
  } finally {
    locked.close();
  }
}
