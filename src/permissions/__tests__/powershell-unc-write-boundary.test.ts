import "../../__tests__/support/trusted-powershell.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { win32 } from "node:path";
import * as filesystemPaths from "../../shared/shell-filesystem-path.js";
import * as shellPaths from "../../shared/shell-native-path.js";
import { inspectPowerShellPermissionPaths } from "../rules/powershell-exfiltration.js";

const SHARE_PROJECT = String.raw`\\host\share\project`;

afterEach(() => vi.restoreAllMocks());

function provideAccessibleShare() {
  vi.spyOn(shellPaths, "modelShellPath").mockImplementation((value, model) => {
    const normalizedPath = win32.resolve(model.location ?? SHARE_PROJECT, value);
    return { nativePath: normalizedPath, normalizedPath, volumeRoot: win32.parse(normalizedPath).root, floorPaths: [] };
  });
  return vi.spyOn(filesystemPaths, "resolveShellFilesystemPath").mockImplementation(value => win32.normalize(value));
}

describe("share filesystem write boundaries", () => {
  it.each([
    [String.raw`Copy-Item notes.txt '\\other\share\out.txt'`, [true]],
    [String.raw`Move-Item notes.txt '\\host\other-share\out.txt'`, [false, true]],
    [String.raw`Set-Content '\\host\share\outside\out.txt' x`, [true]],
    [String.raw`'x' > '\\host\share\project\..\outside\out.txt'`, [true]],
  ] as const)("retains a known external write boundary without probing the share: %s", (command, expectedEscapes) => {
    const resolvePath = provideAccessibleShare();
    const result = inspectPowerShellPermissionPaths(command, SHARE_PROJECT);
    expect(result.unknownProtectedWrite).toBeUndefined();
    expect(result.paths.filter(path => path.effect === "write").map(path => path.projectEscape)).toEqual(expectedEscapes);
    expect(resolvePath.mock.calls.filter(([value]) => value.startsWith(String.raw`\\other`)
      || value.includes("other-share") || value.includes("outside"))).toEqual([]);
  });

  it.each([
    String.raw`Copy-Item notes.txt '\\HOST\SHARE\PROJECT\out.txt'`,
    "Copy-Item notes.txt '//host/share/project/out.txt'",
  ])("keeps a physically proven write inside the same share project: %s", command => {
    const resolvePath = provideAccessibleShare();
    const result = inspectPowerShellPermissionPaths(command, SHARE_PROJECT);
    expect(result.unknownProtectedWrite).toBeUndefined();
    expect(result.paths.filter(path => path.effect === "write")).toEqual([
      expect.objectContaining({ projectEscape: false }),
    ]);
    expect(resolvePath).toHaveBeenCalledTimes(2);
  });

  it("retains physical escape evidence for a lexically contained share target", () => {
    const resolvePath = provideAccessibleShare();
    resolvePath.mockImplementation(value => value.endsWith("out.txt")
      ? String.raw`\\host\share\outside\out.txt` : win32.normalize(value));
    const result = inspectPowerShellPermissionPaths(String.raw`Copy-Item notes.txt '\\host\share\project\out.txt'`, SHARE_PROJECT);
    expect(result.unknownProtectedWrite).toBeUndefined();
    expect(result.paths.filter(path => path.effect === "write")).toEqual([
      expect.objectContaining({ projectEscape: true }),
    ]);
    expect(resolvePath).toHaveBeenCalledTimes(2);
  });

  it.each([
    String.raw`Get-Content '\\other\share\notes.txt'`,
    String.raw`Write-Output '\\other\share\notes.txt'`,
    String.raw`Get-Content notes.txt | Out-Printer -Name '\\other\queue'`,
  ])("does not turn non-filesystem-write destinations into escapes: %s", command => {
    provideAccessibleShare();
    const result = inspectPowerShellPermissionPaths(command, SHARE_PROJECT);
    expect(result.unknownProtectedWrite).toBeUndefined();
    expect(result.paths.filter(path => path.effect === "write")).toEqual([]);
    expect(result.paths.some(path => path.projectEscape)).toBe(false);
  });
});
