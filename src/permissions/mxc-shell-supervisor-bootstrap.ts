import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as Ffi from "koffi";
import type * as Sdk from "@microsoft/mxc-sdk/v1";
import { MxcIntegrityError, verifyMxcSdk } from "../../scripts/lib/mxc-sdk-integrity.mjs";
import { MxcCapabilityUnavailableError, MxcNativeCallStackError } from "./mxc-extension-errors.js";
import pins from "./mxc-launcher-pins.json" with { type: "json" };

export type MxcShellSdk = Pick<typeof Sdk, "spawn" | "MxcError">;

/** The verified SDK, and the check a service runs synchronously immediately before each native spawn. */
export interface MxcShellRuntime {
  readonly sdk: MxcShellSdk;
  /** Throws `MxcIntegrityError` unless the pinned library is still at its path with its pinned hash and the SDK's
   * source-build fallback location is still absent: the SDK resolves the library by path at first use. */
  assertLibraryInPlace(): void;
}

/** The pre-spawn library check over one installation. */
export function mxcShellLibraryCheck(nodeModules: string, sdkRoot: string): () => void {
  const pin = pins.targets["darwin-arm64"].library;
  const library = join(sdkRoot, pin.member);
  const fallback = join(nodeModules, "src", "target");
  return () => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(library);
    } catch (cause) {
      throw new MxcIntegrityError("Native shell library is missing after verification", { cause });
    }
    if (createHash("sha256").update(bytes).digest("hex") !== pin.sha256) {
      throw new MxcIntegrityError("Native shell library changed after verification");
    }
    let fallbackPresent = true;
    try {
      lstatSync(fallback);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new MxcIntegrityError("Native source-build fallback is unreadable", { cause: error });
      fallbackPresent = false;
    }
    if (fallbackPresent) throw new MxcIntegrityError("Native source-build fallback appeared after verification");
  };
}

/**
 * The SDK starts a run through koffi's asynchronous call, whose stack is 128 KiB by default. The backend forks on that
 * stack and libsandbox compiles a carved profile recursively before exec, which overruns it. The pinned CLI forks on
 * the 8 MiB main-thread stack, so the supervisor uses the same size: any profile the CLI can start, it can start.
 */
export const MXC_SHELL_ASYNC_STACK_BYTES = 8 * 1024 * 1024;

type KoffiConfig = Pick<typeof Ffi, "config">;
// Never unloaded: the process exits after its one run.
const retainedLibraries: ReturnType<typeof Ffi.load>[] = [];

/** Refuse startup unless the koffi instance the SDK resolved carries the configured asynchronous call stack. */
export function assertMxcShellCallStack(sdkKoffi: KoffiConfig, expected: number): void {
  const configured = sdkKoffi.config().async_stack_size;
  if (configured !== expected) {
    throw new MxcNativeCallStackError(`Native shell call stack is ${configured} bytes, expected ${expected}`);
  }
}

/**
 * `asyncStackBytes` is the production constant. Only the native suite's regression entry passes `null`, to prove
 * that the carved-profile parity test detects a supervisor without the setting.
 */
export async function bootstrapMxcShellSupervisor(
  nodeModules: string, isPackaged: boolean, asyncStackBytes: number | null = MXC_SHELL_ASYNC_STACK_BYTES,
): Promise<MxcShellRuntime> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new MxcCapabilityUnavailableError("Shell supervisor requires macOS arm64");
  }
  const installed = verifyMxcSdk(nodeModules, process.arch, pins, process.env, isPackaged, "darwin", !isPackaged);
  const library = join(installed.sdkRoot, pins.targets["darwin-arm64"].library.member);
  let sdk: MxcShellSdk;
  let sdkKoffi: KoffiConfig;
  try {
    const ffi = createRequire(import.meta.url)(installed.addonPath) as typeof Ffi;
    // koffi refuses configuration changes once any library is loaded, so this precedes the library load.
    if (asyncStackBytes !== null) ffi.config({ async_stack_size: asyncStackBytes });
    // Keep the verified library mapped for the life of this one-run process. A warm standby waits between this check
    // and its first spawn, and the SDK's own load by the same path then reuses this image instead of re-reading disk.
    retainedLibraries.push(ffi.load(library));
    sdk = await import(pathToFileURL(join(installed.sdkRoot, "dist", "v1", "index.js")).href) as MxcShellSdk;
    // The SDK imports koffi's ESM entry; read the setting back through that instance, not the addon handle above.
    const sdkRequire = createRequire(join(installed.sdkRoot, "dist", "native-library.js"));
    const koffiEntry = join(dirname(sdkRequire.resolve("koffi")), "index.js");
    sdkKoffi = (await import(pathToFileURL(koffiEntry).href) as { default: KoffiConfig }).default;
  } catch (cause) {
    throw new MxcCapabilityUnavailableError("Cannot load native shell SDK", { cause });
  }
  if (asyncStackBytes !== null) assertMxcShellCallStack(sdkKoffi, asyncStackBytes);
  return { sdk, assertLibraryInPlace: mxcShellLibraryCheck(nodeModules, installed.sdkRoot) };
}
