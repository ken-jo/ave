import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as Ffi from "koffi";
import type * as Sdk from "@microsoft/mxc-sdk/v1";
import { verifyMxcSdk } from "../../scripts/lib/mxc-sdk-integrity.mjs";
import { MxcCapabilityUnavailableError, MxcNativeCallStackError } from "./mxc-extension-errors.js";
import pins from "./mxc-launcher-pins.json" with { type: "json" };

export type MxcShellSdk = Pick<typeof Sdk, "spawn" | "MxcError">;

/**
 * The SDK starts a run through koffi's asynchronous call, whose stack is 128 KiB by default. The backend forks on that
 * stack and libsandbox compiles a carved profile recursively before exec, which overruns it. The pinned CLI forks on
 * the 8 MiB main-thread stack, so the supervisor uses the same size: any profile the CLI can start, it can start.
 */
export const MXC_SHELL_ASYNC_STACK_BYTES = 8 * 1024 * 1024;

type KoffiConfig = Pick<typeof Ffi, "config">;

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
): Promise<MxcShellSdk> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new MxcCapabilityUnavailableError("Shell supervisor requires macOS arm64");
  }
  const installed = verifyMxcSdk(nodeModules, process.arch, pins, process.env, isPackaged, "darwin", !isPackaged);
  const library = join(installed.sdkRoot, pins.targets["darwin-arm64"].library.member);
  let sdk: MxcShellSdk;
  let sdkKoffi: KoffiConfig;
  try {
    const ffi = createRequire(import.meta.url)(installed.addonPath) as typeof Ffi;
    // koffi refuses configuration changes once any library is loaded, so this precedes the library check.
    if (asyncStackBytes !== null) ffi.config({ async_stack_size: asyncStackBytes });
    ffi.load(library).unload();
    sdk = await import(pathToFileURL(join(installed.sdkRoot, "dist", "v1", "index.js")).href) as MxcShellSdk;
    // The SDK imports koffi's ESM entry; read the setting back through that instance, not the addon handle above.
    const sdkRequire = createRequire(join(installed.sdkRoot, "dist", "native-library.js"));
    const koffiEntry = join(dirname(sdkRequire.resolve("koffi")), "index.js");
    sdkKoffi = (await import(pathToFileURL(koffiEntry).href) as { default: KoffiConfig }).default;
  } catch (cause) {
    throw new MxcCapabilityUnavailableError("Cannot load native shell SDK", { cause });
  }
  if (asyncStackBytes !== null) assertMxcShellCallStack(sdkKoffi, asyncStackBytes);
  return sdk;
}
