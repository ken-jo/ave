import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as Ffi from "koffi";
import type * as Sdk from "@microsoft/mxc-sdk/v1";
import { verifyMxcSdk } from "../../scripts/lib/mxc-sdk-integrity.mjs";
import { MxcCapabilityUnavailableError } from "./mxc-extension-errors.js";
import pins from "./mxc-launcher-pins.json" with { type: "json" };

export type MxcShellSdk = Pick<typeof Sdk, "spawn" | "MxcError">;

export async function bootstrapMxcShellSupervisor(nodeModules: string, isPackaged: boolean): Promise<MxcShellSdk> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new MxcCapabilityUnavailableError("Shell supervisor requires macOS arm64");
  }
  const installed = verifyMxcSdk(nodeModules, process.arch, pins, process.env, isPackaged, "darwin", !isPackaged);
  const library = join(installed.sdkRoot, pins.targets["darwin-arm64"].library.member);
  try {
    const ffi = createRequire(import.meta.url)(installed.addonPath) as typeof Ffi;
    ffi.load(library).unload();
    return await import(pathToFileURL(join(installed.sdkRoot, "dist", "v1", "index.js")).href) as MxcShellSdk;
  } catch (cause) {
    throw new MxcCapabilityUnavailableError("Cannot load native shell SDK", { cause });
  }
}
