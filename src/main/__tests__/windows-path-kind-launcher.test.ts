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
    await expect(queryDosDevice("C:")).rejects.toThrow("classifier is missing");
    mocks.existsSync.mockReturnValue(true);
    await expect(queryDosDevice("C:\\x")).rejects.toThrow("not a drive letter");
    await expect(queryDosDevice("\\\\server\\share")).rejects.toThrow("not a drive letter");
    vi.stubGlobal("process", { ...process, platform: "darwin", arch: "x64" });
    await expect(queryDosDevice("C:")).rejects.toThrow("requires Windows");
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("rejects a failed lookup and an answer that is not one line", async () => {
    mocks.execFile.mockImplementationOnce((_f: string, _a: string[], _o: unknown, callback: Callback) => callback(new Error("exit 1"), "", "QueryDosDeviceW failed: 2\n"));
    await expect(queryDosDevice("Q:")).rejects.toThrow("QueryDosDeviceW failed: 2");
    mocks.execFile.mockImplementationOnce((_f: string, _a: string[], _o: unknown, callback: Callback) => callback(null, "", ""));
    await expect(queryDosDevice("Q:")).rejects.toThrow("answered");
    mocks.execFile.mockImplementationOnce((_f: string, _a: string[], _o: unknown, callback: Callback) => callback(null, "a\nb\n", ""));
    await expect(queryDosDevice("Q:")).rejects.toThrow("answered");
  });
});
