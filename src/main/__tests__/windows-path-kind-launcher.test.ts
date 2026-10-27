import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), existsSync: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }));
import { queryDosDevice, queryWindowsSystemDirectory, resolveWindowsPathKindHelper } from "../windows-path-kind-launcher.js";
import { configureHostResources } from "../host-resources.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

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

describe("native system directory launcher", () => {
  beforeEach(() => {
    configureHostResources({ resourcePath: "/trusted/resources", isPackaged: true });
    mocks.execFile.mockReset();
    mocks.existsSync.mockReset().mockReturnValue(true);
    vi.stubGlobal("process", { ...process, platform: "win32", arch: "x64" });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("simulates the OS answer through the packaged helper with no inherited environment", async () => {
    vi.stubEnv("SystemRoot", "Z:\\untrusted");
    vi.stubEnv("WINDIR", "Y:\\untrusted");
    vi.stubEnv("ANTHROPIC_API_KEY", "parent-secret");
    mocks.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: Callback) => callback(null, "D:\\OperatingSystem\\System32\r\n", ""));
    await expect(queryWindowsSystemDirectory()).resolves.toBe("D:\\OperatingSystem\\System32");
    expect(mocks.execFile).toHaveBeenCalledWith(
      join("/trusted/resources", "windows-path-kind", "x64", "ave-path-kind.exe"),
      ["--system-directory"],
      { windowsHide: true, shell: false, env: {}, encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs, maxBuffer: 128 * 1024 },
      expect.any(Function),
    );
  });

  it("refuses missing helpers and unsupported platforms without another lookup", async () => {
    mocks.existsSync.mockReturnValue(false);
    await expect(queryWindowsSystemDirectory()).rejects.toThrow("classifier is missing");
    mocks.existsSync.mockReturnValue(true);
    vi.stubGlobal("process", { ...process, platform: "linux" });
    await expect(queryWindowsSystemDirectory()).rejects.toThrow("requires Windows");
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("does not treat helper failure as a missing mapping or return an environment-derived directory", async () => {
    mocks.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: Callback) => callback(Object.assign(new Error("Fixture helper failed"), { code: 1 }), "C:\\Windows\\System32\n", ""));
    await expect(queryWindowsSystemDirectory()).rejects.toThrow("Windows system directory query failed");
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
  });

  it.each(["", "relative", "C:\\", "C:\\Windows\\..\\untrusted", "C:\\Windows\\System32\nD:\\Other", "\\\\server\\Windows\\System32", "C:\\Windows\\System32:alternate", "C:\\Windows\\System32\0"])("refuses a malformed simulated native answer %j", async (answer) => {
    mocks.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: Callback) => callback(null, answer, ""));
    await expect(queryWindowsSystemDirectory()).rejects.toThrow("invalid path");
  });

  it("fails on unexpected native diagnostics even with a plausible path", async () => {
    mocks.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: Callback) => callback(null, "C:\\Windows\\System32\n", "Unexpected native diagnostic"));
    await expect(queryWindowsSystemDirectory()).rejects.toThrow("query failed");
  });

  it.each([512, 513])("preserves verifier command headroom for a simulated %i-character system root", async (length) => {
    const root = `C:\\${"a".repeat(250)}\\${"b".repeat(250)}\\${"c".repeat(length - 505)}`;
    expect(root).toHaveLength(length);
    const directory = `${root}\\System32`;
    mocks.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: Callback) => callback(null, `${directory}\n`, ""));
    if (length === 512) await expect(queryWindowsSystemDirectory()).resolves.toBe(directory);
    else await expect(queryWindowsSystemDirectory()).rejects.toThrow("invalid path");
  });
});
