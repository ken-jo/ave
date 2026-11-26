import { describe, expect, it } from "vitest";
import { containerTarget } from "../../shared/container-platform.js";
import { launcherPathFor, pinnedLauncherSha256, _readLauncherPinsForTest } from "../mxc-launcher.js";
import pins from "../mxc-launcher-pins.json" with { type: "json" };

describe("container launcher pins", () => {
  it.each([
    ["win32", "x64", "win32-x64", "C:\\app\\mxc\\x64\\wxc-exec.exe"],
    ["win32", "arm64", "win32-arm64", "C:\\app\\mxc\\arm64\\wxc-exec.exe"],
    ["darwin", "arm64", "darwin-arm64", "/app/mxc/arm64/mxc-exec-mac"],
    ["linux", "x64", "linux-x64", "/app/mxc/x64/lxc-exec"],
    ["linux", "arm64", "linux-arm64", "/app/mxc/arm64/lxc-exec"],
  ] as const)("uses the pinned launcher and path flavor for %s %s", (platform, arch, target, expected) => {
    expect(containerTarget(platform, arch)).toBe(target);
    expect(launcherPathFor(platform === "win32" ? "C:\\app" : "/app", platform, arch)).toBe(expected);
    expect(pinnedLauncherSha256(target)).toBe(pins.targets[target].launcher.sha256);
  });

  it("returns no path for an unsupported OS or architecture", () => {
    expect(launcherPathFor("/app", "darwin", "x64")).toBeUndefined();
    expect(launcherPathFor("/app", "freebsd", "arm64")).toBeUndefined();
    expect(Object.keys(pins.targets).sort()).toEqual(["darwin-arm64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]);
  });

  it("refuses missing, malformed and unknown target pins", () => {
    const { "darwin-arm64": mac, ...withoutMac } = pins.targets;
    expect(() => _readLauncherPinsForTest(withoutMac)).toThrow(/missing.*darwin-arm64/iu);
    expect(() => _readLauncherPinsForTest({ ...pins.targets,
      "darwin-arm64": { ...mac, launcher: { ...mac.launcher, sha256: "bad" } },
    })).toThrow(/malformed.*darwin-arm64/iu);
    expect(() => _readLauncherPinsForTest({ ...pins.targets, "darwin-x64": mac })).toThrow(/unknown.*darwin-x64/iu);
  });
});
