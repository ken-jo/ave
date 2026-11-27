import { close, fstat, type BigIntStats, writeFile } from "node:fs";
import { createRequire } from "node:module";
import { toNamespacedPath } from "node:path";
import { promisify } from "node:util";

const closeDescriptor = promisify(close);
const writeDescriptor = promisify(writeFile);
const statDescriptor = promisify((descriptor: number, callback: (error: NodeJS.ErrnoException | null, stats: BigIntStats) => void) => {
  fstat(descriptor, { bigint: true }, callback);
});
const requireNative = createRequire(import.meta.url);
const GENERIC_WRITE = 0x40000000;
const DELETE = 0x00010000;
const FILE_READ_ATTRIBUTES = 0x80;
const SHARE_READ_WRITE_DELETE = 0x07;
const CREATE_NEW = 1;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const FILE_DISPOSITION_INFO = 4;

function bindStagedWrite() {
  const ffi = requireNative("koffi") as typeof import("koffi");
  const kernel = ffi.load("kernel32.dll");
  return {
    create: kernel.func("intptr_t __stdcall CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, intptr_t)"),
    setInfo: kernel.func("bool __stdcall SetFileInformationByHandle(intptr_t, int, const void *, uint32_t)"),
    close: kernel.func("bool __stdcall CloseHandle(intptr_t)"),
    lastError: kernel.func("uint32_t __stdcall GetLastError()"),
    adopt: ffi.load(null).func("int uv_open_osfhandle(intptr_t)"),
  };
}

let bindings: ReturnType<typeof bindStagedWrite> | undefined;

/** Hold deletion authority for this exact staging file, so abort never has to follow a pathname. */
export function openWindowsStagedWrite(path: string) {
  bindings ??= bindStagedWrite();
  const native = bindings;
  const handle = native.create(toNamespacedPath(path), GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES,
    SHARE_READ_WRITE_DELETE, null, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, 0);
  if (BigInt(handle) === -1n) throw new Error(`Could not create staged file (Windows error ${native.lastError()})`);
  const discard = (): void => {
    const remove = Buffer.from([1, 0, 0, 0]);
    if (!native.setInfo(handle, FILE_DISPOSITION_INFO, remove, remove.length)) {
      throw new Error(`Could not discard staged file (Windows error ${native.lastError()})`);
    }
  };
  let descriptor: number;
  try {
    descriptor = native.adopt(handle);
    if (descriptor < 0) throw new Error("Could not adopt staged file descriptor");
  } catch (error) {
    try { discard(); } finally { native.close(handle); }
    throw error;
  }
  return {
    discard,
    write: (content: string) => writeDescriptor(descriptor, content, "utf8"),
    stat: () => statDescriptor(descriptor),
    close: () => closeDescriptor(descriptor),
  };
}
