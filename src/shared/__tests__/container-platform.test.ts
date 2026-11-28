import { describe, expect, it } from "vitest";
import { containerPlatform, containerTarget, isContainerHolderRouteEnabled, isContainerShellRouteEnabled } from "../container-platform.js";

describe("container platforms", () => {
  it.each([
    ["win32", "process-container", true, true, ["x64", "arm64"], "wxc-exec.exe"],
    ["darwin", "seatbelt", true, true, ["arm64"], "mxc-exec-mac"],
    ["linux", "bubblewrap", true, false, ["x64", "arm64"], "lxc-exec"],
  ] as const)("describes the backend and current route on %s", (platform, backend, shellRoute, holderRoute, arches, launcherFile) => {
    expect(containerPlatform(platform)).toEqual({ backend, shellRoute, holderRoute, arches, launcherFile });
    expect(isContainerShellRouteEnabled(platform)).toBe(shellRoute);
    expect(isContainerHolderRouteEnabled(platform)).toBe(holderRoute);
  });

  it.each([
    ["win32", "x64", "win32-x64"],
    ["win32", "arm64", "win32-arm64"],
    ["darwin", "arm64", "darwin-arm64"],
    ["linux", "x64", "linux-x64"],
    ["linux", "arm64", "linux-arm64"],
    ["darwin", "x64", undefined],
    ["linux", "arm", undefined],
    ["freebsd", "arm64", undefined],
  ] as const)("resolves the %s %s target", (platform, arch, target) => {
    expect(containerTarget(platform, arch)).toBe(target);
  });

  it("has no backend or route on an unsupported OS", () => {
    expect(containerPlatform("freebsd")).toBeUndefined();
    expect(isContainerShellRouteEnabled("freebsd")).toBe(false);
    expect(isContainerHolderRouteEnabled("freebsd")).toBe(false);
  });
});
