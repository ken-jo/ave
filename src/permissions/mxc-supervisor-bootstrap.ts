import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { resolve, win32 as winPath } from "node:path";
import { pathToFileURL } from "node:url";
import type * as Ffi from "koffi";
import type * as Sdk from "@microsoft/mxc-sdk/v1";
import { verifyMxcSdk, verifyMxcSupervisorRuntime } from "../../scripts/lib/mxc-sdk-integrity.mjs";
import PINS from "./mxc-launcher-pins.json" with { type: "json" };
import { MxcProcessContractError } from "./mxc-extension-errors.js";

export interface MxcSupervisorRuntime {
  readonly sdk: Pick<typeof Sdk, "spawn" | "probe">;
  auditModules(): string[];
}

interface BootstrapDependencies {
  verify: typeof verifyMxcSdk;
  verifyRuntime(): string[];
  loadAddon(file: string): typeof Ffi;
  importSdk(file: string): Promise<Pick<typeof Sdk, "spawn" | "probe">>;
  resolvePath(file: string): string;
}

function createLifetimeJob(ffi: typeof Ffi, kernel: Ffi.LibraryHandle): void {
  const BasicLimits = ffi.struct({
    perProcessUserTimeLimit: "int64_t", perJobUserTimeLimit: "int64_t", limitFlags: "uint32_t",
    minimumWorkingSetSize: "size_t", maximumWorkingSetSize: "size_t", activeProcessLimit: "uint32_t",
    affinity: "uintptr_t", priorityClass: "uint32_t", schedulingClass: "uint32_t",
  });
  const IoCounters = ffi.struct({ readOperationCount: "uint64_t", writeOperationCount: "uint64_t", otherOperationCount: "uint64_t",
    readTransferCount: "uint64_t", writeTransferCount: "uint64_t", otherTransferCount: "uint64_t" });
  const ExtendedLimits = ffi.struct({ basicLimitInformation: BasicLimits, ioInfo: IoCounters,
    processMemoryLimit: "size_t", jobMemoryLimit: "size_t", peakProcessMemoryUsed: "size_t", peakJobMemoryUsed: "size_t" });
  const limits = Buffer.alloc(ffi.sizeof(ExtendedLimits));
  const basic = { perProcessUserTimeLimit: 0, perJobUserTimeLimit: 0, limitFlags: 0x2000,
    minimumWorkingSetSize: 0, maximumWorkingSetSize: 0, activeProcessLimit: 0, affinity: 0, priorityClass: 0, schedulingClass: 0 };
  ffi.encode(limits, ExtendedLimits, { basicLimitInformation: basic,
    ioInfo: { readOperationCount: 0, writeOperationCount: 0, otherOperationCount: 0, readTransferCount: 0, writeTransferCount: 0, otherTransferCount: 0 },
    processMemoryLimit: 0, jobMemoryLimit: 0, peakProcessMemoryUsed: 0, peakJobMemoryUsed: 0 });
  const job = kernel.func("void * __stdcall CreateJobObjectW(void *, str16)")(null, null);
  const current = kernel.func("void * __stdcall GetCurrentProcess(void)")();
  const close = kernel.func("bool __stdcall CloseHandle(void *)");
  if (!job) throw new MxcProcessContractError("Cannot create supervisor lifetime job");
  if (!kernel.func("bool __stdcall SetInformationJobObject(void *, int, const void *, uint32_t)")(job, 9, limits, limits.length)
    || !kernel.func("bool __stdcall SetHandleInformation(void *, uint32_t, uint32_t)")(job, 1, 0)
    || !kernel.func("bool __stdcall AssignProcessToJobObject(void *, void *)")(job, current)) {
    close(job);
    throw new MxcProcessContractError("Cannot bind supervisor lifetime job");
  }
  // No breakaway flags, no inherited job handle. The kernel closes this retained
  // handle on process death, including native faults, killing the entire job.
  // Closing it explicitly would also kill this supervisor before its final receipt.
}

async function bootstrap(nodeModules: string, arch: string, environment: NodeJS.ProcessEnv, deps: BootstrapDependencies): Promise<MxcSupervisorRuntime> {
  // This must finish before even the trusted native addon is required.
  const installed = deps.verify(nodeModules, arch, PINS, environment, true);
  const runtimeModules = deps.verifyRuntime();
  const ffi = deps.loadAddon(installed.addonPath);
  const kernel = ffi.load("kernel32.dll");
  if (!kernel.func("bool __stdcall SetDefaultDllDirectories(uint32_t)")(0x800 | 0x400)) {
    throw new MxcProcessContractError("Cannot restrict supervisor DLL search");
  }
  const addDirectory = kernel.func("void * __stdcall AddDllDirectory(str16)");
  for (const directory of installed.nativeDirectories) {
    if (!addDirectory(directory)) throw new MxcProcessContractError("Cannot register verified native directory");
  }
  const getStandard = kernel.func("void * __stdcall GetStdHandle(int32_t)");
  const protectHandle = kernel.func("bool __stdcall SetHandleInformation(void *, uint32_t, uint32_t)");
  for (const descriptor of [-10, -11, -12]) {
    const handle = getStandard(descriptor);
    if (!handle || !protectHandle(handle, 1, 0)) throw new MxcProcessContractError("Cannot protect supervisor control handles");
  }
  const current = kernel.func("void * __stdcall GetCurrentProcess(void)")();
  const systemDirectory = Buffer.alloc(32768 * 2);
  const systemLength = kernel.func("uint32_t __stdcall GetSystemDirectoryW(void *, uint32_t)")(systemDirectory, 32768);
  if (!systemLength || systemLength >= 32768) throw new MxcProcessContractError("Cannot resolve native system directory");
  const system = systemDirectory.toString("utf16le", 0, systemLength * 2);
  const key = (file: string) => winPath.normalize(file.replace(/^\\\\\?\\/, "")).toLowerCase();
  const pinned = new Set([installed.addonPath, ...Object.keys(PINS.sdk.architectures[arch as "x64" | "arm64"])
    .filter((file) => file.endsWith(".dll")).map((file) => winPath.join(nodeModules, ...file.split("/")))].map(key));
  const enumerate = kernel.func("bool __stdcall K32EnumProcessModules(void *, void *, uint32_t, _Out_ uint32_t *)");
  const moduleName = kernel.func("uint32_t __stdcall GetModuleFileNameW(uintptr_t, void *, uint32_t)");
  const modules = (): string[] => {
    const handles = Buffer.alloc(2048 * 8), needed = [0];
    if (!enumerate(current, handles, handles.length, needed) || needed[0] > handles.length || needed[0] % 8) {
      throw new MxcProcessContractError("Cannot enumerate supervisor modules");
    }
    const result: string[] = [];
    for (let offset = 0; offset < needed[0]; offset += 8) {
      const name = Buffer.alloc(32768 * 2);
      const length = moduleName(handles.readBigUInt64LE(offset), name, 32768);
      if (!length || length >= 32768) throw new MxcProcessContractError("Cannot identify supervisor module");
      result.push(name.toString("utf16le", 0, length * 2));
    }
    return result;
  };
  const admittedRuntime = new Set(runtimeModules.map(key));
  // The bootstrap imports only the already-loaded system loader libraries. A
  // same-name addon/DLL anywhere else is refused, including before SDK import.
  const assertModules = (): string[] => {
    const loaded = modules();
    for (const file of loaded) {
      const name = winPath.basename(file).toLowerCase(), normalized = key(file);
      const selected = name === "koffi.node" || name === "mxc_ffi.dll" || name === "wslcsdk.dll";
      const systemRelative = winPath.relative(system, file);
      const systemModule = !winPath.isAbsolute(systemRelative) && systemRelative !== ".." && !systemRelative.startsWith("..\\");
      if ((selected && !pinned.has(key(deps.resolvePath(file))))
        || (!systemModule && !pinned.has(normalized) && !admittedRuntime.has(normalized))) {
        throw new MxcProcessContractError("Unexpected supervisor native module");
      }
    }
    return loaded.filter((file) => pinned.has(key(file)));
  };
  assertModules();
  createLifetimeJob(ffi, kernel);
  const sdk = await deps.importSdk(winPath.join(installed.sdkRoot, "dist", "v1", "index.js"));
  assertModules();
  return { sdk, auditModules: assertModules };
}

export async function bootstrapMxcSupervisor(nodeModules: string): Promise<MxcSupervisorRuntime> {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) {
    throw new MxcProcessContractError("Native extension supervisor requires a supported Windows architecture");
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!((major === 24 && minor >= 21) || (major === 26 && minor >= 8) || major > 26)) {
    throw new MxcProcessContractError("Native extension supervisor runtime is unsupported");
  }
  const require = createRequire(import.meta.url);
  return bootstrap(nodeModules, process.arch, process.env, {
    verify: verifyMxcSdk, verifyRuntime: () => verifyMxcSupervisorRuntime(process.execPath, resolve(nodeModules, "..", ".."), process.arch), loadAddon: (file) => require(file) as typeof Ffi,
    importSdk: (file) => import(pathToFileURL(file).href) as Promise<typeof Sdk>, resolvePath: realpathSync,
  });
}

export const _bootstrapMxcSupervisorForTest = bootstrap;
