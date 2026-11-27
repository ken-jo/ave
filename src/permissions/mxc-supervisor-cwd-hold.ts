import type * as Ffi from "koffi";
import type { WindowsDirectoryHandleSource } from "../shared/windows-path-facts.js";
import { MxcProcessContractError } from "./mxc-extension-errors.js";

/** Adopt the helper's actual directory handles before native creation. Their sharing restrictions survive helper exit. */
export function adoptMxcSupervisorDirectoryHold(kernel: Ffi.LibraryHandle, source: WindowsDirectoryHandleSource): () => void {
  const refuse = (): never => { throw new MxcProcessContractError("Extension working directory hold could not be adopted"); };
  const openProcess = kernel.func("intptr_t __stdcall OpenProcess(uint32_t, int, uint32_t)");
  const processTimes = kernel.func("int __stdcall GetProcessTimes(intptr_t, void *, void *, void *, void *)");
  const wait = kernel.func("uint32_t __stdcall WaitForSingleObject(intptr_t, uint32_t)");
  const currentProcess = kernel.func("intptr_t __stdcall GetCurrentProcess()");
  const duplicate = kernel.func("int __stdcall DuplicateHandle(intptr_t, intptr_t, intptr_t, void *, uint32_t, int, uint32_t)");
  const close = kernel.func("int __stdcall CloseHandle(intptr_t)");
  const helper = openProcess(0x101040, 0, source.pid); // synchronize, limited query, duplicate handle
  if (!helper) return refuse();
  const handles: bigint[] = [];
  const release = (): void => { for (const handle of handles.splice(0)) close(handle); };
  try {
    const creation = Buffer.alloc(8), exit = Buffer.alloc(8), kernelTime = Buffer.alloc(8), user = Buffer.alloc(8);
    if (!processTimes(helper, creation, exit, kernelTime, user) || creation.readBigUInt64LE().toString() !== source.creationTime
      || source.handles.length === 0) return refuse();
    const target = currentProcess();
    const value = Buffer.alloc(8);
    for (const handle of source.handles) {
      if (!duplicate(helper, BigInt(handle), target, value, 0, 0, 2)) return refuse();
      handles.push(value.readBigInt64LE());
    }
    if (wait(helper, 0) !== 258) return refuse();
    return release;
  } catch (error) {
    release();
    throw error;
  } finally {
    close(helper);
  }
}
