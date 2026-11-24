import childProcess, { execFileSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import { access, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path, { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifiedDocumentEngineInstallation } from "../../main/document-engine-installation.js";
import { LibreOfficeSessionPool } from "../../observation/libreoffice-process.js";
import { configureHostResources } from "../../main/host-resources.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { deferred } from "../../__tests__/support/deferred.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  access: vi.fn(async () => {}),
}));
vi.mock("../asrt-sandbox.js", () => ({
  isOfflineProcessConfinementActive: vi.fn(() => true),
  getDefaultSensitiveReadDenyPaths: () => ["/private-service-secrets"],
  getDefaultSensitiveWriteDenyEntries: () => ["/private-service-control"],
  buildPerCommandSandboxCustomConfig: vi.fn(policy => ({ filesystem: policy })),
}));
vi.mock("../sandbox-capability.js", () => ({ detectSandboxCapability: vi.fn(() => ({
  kind: "asrt", confidence: "verified", confines: { filesystem: true, process: true, network: true },
})) }));
vi.mock("../../main/codex-executable-location.js", () => ({
  assertCodexExecutableLocation: vi.fn(async () => {}),
  createPrivateTempDirectory: () => mkdtemp(join(root, "session-")),
}));
vi.mock("../../main/windows-job-launcher.js", async (original) => ({
  ...await original<typeof import("../../main/windows-job-launcher.js")>(),
  resolveWindowsJobLauncher: () => join(HOST_CWD, "resources", "windows-job", process.arch, "ave-job.exe"),
}));
vi.mock("../macos-sandbox-wrap.js", () => ({ hardenMacSandboxGitMetadata: (value: { argv: string[]; env: NodeJS.ProcessEnv }) => value }));
vi.mock("../linux-sandbox-wrap.js", () => ({ hardenLinuxSandboxWrap: (value: { argv: string[]; env: NodeJS.ProcessEnv }) => value }));
vi.mock("@anthropic-ai/sandbox-runtime", () => ({ SandboxManager: { getConfig: () => ({
  bwrapPath: "/usr/local/bin/bwrap", ripgrep: { command: "/usr/local/bin/rg" },
}) } }));
vi.mock("@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js", () => ({
  wrapCommandWithSandboxMacOS: vi.fn(() => "confined-native-command"),
}));
vi.mock("@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js", () => ({
  wrapCommandWithSandboxLinux: vi.fn(async () => "bwrap --disable-userns --unshare-net -- /bin/sh -c command"),
  cleanupBwrapMountPoints: vi.fn(),
}));

import { wrapOfflineProcess } from "../offline-process-sandbox.js";
import { isOfflineProcessConfinementActive, buildPerCommandSandboxCustomConfig } from "../asrt-sandbox.js";
import { detectSandboxCapability } from "../sandbox-capability.js";
import { parseSandboxWrappedWords } from "../sandbox-wrapped-command.js";
import { assertCodexExecutableLocation } from "../../main/codex-executable-location.js";
import { wrapCommandWithSandboxMacOS } from "@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";
import { wrapCommandWithSandboxLinux, cleanupBwrapMountPoints } from "@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js";

const registration = vi.hoisted(() => ({ refuse: false }));
vi.mock("../../main/process-group-reaper.js", async (original) => {
  const actual = await original<typeof import("../../main/process-group-reaper.js")>();
  return { ...actual, createProcessGroupReaper: (...args: Parameters<typeof actual.createProcessGroupReaper>) => {
    const reaper = actual.createProcessGroupReaper(...args);
    return { ...reaper, retain: (pgid: number) => {
      if (registration.refuse) throw new Error("Injected scanner registration failure");
      reaper.retain(pgid);
    } };
  } };
});

const HOST_PLATFORM = process.platform;
const HOST_CWD = process.cwd();
const LINUX_WRAPPER = "bwrap --disable-userns --unshare-net -- /bin/sh -c command";
let linuxWrapper: string;
let root: string;
let runtime: string;
let input: string;
let output: string;
let ipc: string;

function request() {
  return { command: join(runtime, "engine"), args: ["--headless"], runtimeDirectories: [runtime],
    inputDirectory: input, outputDirectory: output, ipcDirectory: ipc,
    env: { HOME: output, SAL_USE_VCLPLUGIN: "svp", PATH: "/usr/bin:/bin" }, signal: new AbortController().signal };
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(access).mockReset();
  vi.mocked(assertCodexExecutableLocation).mockReset();
  vi.mocked(isOfflineProcessConfinementActive).mockReturnValue(true);
  vi.mocked(detectSandboxCapability).mockReturnValue({ kind: "asrt", confidence: "verified", platform: HOST_PLATFORM,
    reason: "native test boundary", confines: { filesystem: true, process: true, network: true } });
  linuxWrapper = LINUX_WRAPPER;
  vi.mocked(wrapCommandWithSandboxLinux).mockImplementation(async ({ ripgrepConfig, abortSignal }) => {
    if (!ripgrepConfig?.run || !abortSignal) throw new Error("Expected a managed scanner.");
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementationOnce(() => scanChild("", 1));
    syncBuiltinESMExports();
    try {
      await ripgrepConfig.run(ripgrepConfig.command, ["--files", root], abortSignal, TOOL_TIMEOUT_POLICY.processTreeKillMs);
      return linuxWrapper;
    } finally {
      spawn.mockRestore();
      syncBuiltinESMExports();
    }
  });
  vi.mocked(cleanupBwrapMountPoints).mockReset();
  root = await realpath(await mkdtemp(join(tmpdir(), "offline-process-policy-")));
  runtime = join(root, "runtime"); input = join(root, "input"); output = join(root, "output"); ipc = join(output, "ipc");
  await Promise.all([mkdir(runtime), mkdir(input), mkdir(ipc, { recursive: true })]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  setProcessPlatform(HOST_PLATFORM);
  process.chdir(HOST_CWD);
  await rm(root, { recursive: true, force: true });
});

async function useNativeLinuxBuilder() {
  if (HOST_PLATFORM === "win32") configureHostResources({ resourcePath: join(HOST_CWD, "resources"), isPackaged: false });
  const actual = await vi.importActual<typeof import("@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js")>(
    "@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js",
  );
  const fixture = join(root, "system-executable");
  await writeFile(fixture, "", { mode: 0o755 });
  const { statSync } = fs;
  vi.spyOn(fs, "statSync").mockImplementation(((candidate, options) =>
    statSync(candidate === "/usr/bin/bwrap" ? fixture : candidate, options)
  ) as typeof statSync);
  vi.spyOn(childProcess, "spawnSync").mockImplementation((command) => {
    const stdout = command === "which" ? "/bin/sh" : "--disable-userns";
    return { pid: 1, status: 0, signal: null, output: [null, stdout, ""], stdout, stderr: "" };
  });
  vi.mocked(wrapCommandWithSandboxLinux).mockImplementation(async config => {
    // Ave routes as Linux; the builder resolves the fixture on the actual host filesystem.
    setProcessPlatform(HOST_PLATFORM);
    try {
      return await actual.wrapCommandWithSandboxLinux(config);
    } finally {
      setProcessPlatform("linux");
    }
  });
  vi.mocked(cleanupBwrapMountPoints).mockImplementation(actual.cleanupBwrapMountPoints);
  process.chdir(root);
  setProcessPlatform("linux");
  syncBuiltinESMExports();
}

function scanChild(stdout: string, outcome: number | Error): ChildProcess {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  queueMicrotask(() => {
    child.stdout.end(stdout);
    child.stderr.end();
    if (outcome instanceof Error) child.emit("error", outcome);
    else child.emit("close", outcome);
  });
  return child as unknown as ChildProcess;
}

describe("offline process confinement", () => {
  it("hands the native profile no IP proxy exceptions and only its private local socket directory", async () => {
    setProcessPlatform("darwin");
    const wrapped = await wrapOfflineProcess(request());
    const native = vi.mocked(wrapCommandWithSandboxMacOS).mock.calls[0][0];
    expect(native).toMatchObject({ needsNetworkRestriction: true, allowUnixSockets: [ipc],
      allowAllUnixSockets: false, allowLocalBinding: false, allowAppleEvents: false });
    expect(native.httpProxyPort).toBeUndefined();
    expect(native.socksProxyPort).toBeUndefined();
    expect(native.readConfig?.denyOnly).toContain("/");
    expect(native.readConfig?.literalAllowWithinDeny).toContain(runtime);
    expect(native.writeConfig?.allowOnly).toEqual([output]);
    expect(native.writeConfig?.allowOnly).not.toContain(input);
    expect(native.writeConfig?.denyWithinAllow).toContain("/private-service-control");
    expect(buildPerCommandSandboxCustomConfig).toHaveBeenCalledWith(expect.objectContaining({ pinWriteRoots: true }));
    expect(wrapped.env.HOME).toBe(output);
    expect(wrapped.env.SAL_USE_VCLPLUGIN).toBe("svp");
  });

  it("passes the engine its original argv when the executable pathname contains an equals sign", async () => {
    const command = join(runtime, "engine=version");
    const args = ["--headless", "a b", "", 'file="$name";'];
    await writeFile(command, "#!/bin/sh\nprintf '%s\\000' \"$@\"\n", { mode: 0o755 });
    setProcessPlatform("darwin");
    await wrapOfflineProcess({ ...request(), command, args });
    const launcher = vi.mocked(wrapCommandWithSandboxMacOS).mock.calls[0][0].command;
    setProcessPlatform(HOST_PLATFORM);

    const words = parseSandboxWrappedWords(launcher).map(word => word.value);
    expect(words).toEqual(["/usr/bin/env", `TMPDIR=${output}`, `TMP=${output}`, `TEMP=${output}`,
      "/bin/sh", "-c", 'exec "$@"', "offline-process", command, ...args]);
    if (HOST_PLATFORM !== "win32") {
      const received = execFileSync("/bin/sh", ["-c", launcher], { encoding: "utf8" });
      expect(received).toBe(`${args.join("\0")}\0`);
    }
  });

  it("uses an isolated network namespace with no bridge and releases native mount ownership once", async () => {
    setProcessPlatform("linux");
    const wrapped = await wrapOfflineProcess(request());
    expect(wrapCommandWithSandboxLinux).toHaveBeenCalledWith(expect.objectContaining({
      needsNetworkRestriction: true, allowAllUnixSockets: true, allowNestedUserNamespaces: false,
      bwrapPath: "/usr/bin/bwrap", enableWeakerNestedSandbox: false,
    }));
    const native = vi.mocked(wrapCommandWithSandboxLinux).mock.calls[0][0];
    expect(native.ripgrepConfig?.command).toBe("/usr/bin/rg");
    expect(native.httpSocketPath).toBeUndefined();
    expect(native.socksSocketPath).toBeUndefined();
    wrapped.release(); wrapped.release();
    expect(cleanupBwrapMountPoints).toHaveBeenCalledTimes(1);
  });

  it.each(["relative", ""])("pins the pre-wrap scan with a competing rg on PATH entry %j", async (entry) => {
    const competingDirectory = join(root, entry);
    await mkdir(competingDirectory, { recursive: true });
    await writeFile(join(competingDirectory, "rg"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const actual = await vi.importActual<typeof import("@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js")>(
      "@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js",
    );
    vi.mocked(wrapCommandWithSandboxLinux).mockImplementation(actual.wrapCommandWithSandboxLinux);
    const controller = new AbortController();
    const stop = new Error("Stop after observing the scan executable");
    const previousCwd = process.cwd();
    process.chdir(root);
    vi.stubEnv("PATH", `${entry}:/usr/bin`);
    setProcessPlatform("linux");
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      controller.abort(stop);
      throw stop;
    });
    syncBuiltinESMExports();
    try {
      await expect(wrapOfflineProcess({ ...request(), signal: controller.signal })).rejects.toBe(stop);
      expect(spawn).toHaveBeenCalledExactlyOnceWith("/usr/bin/rg", expect.arrayContaining(["--files", root]), expect.any(Object));
    } finally {
      spawn.mockRestore();
      syncBuiltinESMExports();
      setProcessPlatform(HOST_PLATFORM);
      vi.unstubAllEnvs();
      process.chdir(previousCwd);
    }
  });

  it.each([false, true])("requires real scanner exit confirmation before cancellation settles (missing stream close: %s)", async (withholdClose) => {
    await useNativeLinuxBuilder();
    const scanner = join(root, "scan-fixture.cjs");
    await writeFile(scanner, 'console.log(process.pid); setInterval(() => {}, 1000);');
    const nativeSpawn = childProcess.spawn;
    const launched = deferred<ChildProcess>();
    const nativeClose = deferred<void>();
    const controller = new AbortController();
    const reason = new Error("Stop the running scanner");
    let closed = false;
    let exited = false;
    vi.spyOn(childProcess, "spawn").mockImplementation((command, args, options) => {
      const job = Array.isArray(args) && args[0] === "--receipt";
      if (!job && command !== "/usr/bin/rg") return nativeSpawn(command, args, options);
      if (!Array.isArray(args)) throw new Error("Expected scan arguments.");
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
      const child = job
        ? nativeSpawn(command, [...args.slice(0, 2), process.execPath, scanner], { ...options, env })
        : nativeSpawn(process.execPath, [scanner], { ...options, env });
      if (withholdClose) {
        const emit = child.emit;
        vi.spyOn(child, "emit").mockImplementation((event, ...values) => {
          if (event !== "close") return Reflect.apply(emit, child, [event, ...values]);
          nativeClose.resolve();
          return true;
        });
      }
      child.once("exit", () => { exited = true; });
      child.once("close", () => { closed = true; nativeClose.resolve(); });
      launched.resolve(child);
      return child;
    });
    syncBuiltinESMExports();
    if (withholdClose) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const wrap = wrapOfflineProcess({ ...request(), signal: controller.signal });
    const settlement = wrap.catch(error => error);
    try {
      const child = await Promise.race([launched.promise, settlement.then(error => { throw error; })]);
      const pid = await new Promise<number>((resolve, reject) => {
        child.stdout?.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
        child.once("error", reject);
        void nativeClose.promise.then(() => reject(new Error("Scanner exited before announcing its pid.")));
      });
      expect(pid).toBeGreaterThan(1);
      expect(process.kill(pid, 0)).toBe(true);
      const scratch = (await fs.promises.readdir(root)).find(name => name.startsWith(".offline-scan-"));
      expect(scratch).toBeDefined();
      controller.abort(reason);

      if (withholdClose) await nativeClose.promise;
      if (withholdClose && HOST_PLATFORM === "win32") {
        await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.windowsProcessTreeKillMs);
      }
      if (withholdClose && HOST_PLATFORM !== "win32") {
        await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.processTreeKillMs);
        expect(await settlement).toMatchObject({
          code: "engine-confinement-unavailable", message: "Offline scanner termination was not confirmed.",
        });
        expect(await fs.promises.readdir(root)).toContain(scratch);
      } else {
        expect(await settlement).toBe(reason);
        expect(HOST_PLATFORM === "win32" ? exited : closed).toBe(true);
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
        expect(await fs.promises.readdir(root)).not.toContain(scratch);
      }
    } finally {
      controller.abort(reason);
      if (await Promise.race([launched.promise.then(() => true), settlement.then(() => false)])) await nativeClose.promise;
      vi.useRealTimers();
    }
  });

  it("retains scan scratch when registration fails after acquiring a live group", async () => {
    setProcessPlatform("linux");
    registration.refuse = true;
    const child = Object.assign(new EventEmitter(), { pid: 14001, spawnfile: "/usr/bin/rg", exitCode: null, signalCode: null });
    const spawned = deferred<void>();
    const nativeKill = process.kill;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (Math.abs(pid) === child.pid) {
        if (signal === 0) return true;
        throw Object.assign(new Error("Injected group kill failure"), { code: "EPERM" });
      }
      return nativeKill(pid, signal);
    });
    vi.mocked(wrapCommandWithSandboxLinux).mockImplementation(async ({ ripgrepConfig, abortSignal }) => {
      if (!ripgrepConfig?.run || !abortSignal) throw new Error("Expected the managed scanner.");
      await ripgrepConfig.run(ripgrepConfig.command, [], abortSignal, TOOL_TIMEOUT_POLICY.processTreeKillMs);
      return LINUX_WRAPPER;
    });
    vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      spawned.resolve();
      return child as unknown as ChildProcess;
    });
    syncBuiltinESMExports();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const controller = new AbortController();
    const settlement = wrapOfflineProcess({ ...request(), signal: controller.signal }).catch((error: unknown) => error);
    try {
      await spawned.promise;
      controller.abort(new Error("Stopped after spawn"));
      await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.processTreeKillMs);
      expect(await settlement).toMatchObject({
        code: "engine-confinement-unavailable", message: "Offline scanner termination was not confirmed.",
      });
      expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
      expect(await fs.promises.readdir(root)).toEqual(expect.arrayContaining([expect.stringMatching(/^\.offline-scan-/u)]));
    } finally {
      kill.mockImplementation((pid, signal) => {
        if (Math.abs(pid) === child.pid) throw Object.assign(new Error("Group exited"), { code: "ESRCH" });
        return nativeKill(pid, signal);
      });
      child.emit("close", null, "SIGKILL");
      registration.refuse = false;
      vi.useRealTimers();
    }
  });

  it("keeps the session runtime after a scanner exits without a job receipt", async () => {
    setProcessPlatform("linux");
    vi.mocked(wrapCommandWithSandboxLinux).mockImplementation(async ({ ripgrepConfig, abortSignal }) => {
      if (!ripgrepConfig?.run || !abortSignal) throw new Error("Expected the managed scanner.");
      setProcessPlatform("win32");
      try {
        await ripgrepConfig.run(ripgrepConfig.command, [], abortSignal, TOOL_TIMEOUT_POLICY.processTreeKillMs);
        return LINUX_WRAPPER;
      } finally {
        setProcessPlatform("linux");
      }
    });
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => scanChild("", 1));
    syncBuiltinESMExports();
    const installation: VerifiedDocumentEngineInstallation = {
      root: runtime, executable: join(runtime, "engine"), unopkg: join(runtime, "installer"), version: "fixture",
      extensionPath: join(runtime, "extension"), extensionSha256: "0".repeat(64),
      assertCurrent: vi.fn(), verifyBeforeSpawn: vi.fn(async () => {}),
    };
    const pool = new LibreOfficeSessionPool();
    const signal = new AbortController().signal;
    try {
      await expect(pool.prepare(installation, "scan-session", "docx", signal)).rejects.toMatchObject({
        code: "engine-confinement-unavailable", message: "Offline scanner termination was not confirmed.",
      });
      expect(spawn).toHaveBeenCalledExactlyOnceWith(expect.any(String),
        ["--receipt", expect.any(String), "/usr/bin/rg"], expect.any(Object));
      const receipt = spawn.mock.calls[0]?.[1]?.[1];
      if (typeof receipt !== "string") throw new Error("Expected a scanner receipt path.");
      expect(await fs.promises.readFile(receipt, "utf8")).toBe("");
      await expect(pool.prepare(installation, "scan-session", "docx", signal)).rejects.toMatchObject({
        code: "engine-confinement-unavailable",
      });
      await expect(pool.releaseSession("scan-session")).rejects.toMatchObject({ code: "engine-confinement-unavailable" });
      expect(await fs.promises.readFile(receipt, "utf8")).toBe("");
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      await pool.dispose().catch(() => {});
    }
  });

  it.each([
    ["spawn error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })],
    ["launcher exit", 127],
    ["partial scan", 2],
  ] as const)("refuses setup when the preflighted scan has a %s", async (_description, outcome) => {
    await useNativeLinuxBuilder();
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation((_command, args) => {
      if (HOST_PLATFORM === "win32" && Array.isArray(args) && typeof outcome === "number") {
        fs.writeFileSync(args[1], "0");
      }
      const partialResult = outcome === 2 ? `${join(output, ".bashrc")}\n` : "";
      return scanChild(partialResult, outcome);
    });
    syncBuiltinESMExports();

    await expect(wrapOfflineProcess(request())).rejects.toMatchObject({ code: "engine-confinement-unavailable" });
    expect(assertCodexExecutableLocation).toHaveBeenCalledWith("/usr/bin/rg");
    expect(access).toHaveBeenCalledWith("/usr/bin/rg", expect.any(Number));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(await fs.promises.readdir(root)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^\.offline-scan-/u)]));
    expect(cleanupBwrapMountPoints).toHaveBeenCalledTimes(1);
  });

  it("keeps a discovered write deny in the wrapper after a complete scan", async () => {
    const denied = join(output, "nested", ".bashrc");
    await mkdir(join(output, "nested"));
    await writeFile(denied, "");
    if (HOST_PLATFORM === "win32") {
      // Keep the POSIX ancestor walk bounded and exercise matching with an exact write allow.
      const driveRoot = path.parse(root).root;
      const { dirname } = path;
      vi.spyOn(path, "dirname").mockImplementation(candidate => candidate === driveRoot ? "/" : dirname(candidate));
      vi.mocked(buildPerCommandSandboxCustomConfig).mockImplementationOnce(policy => ({
        filesystem: {
          allowRead: [...(policy?.allowRead ?? [])],
          allowWrite: [...(policy?.allowWrite ?? []), denied],
          denyRead: [...(policy?.denyRead ?? [])],
          denyWrite: [...(policy?.denyWrite ?? [])],
        },
      }));
    }
    const scanner = join(root, "scan-fixture");
    await writeFile(scanner, "#!/bin/sh\nprintf '%s\\n' output/nested/.bashrc\n", { mode: 0o755 });
    await useNativeLinuxBuilder();
    const nativeSpawn = childProcess.spawn;
    vi.spyOn(childProcess, "spawn").mockImplementation((command, args, options) => {
      if (!Array.isArray(args)) throw new Error("Expected scan arguments.");
      if (HOST_PLATFORM !== "win32") {
        return nativeSpawn(command === "/usr/bin/rg" ? scanner : command, args, options);
      }
      fs.writeFileSync(args[1], "0");
      return scanChild(`${denied}\n`, 0);
    });
    syncBuiltinESMExports();

    const wrapped = await wrapOfflineProcess(request());
    try {
      const words = parseSandboxWrappedWords(wrapped.argv[2]).map(word => word.value);
      expect(words).toContain(denied);
      expect(words.some((word, index) => word === "--ro-bind" && words[index + 1] === denied && words[index + 2] === denied)).toBe(true);
      expect(await fs.promises.readdir(root)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^\.offline-scan-/u)]));
    } finally {
      wrapped.release();
    }
  });

  it.each(["ENOENT", "EACCES"])("refuses offline setup when the fixed scan helper fails with %s", async (code) => {
    setProcessPlatform("linux");
    const failure = Object.assign(new Error(code), { code });
    if (code === "ENOENT") {
      vi.mocked(assertCodexExecutableLocation).mockImplementation(async (candidate) => {
        if (candidate === "/usr/bin/rg") throw failure;
      });
    } else {
      vi.mocked(access).mockRejectedValue(failure);
    }
    await expect(wrapOfflineProcess(request())).rejects.toMatchObject({
      code: "engine-confinement-unavailable",
      message: expect.stringContaining("/usr/bin/rg"),
    });
    expect(wrapCommandWithSandboxLinux).not.toHaveBeenCalled();
  });

  it("refuses a local-IPC backend that cannot disable new namespaces", async () => {
    setProcessPlatform("linux");
    linuxWrapper = "bwrap --unshare-net -- /bin/sh -c command";
    await expect(wrapOfflineProcess(request())).rejects.toMatchObject({
      code: "engine-confinement-unavailable", message: expect.stringContaining("namespace creation"),
    });
    expect(cleanupBwrapMountPoints).toHaveBeenCalledTimes(1);
  });

  it("requires verified filesystem, process and network confinement without a host fallback", async () => {
    vi.mocked(detectSandboxCapability).mockReturnValue({ kind: "asrt", confidence: "verified", platform: HOST_PLATFORM,
      reason: "partial substrate", confines: { filesystem: true, process: false, network: true } });
    await expect(wrapOfflineProcess(request())).rejects.toMatchObject({ code: "engine-confinement-unavailable" });
    expect(wrapCommandWithSandboxMacOS).not.toHaveBeenCalled();
    expect(wrapCommandWithSandboxLinux).not.toHaveBeenCalled();
  });

  it("rejects an input writable through the output root or an executable outside its authenticated closure", async () => {
    setProcessPlatform("darwin");
    await expect(wrapOfflineProcess({ ...request(), inputDirectory: output })).rejects.toThrow("overlap");
    await expect(wrapOfflineProcess({ ...request(), command: "/usr/local/bin/engine" })).rejects.toThrow("authenticated runtime");
    expect(wrapCommandWithSandboxMacOS).not.toHaveBeenCalled();
  });

  it("leaves the strict offline service unavailable on an unsupported platform", async () => {
    setProcessPlatform("win32");
    await expect(wrapOfflineProcess(request())).rejects.toMatchObject({ code: "engine-confinement-unavailable" });
  });
});
