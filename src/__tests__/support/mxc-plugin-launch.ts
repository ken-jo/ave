import { win32 as winPath } from "node:path";
import { vi } from "vitest";
import type { MxcConfinedChildSpawn } from "../../permissions/confined-child.js";
import type { OwnedMxcExtensionProcess } from "../../permissions/mxc-extension-process.js";
import type { MxcPluginChildLaunch } from "../../plugins/isolation/mxc-plugin-child.js";
import { SYNTHETIC_MXC_STAGING_PARENT } from "./mxc-staging-parent.js";

/** A planner launch with a valid `<staging parent>\<opaque-id>` HOME/temp pair. */
export function nativePluginLaunch(overrides: Partial<MxcPluginChildLaunch> = {}, stagingParent = SYNTHETIC_MXC_STAGING_PARENT): MxcPluginChildLaunch {
  const staging = winPath.join(stagingParent, "0123456789abcdef0123456789abcdef");
  return {
    home: winPath.join(staging, "home"), temp: winPath.join(staging, "temp"),
    filesystemOwnership: { readRoots: [], writeRoots: [staging], hostStorageRoots: [] },
    signal: new AbortController().signal, assertCurrent() {}, release() {},
    ...overrides,
  };
}

/** What row 2's `spawnMxcConfinedChild` returns for an owned process; `release` is a spy. */
export function admittedMxcChild(process: OwnedMxcExtensionProcess, release = vi.fn(async () => {})): MxcConfinedChildSpawn {
  return { process, confinement: "windows-mxc", release };
}
