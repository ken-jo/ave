import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { handleSnapshot } from "./packaged-protocol.mjs";
import { verifyMxcSdk, verifyMxcSupervisorRuntime } from "../../scripts/lib/mxc-sdk-integrity.mjs";

// This observer has no lifetime job: otherwise killing the measured main could
// be masked by an outer job rather than exercising the supervisor's EOF path.
export function openPackagedObserver(executable) {
  const resources = path.join(path.dirname(executable), "resources");
  const pins = JSON.parse(readFileSync(new URL("../../src/permissions/mxc-launcher-pins.json", import.meta.url), "utf8"));
  const installed = verifyMxcSdk(path.join(resources, "app.asar.unpacked/node_modules"), process.arch, pins, process.env, true);
  verifyMxcSupervisorRuntime(executable, resources, process.arch);
  const ffi = createRequire(import.meta.url)(installed.addonPath);
  const kernel = ffi.load("kernel32.dll");
  if (!kernel.func("bool __stdcall SetDefaultDllDirectories(uint32_t)")(0xc00)) throw new Error("Observer DLL restriction failed");
  for (const directory of installed.nativeDirectories) {
    if (!kernel.func("void * __stdcall AddDllDirectory(str16)")(directory)) throw new Error("Observer verified directory registration failed");
  }
  const getTimes = kernel.func("bool __stdcall GetProcessTimes(void *, _Out_ uint64_t *, _Out_ uint64_t *, _Out_ uint64_t *, _Out_ uint64_t *)");
  const getImage = kernel.func("bool __stdcall QueryFullProcessImageNameW(void *, uint32_t, void *, _Inout_ uint32_t *)");
  const now = kernel.func("void __stdcall GetSystemTimePreciseAsFileTime(_Out_ uint64_t *)");
  const current = kernel.func("void * __stdcall GetCurrentProcess(void)")();
  const duplicate = kernel.func("bool __stdcall DuplicateHandle(void *, uintptr_t, void *, _Out_ uintptr_t *, uint32_t, bool, uint32_t)");
  const nt = ffi.load("ntdll.dll");
  const query = nt.func("uint32_t __stdcall NtQueryInformationProcess(void *, uint32_t, void *, uint32_t, _Out_ uint32_t *)");
  const compare = nt.func("uint32_t __stdcall NtCompareObjects(uintptr_t, uintptr_t)");
  const close = kernel.func("bool __stdcall CloseHandle(void *)");
  const open = kernel.func("void * __stdcall OpenProcess(uint32_t, bool, uint32_t)");
  const api = {
    now() { const value = [0n]; now(value); return BigInt(value[0]); },
    identity(handle) {
      const created = [0n], exit = [0n], kernelTime = [0n], userTime = [0n];
      const image = Buffer.alloc(65536), length = [32768];
      if (!getTimes(handle, created, exit, kernelTime, userTime) || !getImage(handle, 0, image, length)) throw new Error("Cannot query measured process identity");
      return { createdAt: BigInt(created[0]), imagePath: realpathSync(image.toString("utf16le", 0, length[0] * 2)) };
    },
    open: (rights, inherit, pid) => open(rights | 0x450, inherit, pid),
    wait: kernel.func("uint32_t __stdcall WaitForSingleObject(void *, uint32_t)"),
    terminate: kernel.func("bool __stdcall TerminateProcess(void *, uint32_t)"),
    close,
    elevated() {
      const security = ffi.load("advapi32.dll"), token = [null];
      if (!security.func("bool __stdcall OpenProcessToken(void *, uint32_t, _Out_ void **)")(current, 8, token)) throw new Error("Cannot query observer token");
      try {
        const value = Buffer.alloc(4), needed = [0];
        if (!security.func("bool __stdcall GetTokenInformation(void *, uint32_t, void *, uint32_t, _Out_ uint32_t *)")(token[0], 20, value, value.length, needed)) throw new Error("Cannot query observer elevation");
        return value.readUInt32LE(0) !== 0;
      } finally { close(token[0]); }
    },
    session() {
      const value = [0];
      if (!kernel.func("bool __stdcall ProcessIdToSessionId(uint32_t, _Out_ uint32_t *)")(process.pid, value)) throw new Error("Cannot query interactive session");
      return value[0];
    },
    modules(processHandle) {
      const handles = Buffer.alloc(2048 * 8), needed = [0];
      if (!kernel.func("bool __stdcall K32EnumProcessModules(void *, void *, uint32_t, _Out_ uint32_t *)")(processHandle, handles, handles.length, needed)
        || needed[0] > handles.length || needed[0] % 8) throw new Error("Cannot enumerate measured supervisor modules");
      const result = [];
      for (let offset = 0; offset < needed[0]; offset += 8) {
        const name = Buffer.alloc(65536);
        const length = kernel.func("uint32_t __stdcall K32GetModuleFileNameExW(void *, uintptr_t, void *, uint32_t)")(processHandle, handles.readBigUInt64LE(offset), name, 32768);
        if (!length || length >= 32768) throw new Error("Cannot identify measured supervisor module");
        result.push(realpathSync(name.toString("utf16le", 0, length * 2)));
      }
      return result;
    },
    // Snapshot class 51 uses pointer-sized headers followed by 40-byte entries
    // on the two supported 64-bit architectures. Any incomplete query or stale
    // handle makes the observation inconclusive, never a non-inheritance pass.
    handles(processHandle) {
      for (let size = 65536; size <= 4 * 1024 * 1024; size *= 2) {
        const bytes = Buffer.alloc(size), needed = [0];
        const status = query(processHandle, 51, bytes, size, needed);
        if (status === 0xc0000004 || status === 0xc0000023) continue;
        if (status !== 0) throw new Error(`Process handle query failed: 0x${status.toString(16)}`);
        return handleSnapshot(bytes);
      }
      throw new Error("Process handle snapshot exceeds bound");
    },
    observeOwnerHandle(supervisor, descendants, ownerHandle) {
      const expected = BigInt(ownerHandle);
      const entry = api.handles(supervisor).find((entry) => entry.value === expected);
      if (!entry) throw new Error("Supervisor owner handle absent from snapshot");
      const copied = [0n];
      if (!duplicate(supervisor, expected, current, copied, 0, false, 2)) throw new Error("Cannot pin supervisor owner pipe object");
      try {
        const observations = descendants.map((processHandle) => {
          let inspected = 0;
          for (const item of api.handles(processHandle)) {
            const candidate = [0n];
            if (!duplicate(processHandle, item.value, current, candidate, 0, false, 2)) throw new Error("Child handle changed during snapshot; non-inheritance inconclusive");
            try {
              const status = compare(copied[0], candidate[0]);
              if (status === 0) return { inherited: true, inspected };
              if (status !== 0xc00001ac && status !== 0xc0000024) throw new Error(`Handle comparison failed: 0x${status.toString(16)}`);
              inspected++;
            } finally { close(candidate[0]); }
          }
          return { inherited: false, inspected };
        });
        return { supervisorInheritable: (entry.attributes & 2) !== 0, descendants: observations };
      } finally { close(copied[0]); }
    },
  };
  return api;
}
