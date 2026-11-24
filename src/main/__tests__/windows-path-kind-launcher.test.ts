import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), execFileSync: vi.fn(), existsSync: vi.fn(), access: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile, execFileSync: mocks.execFileSync }));
vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }));
vi.mock("node:fs/promises", () => ({ access: mocks.access }));
vi.mock("../../shared/tool-timeout-policy.js", async original => {
  const actual = await original<typeof import("../../shared/tool-timeout-policy.js")>();
  return { ...actual, TOOL_TIMEOUT_POLICY: { ...actual.TOOL_TIMEOUT_POLICY, windowsPathKindQueryMs: 300 } };
});
import { isWindowsPathKindHelperUnavailable, queryDosDevice, queryWindowsDocumentsDirectory, queryWindowsSystemDirectory, resolveWindowsPathKindHelper, windowsSystemDirectorySpawnOptions } from "../windows-path-kind-launcher.js";
import { sleepingHelper } from "../../__tests__/support/sleeping-helper.js";
import { configureHostResources } from "../host-resources.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

// The real spawn of a helper that never answers, under the caller's own deadline.
function sleepingReply() {
  return async (_file: string, _args: string[], options: { timeout: number }, callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void) => {
    const { execFile } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const sleeper = sleepingHelper();
    execFile(sleeper.file, sleeper.args, { timeout: options.timeout, windowsHide: true, encoding: "buffer" }, (error, stdout, stderr) => callback(error, stdout, stderr));
  };
}

async function unavailable(query: Promise<unknown>, message: string): Promise<void> {
  const error = await query.then(() => undefined, (failure: unknown) => failure as NodeJS.ErrnoException);
  expect(error).toMatchObject({ message, code: "ETIMEDOUT" });
  expect(isWindowsPathKindHelperUnavailable(error)).toBe(true);
  expect(error?.message).not.toContain("Reinstall");
  expect(error?.message).not.toContain(sleepingHelper().file);
}

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
      { windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.windowsPathKindQueryMs, encoding: "buffer" },
      expect.any(Function),
    );
  });

  it("fails clearly without the asset, off Windows, or for anything but a drive, and never runs a command", async () => {
    mocks.existsSync.mockReturnValue(false);
    // Unavailable, yet with no file-system code: a missing helper says nothing about the folder being read. Its install path stays out
    // of the message, which reaches the privacy failure reason, the boot gate and the audit log.
    const missing = await queryDosDevice("C:").catch((error: unknown) => error as Error);
    expect(missing.message).toBe("Windows folder classifier is missing. Ave cannot tell whether a drive is on another computer, "
      + "so it reads no folder on a drive. Restart Ave; if it persists, reinstall Ave.");
    expect(isWindowsPathKindHelperUnavailable(missing)).toBe(true);
    expect(missing).not.toHaveProperty("code");
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

  it("names a helper that does not answer within the policy bound as unavailable, with no reinstall advice", async () => {
    mocks.execFile.mockImplementationOnce(sleepingReply());
    await unavailable(queryDosDevice("Q:"), "the Windows folder classifier for Q: did not answer within 300 ms");
  });

  it("answers null when the OS has no mapping for the drive (exit 1), the one failure that is about the drive", async () => {
    mocks.execFile.mockImplementationOnce(helperReply("", "QueryDosDeviceW failed: 2\n", Object.assign(new Error("Command failed"), { code: 1 })));
    await expect(queryDosDevice("Q:")).resolves.toBeNull();
  });

  it("rejects a broken helper with its cause and what to do, never as an answer about the drive", async () => {
    const fail = (error: Error & { code?: number | string | null; killed?: boolean }, stdout = "", stderr = "") =>
      mocks.execFile.mockImplementationOnce(helperReply(stdout, stderr, error));
    const helper = join("/trusted/resources", "windows-path-kind", "x64", "ave-path-kind.exe");
    const rejection = (): Promise<Error> => queryDosDevice("Q:").then(() => { throw new Error("resolved"); }, (error: unknown) => error as Error);
    // A helper that could not start gave no answer: unavailable, restart wording, no path and no file-system code.
    fail(Object.assign(new Error(`spawn ${helper} EACCES`), { code: "EACCES", syscall: `spawn ${helper}`, path: helper }));
    const launch = await rejection();
    expect(launch.message).toBe("the Windows folder classifier for Q: could not start (EACCES). Restart Ave; if it persists, reinstall Ave.");
    expect(isWindowsPathKindHelperUnavailable(launch)).toBe(true);
    expect(launch).not.toHaveProperty("code");
    expect(launch).not.toHaveProperty("cause");
    fail(Object.assign(new Error(`Command failed: ${helper} Q:\nusage: ave-path-kind.exe X:`), { code: 2 }), "", "usage: ave-path-kind.exe X:\n");
    await expect(queryDosDevice("Q:")).rejects.toThrow("usage: ave-path-kind.exe X:");
    fail(Object.assign(new Error(`Command failed: ${helper} Q:`), { code: 3 }), "", "could not write the mapping\n");
    await expect(queryDosDevice("Q:")).rejects.toThrow("could not write the mapping");
    // With nothing on stderr the exit status stands in for the spawn message, which names the install path.
    fail(Object.assign(new Error(`Command failed: ${helper} Q:`), { code: 4 }));
    const exit = await rejection();
    expect(exit.message).toBe("the Windows folder classifier failed for Q: (exit 4). Reinstall Ave; in a development checkout, build it with scripts/build-windows-job.ps1 -Helper path-kind.");
    expect(isWindowsPathKindHelperUnavailable(exit)).toBe(false);
    expect(exit).not.toHaveProperty("cause");
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

  it("names a Documents helper that does not answer within the policy bound as unavailable", async () => {
    mocks.execFile.mockImplementationOnce(sleepingReply());
    await unavailable(Promise.resolve(queryWindowsDocumentsDirectory()), "The Windows Documents lookup did not answer within 300 ms");
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
    mocks.access.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("process", { ...process, platform: "win32", arch: "x64" });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("simulates the OS answer through the packaged helper with no inherited environment", async () => {
    vi.stubEnv("SystemRoot", "Z:\\untrusted");
    vi.stubEnv("WINDIR", "Y:\\untrusted");
    vi.stubEnv("ANTHROPIC_API_KEY", "parent-secret");
    mocks.execFile.mockImplementation(helperReply("D:\\OperatingSystem\\System32\r\n"));
    await expect(queryWindowsSystemDirectory()).resolves.toBe("D:\\OperatingSystem\\System32");
    const helper = join("/trusted/resources", "windows-path-kind", "x64", "ave-path-kind.exe");
    expect(mocks.execFile).toHaveBeenCalledWith(
      helper,
      ["--system-directory"],
      { ...windowsSystemDirectorySpawnOptions(helper), encoding: "buffer", timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs },
      expect.any(Function),
    );
  });

  it("refuses missing helpers and unsupported platforms without another lookup", async () => {
    mocks.access.mockRejectedValueOnce(new Error("missing"));
    await expect(queryWindowsSystemDirectory()).rejects.toThrow("classifier is missing");
    vi.stubGlobal("process", { ...process, platform: "linux" });
    await expect(queryWindowsSystemDirectory()).rejects.toThrow("requires Windows");
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("names a system directory helper that does not answer within the caller's bound as unavailable", async () => {
    mocks.execFile.mockImplementationOnce(sleepingReply());
    await unavailable(queryWindowsSystemDirectory(300), "The Windows system directory query did not answer within 300 ms");
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
