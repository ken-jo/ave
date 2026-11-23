import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), execFileSync: vi.fn(), existsSync: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile, execFileSync: mocks.execFileSync }));
vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }));
import { queryDosDevice, queryWindowsDocumentsDirectory, queryWindowsSystemDirectory, resolveWindowsPathKindHelper } from "../windows-path-kind-launcher.js";
import { configureHostResources } from "../host-resources.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

function helperReply(stdout: string | Buffer = "", stderr = "", error: Error | null = null) {
  return (_file: string, _args: string[], options: { encoding?: string }, callback: (error: Error | null, stdout: Buffer | string, stderr: Buffer | string) => void) => {
    const bytes = typeof stdout === "string" ? Buffer.from(stdout) : stdout;
    if (options.encoding === "utf8") callback(error, bytes.toString("utf8"), stderr);
    else callback(error, bytes, Buffer.from(stderr));
  };
}

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
    mocks.execFile.mockImplementation(helperReply("\\Device\\Mup\\;LanmanRedirector\\server\\share\r\n"));
    await expect(queryDosDevice("Z:")).resolves.toBe("\\Device\\Mup\\;LanmanRedirector\\server\\share");
    expect(mocks.execFile).toHaveBeenCalledWith(
      join("/trusted/resources", "windows-path-kind", "x64", "ave-path-kind.exe"),
      ["Z:"],
      { windowsHide: true, timeout: 5000, encoding: "buffer" },
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

  it("rejects malformed UTF-8 in a drive mapping", async () => {
    const mapping = "\\Device\\HarddiskVolume-\ufffd";
    mocks.execFile.mockImplementationOnce(helperReply(`${mapping}\n`));
    await expect(queryDosDevice("C:")).resolves.toBe(mapping);
    mocks.execFile.mockImplementationOnce(helperReply(Buffer.concat([Buffer.from("\\Device\\HarddiskVolume-"), Buffer.from([0xff, 0x0a])])));
    await expect(queryDosDevice("C:")).rejects.toThrow(/encoding utf-8/i);
  });

  it("answers null when the OS has no mapping for the drive (exit 1), the one failure that is about the drive", async () => {
    mocks.execFile.mockImplementationOnce(helperReply("", "QueryDosDeviceW failed: 2\n", Object.assign(new Error("Command failed"), { code: 1 })));
    await expect(queryDosDevice("Q:")).resolves.toBeNull();
  });

  it("rejects a broken helper with its cause and what to do, never as an answer about the drive", async () => {
    const fail = (error: Error & { code?: number | string | null; killed?: boolean }, stdout = "", stderr = "") =>
      mocks.execFile.mockImplementationOnce(helperReply(stdout, stderr, error));
    fail(Object.assign(new Error("spawn EACCES"), { code: "EACCES" }));
    await expect(queryDosDevice("Q:")).rejects.toThrow(/classifier failed for Q:: spawn EACCES\. Reinstall Ave/u);
    fail(Object.assign(new Error("Command failed"), { code: 2 }), "", "usage: ave-path-kind.exe X:\n");
    await expect(queryDosDevice("Q:")).rejects.toThrow("usage: ave-path-kind.exe X:");
    fail(Object.assign(new Error("Command failed"), { code: 3 }), "", "could not write the mapping\n");
    await expect(queryDosDevice("Q:")).rejects.toThrow("could not write the mapping");
    fail(Object.assign(new Error("Command failed"), { code: null, killed: true }));
    await expect(queryDosDevice("Q:")).rejects.toThrow("did not answer within 5000 ms");
    mocks.execFile.mockImplementationOnce(helperReply());
    await expect(queryDosDevice("Q:")).rejects.toThrow("not one mapping");
    mocks.execFile.mockImplementationOnce(helperReply("a\nb\n"));
    await expect(queryDosDevice("Q:")).rejects.toThrow("not one mapping");
  });
});

describe("native Documents directory launcher", () => {
  beforeEach(() => {
    configureHostResources({ resourcePath: "/trusted/resources", isPackaged: true });
    mocks.execFile.mockReset();
    mocks.execFileSync.mockReset().mockReturnValue(Buffer.from("D:\\Documents\r\n"));
    mocks.existsSync.mockReset().mockReturnValue(true);
    vi.stubGlobal("process", { ...process, platform: "win32", arch: "x64" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lets the event loop run while the Documents helper stalls and settles on cancellation", async () => {
    const abort = new AbortController();
    mocks.execFile.mockImplementation((_file, _args, options, callback) => {
      options.signal.addEventListener("abort", () => callback(options.signal.reason, Buffer.alloc(0), Buffer.alloc(0)), { once: true });
    });
    const pending = Promise.resolve(queryWindowsDocumentsDirectory(abort.signal));
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    abort.abort(new Error("cancel Documents lookup"));
    await expect(pending).rejects.toThrow("cancel Documents lookup");
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
  });

  it("bounds the Documents lookup and rejects a helper timeout", async () => {
    mocks.execFile.mockImplementation(helperReply("", "", new Error("Documents helper timed out")));
    await expect(Promise.resolve(queryWindowsDocumentsDirectory())).rejects.toThrow("Documents helper timed out");
    expect(mocks.execFile).toHaveBeenCalledWith(expect.any(String), ["--documents-directory"], expect.objectContaining({
      timeout: expect.any(Number), windowsHide: true, encoding: "buffer",
    }), expect.any(Function));
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
    mocks.execFile.mockImplementation(helperReply("D:\\OperatingSystem\\System32\r\n"));
    await expect(queryWindowsSystemDirectory()).resolves.toBe("D:\\OperatingSystem\\System32");
    expect(mocks.execFile).toHaveBeenCalledWith(
      join("/trusted/resources", "windows-path-kind", "x64", "ave-path-kind.exe"),
      ["--system-directory"],
      { windowsHide: true, shell: false, env: {}, encoding: "buffer", timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs, maxBuffer: 128 * 1024 },
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

  it("rejects malformed UTF-8 in a system directory", async () => {
    const directory = "D:\\OperatingSystem-\ufffd\\System32";
    mocks.execFile.mockImplementationOnce(helperReply(`${directory}\n`));
    await expect(queryWindowsSystemDirectory()).resolves.toBe(directory);
    mocks.execFile.mockImplementationOnce(helperReply(Buffer.concat([Buffer.from("D:\\OperatingSystem-"), Buffer.from([0xff]), Buffer.from("\\System32\n")])));
    await expect(queryWindowsSystemDirectory()).rejects.toThrow(/encoding utf-8/i);
  });

  it("does not treat helper failure as a missing mapping or return an environment-derived directory", async () => {
    mocks.execFile.mockImplementation(helperReply("C:\\Windows\\System32\n", "", Object.assign(new Error("Fixture helper failed"), { code: 1 })));
    await expect(queryWindowsSystemDirectory()).rejects.toThrow("Windows system directory query failed");
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
  });

  it.each(["", "relative", "C:\\", "C:\\Windows\\..\\untrusted", "C:\\Windows\\System32\nD:\\Other", "\\\\server\\Windows\\System32", "C:\\Windows\\System32:alternate", "C:\\Windows\\System32\0"])("refuses a malformed simulated native answer %j", async (answer) => {
    mocks.execFile.mockImplementation(helperReply(answer));
    await expect(queryWindowsSystemDirectory()).rejects.toThrow("invalid path");
  });

  it("fails on unexpected native diagnostics even with a plausible path", async () => {
    mocks.execFile.mockImplementation(helperReply("C:\\Windows\\System32\n", "Unexpected native diagnostic"));
    await expect(queryWindowsSystemDirectory()).rejects.toThrow("query failed");
  });

  it.each([512, 513])("preserves verifier command headroom for a simulated %i-character system root", async (length) => {
    const root = `C:\\${"a".repeat(250)}\\${"b".repeat(250)}\\${"c".repeat(length - 505)}`;
    expect(root).toHaveLength(length);
    const directory = `${root}\\System32`;
    mocks.execFile.mockImplementation(helperReply(`${directory}\n`));
    if (length === 512) await expect(queryWindowsSystemDirectory()).resolves.toBe(directory);
    else await expect(queryWindowsSystemDirectory()).rejects.toThrow("invalid path");
  });
});
