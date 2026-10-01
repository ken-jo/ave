import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), existsSync: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }));
import { queryDosDevice, resolveWindowsPathKindHelper } from "../windows-path-kind-launcher.js";
import { configureHostResources } from "../host-resources.js";

type Callback = (error: Error | null, stdout: string, stderr: string) => void;

describe("Windows folder classifier launcher", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    configureHostResources({ resourcePath: "/trusted/resources", isPackaged: true });
    mocks.execFile.mockReset();
    mocks.existsSync.mockReset().mockReturnValue(true);
    vi.stubGlobal("process", { ...process, platform: "win32", arch: "x64" });
  });

  it("resolves the packaged asset under the host resources", () => {
    expect(resolveWindowsPathKindHelper()).toBe(join("/trusted/resources", "windows-path-kind", "x64", "ave-path-kind.exe"));
  });

  it("runs the helper on the drive letter alone, hidden and bounded, and returns its one line", async () => {
    mocks.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: Callback) => callback(null, "\\Device\\Mup\\;LanmanRedirector\\server\\share\r\n", ""));
    await expect(queryDosDevice("Z:")).resolves.toBe("\\Device\\Mup\\;LanmanRedirector\\server\\share");
    expect(mocks.execFile).toHaveBeenCalledWith(
      join("/trusted/resources", "windows-path-kind", "x64", "ave-path-kind.exe"),
      ["Z:"],
      { windowsHide: true, timeout: 5000, encoding: "utf8" },
      expect.any(Function),
    );
  });

  it("fails clearly without the asset, off Windows, or for anything but a drive, and never runs a command", async () => {
    mocks.existsSync.mockReturnValue(false);
    await expect(queryDosDevice("C:")).rejects.toThrow(/classifier is missing: .*ave-path-kind\.exe\. Ave cannot tell .* Reinstall Ave/u);
    mocks.existsSync.mockReturnValue(true);
    await expect(queryDosDevice("C:\\x")).rejects.toThrow("not a drive letter");
    await expect(queryDosDevice("\\\\server\\share")).rejects.toThrow("not a drive letter");
    vi.stubGlobal("process", { ...process, platform: "darwin", arch: "x64" });
    await expect(queryDosDevice("C:")).rejects.toThrow("requires Windows");
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("answers null when the OS has no mapping for the drive (exit 1), the one failure that is about the drive", async () => {
    mocks.execFile.mockImplementationOnce((_f: string, _a: string[], _o: unknown, callback: Callback) =>
      callback(Object.assign(new Error("Command failed"), { code: 1 }), "", "QueryDosDeviceW failed: 2\n"));
    await expect(queryDosDevice("Q:")).resolves.toBeNull();
  });

  it("rejects a broken helper with its cause and what to do, never as an answer about the drive", async () => {
    const fail = (error: Error & { code?: number | string | null; killed?: boolean }, stdout = "", stderr = "") =>
      mocks.execFile.mockImplementationOnce((_f: string, _a: string[], _o: unknown, callback: Callback) => callback(error, stdout, stderr));
    fail(Object.assign(new Error("spawn EACCES"), { code: "EACCES" }));
    await expect(queryDosDevice("Q:")).rejects.toThrow(/classifier failed for Q:: spawn EACCES\. Reinstall Ave/u);
    fail(Object.assign(new Error("Command failed"), { code: 2 }), "", "usage: ave-path-kind.exe X:\n");
    await expect(queryDosDevice("Q:")).rejects.toThrow("usage: ave-path-kind.exe X:");
    fail(Object.assign(new Error("Command failed"), { code: 3 }), "", "could not write the mapping\n");
    await expect(queryDosDevice("Q:")).rejects.toThrow("could not write the mapping");
    fail(Object.assign(new Error("Command failed"), { code: null, killed: true }));
    await expect(queryDosDevice("Q:")).rejects.toThrow("did not answer within 5000 ms");
    mocks.execFile.mockImplementationOnce((_f: string, _a: string[], _o: unknown, callback: Callback) => callback(null, "", ""));
    await expect(queryDosDevice("Q:")).rejects.toThrow("not one mapping");
    mocks.execFile.mockImplementationOnce((_f: string, _a: string[], _o: unknown, callback: Callback) => callback(null, "a\nb\n", ""));
    await expect(queryDosDevice("Q:")).rejects.toThrow("not one mapping");
  });
});
