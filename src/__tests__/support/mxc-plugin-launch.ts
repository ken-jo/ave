import { win32 as winPath } from "node:path";
import { vi } from "vitest";
import type { MxcConfinedChildSpawn } from "../../permissions/confined-child.js";
import type { OwnedMxcExtensionProcess } from "../../permissions/mxc-extension-process.js";
import { aveHome } from "../../shared/ave-home.js";
import type { MxcPluginChildLaunch } from "../../plugins/isolation/mxc-plugin-child.js";

/** A planner launch with a valid `<AVE_HOME>\mxc-staging\<opaque-id>` HOME/temp pair. */
export function nativePluginLaunch(overrides: Partial<MxcPluginChildLaunch> = {}): MxcPluginChildLaunch {
  const staging = winPath.join(aveHome(), "mxc-staging", "0123456789abcdef0123456789abcdef");
  return {
    home: winPath.join(staging, "home"), temp: winPath.join(staging, "temp"),
    filesystemOwnership: { readRoots: [], writeRoots: [staging], hostStorageRoots: [] },
    probe: async () => ({ version: "0.0.80", ready: true }) as never,
    signal: new AbortController().signal, assertCurrent() {}, release() {},
    ...overrides,
  };
}

/** What row 2's `spawnMxcConfinedChild` returns for an owned process; `release` is a spy. */
export function admittedMxcChild(process: OwnedMxcExtensionProcess, release = vi.fn(async () => {})): MxcConfinedChildSpawn {
  return { process, confinement: "windows-mxc", release };
}
