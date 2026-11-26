import { accessSync, existsSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { dirname, join, win32 } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProcessPlatform } from "../../../__tests__/support/process-platform.js";

vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: vi.fn() }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), accessSync: vi.fn(), existsSync: vi.fn(), statSync: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(),
  async access(path: string, mode?: number) {
    if (mode !== undefined) return accessSync(path, mode);
    if (!existsSync(path)) throw new Error("missing");
  },
  stat: async (path: string) => statSync(path, { bigint: true }),
}));

const platform = process.platform;
const execPath = process.execPath;

/** A process that writes `stdout` and ends with `code`. */
function ended(code: number, stdout = ""): ReturnType<typeof spawn> {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  queueMicrotask(() => {
    if (stdout !== "") child.stdout.emit("data", Buffer.from(stdout));
    child.emit("exit", code);
    child.emit("close", code);
  });
  return child as unknown as ReturnType<typeof spawn>;
}
const started = (): string[] => vi.mocked(spawn).mock.calls.map(([program]) => String(program));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
});
afterEach(() => {
  setProcessPlatform(platform);
  Object.defineProperty(process, "execPath", { value: execPath });
  vi.unstubAllEnvs();
  vi.doUnmock("../../../main/windows-path-kind-launcher.js");
  vi.doUnmock("../../../boot/dev-flags.js");
  vi.doUnmock("node:path");
});

describe("the git a stage workspace starts is the one the host's discovery resolved", () => {
  it.each([true, false])("selects a later macOS Git only if it passes the hook floor (passes: %s)", async (passes) => {
    setProcessPlatform("darwin");
    const first = "/fixture-first/git";
    const second = "/fixture-second/git";
    const workspace = tmpdir();
    vi.stubEnv("PATH", [dirname(first), dirname(second)].join(":"));
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(accessSync).mockImplementation((path) => {
      if (path !== first && path !== second) throw new Error("missing");
    });
    vi.mocked(existsSync).mockImplementation(fs.existsSync);
    vi.mocked(statSync).mockImplementation(((path: string) => {
      if (path !== first && path !== second) return fs.statSync(path);
      return { isFile: () => true, dev: 1n, ino: path === first ? 1n : 2n, size: 1n, mtimeNs: 1n };
    }) as typeof statSync);
    vi.mocked(spawn).mockImplementation(((program: string, args: string[], options: { cwd?: string }) => {
      if (args.includes("--version")) return ended(0, `git version ${program === first ? "2.54.0" : "2.56.0"}\n`);
      if (args.includes("--allow-unknown-hook-name")) {
        if (options.cwd === undefined) throw new Error("Missing hook probe directory");
        writeFileSync(join(options.cwd, "ran"), "ran");
      }
      if (args.at(-1) === "applypatch-msg" && (program === first || !passes)) return ended(3);
      return ended(0);
    }) as typeof spawn);
    const { createHostGit } = await import("../host-git.js");
    const { discoverHostGitAsync } = await import("../../../shared/host-git-executable.js");
    const git = createHostGit();

    expect((await discoverHostGitAsync(null)).git?.path).toBe(first);
    expect(await git.floorHolds()).toBe(passes);
    const operation = git.run(workspace, ["worktree", "add", "--no-checkout", "fixture", "main"], { requiresFloor: true });
    if (passes) await expect(operation).resolves.toMatchObject({ code: 0 });
    else await expect(operation).rejects.toMatchObject({ reason: "unavailable" });
    const workspaceCalls = vi.mocked(spawn).mock.calls.filter(([, , options]) => options?.cwd === workspace);
    expect(workspaceCalls.map(([program]) => program)).toEqual(passes ? [second] : []);
    expect((await discoverHostGitAsync(null)).git?.path).toBe(first);
  });

  it("does not run a floor-dependent repository operation on an unproven replacement after a launch failure", async () => {
    setProcessPlatform("linux");
    const first = "/fixture-first/git";
    const replacement = "/fixture-second/git";
    const workspace = tmpdir();
    vi.stubEnv("PATH", [dirname(first), dirname(replacement)].join(":"));
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(accessSync).mockImplementation((path) => {
      if (path !== first && path !== replacement) throw new Error("missing");
    });
    vi.mocked(existsSync).mockImplementation(fs.existsSync);
    vi.mocked(statSync).mockImplementation(((path: string) => {
      if (path !== first && path !== replacement) return fs.statSync(path);
      return { isFile: () => true, dev: 1n, ino: path === first ? 1n : 2n, size: 1n, mtimeNs: 1n, mtimeMs: 1 };
    }) as typeof statSync);
    vi.mocked(spawn).mockImplementation(((program: string, args: string[], options: { cwd?: string }) => {
      if (args.includes("--version")) return ended(0, `git version ${program === first ? "2.56.0" : "2.45.1"}\n`);
      if (args.includes("init")) return ended(0);
      if (args.includes("--allow-unknown-hook-name")) {
        if (program === replacement) return ended(129);
        if (options.cwd === undefined) throw new Error("Missing hook probe directory");
        writeFileSync(join(options.cwd, "ran"), "ran");
      }
      if (program === first && args.includes("worktree")) {
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("error", Object.assign(new Error("unavailable image"), { code: "EACCES", path: first })));
        return Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      }
      return ended(0);
    }) as typeof spawn);
    const { createHostGit } = await import("../host-git.js");
    const git = createHostGit();

    expect(await git.floorHolds()).toBe(true);
    await expect.soft(git.run(workspace, ["worktree", "add", "--no-checkout", "fixture", "main"], { requiresFloor: true }))
      .rejects.toMatchObject({ reason: "unavailable" });
    const calls = vi.mocked(spawn).mock.calls;
    expect(calls.some(([program, args]) => program === first && args?.includes("worktree"))).toBe(true);
    expect(calls.some(([program, args]) => program === replacement && args?.includes("--version"))).toBe(true);
    expect(calls.filter(([program, , options]) => program === replacement && options?.cwd === workspace)).toEqual([]);
  });

  it.each(["before selection", "after selection"] as const)("refuses a same-path, same-mtime Git replacement %s", async (timing) => {
    setProcessPlatform("linux");
    const program = "/fixture/git";
    const workspace = tmpdir();
    vi.stubEnv("PATH", dirname(program));
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let ino = 1n;
    let replaceAfterStat = false;
    let replacementProbes = 0;
    let workspaceStarts = 0;
    vi.mocked(accessSync).mockImplementation((path) => { if (path !== program) throw new Error("missing"); });
    vi.mocked(existsSync).mockImplementation(fs.existsSync);
    vi.mocked(statSync).mockImplementation(((path: string) => {
      if (path !== program) return fs.statSync(path);
      const result = { isFile: () => true, dev: 1n, ino, size: 1n, mtimeNs: 1n, mtimeMs: 1 };
      if (replaceAfterStat) { replaceAfterStat = false; ino = 2n; }
      return result;
    }) as typeof statSync);
    vi.mocked(spawn).mockImplementation(((file: string, args: string[], options: { cwd?: string }) => {
      if (file !== program) throw new Error("Unexpected Git executable");
      if (args.includes("--version")) return ended(0, "git version 2.56.0\n");
      if (args.includes("--allow-unknown-hook-name")) {
        if (ino === 2n) { replacementProbes += 1; return ended(129); }
        if (options.cwd === undefined) throw new Error("Missing hook probe directory");
        writeFileSync(join(options.cwd, "ran"), "ran");
      }
      if (args.includes("worktree")) workspaceStarts += 1;
      return ended(0);
    }) as typeof spawn);
    const { createHostGit } = await import("../host-git.js");
    const git = createHostGit();
    expect(await git.floorHolds()).toBe(true);

    if (timing === "before selection") ino = 2n;
    else replaceAfterStat = true;

    await expect.soft(git.run(workspace, ["worktree", "add", "--no-checkout", "fixture", "main"], { requiresFloor: true }))
      .rejects.toMatchObject({ reason: "unavailable" });
    expect(workspaceStarts).toBe(0);
    expect(replacementProbes).toBe(timing === "before selection" ? 1 : 0);
  });

  it("on macOS without the command line tools the system shim is not started: the call is refused and nothing but the tools check runs", async () => {
    setProcessPlatform("darwin");
    vi.stubEnv("PATH", "/usr/bin");
    vi.mocked(accessSync).mockImplementation((file) => { if (file !== "/usr/bin/git") throw new Error("missing"); });
    vi.mocked(statSync).mockImplementation(() => ({ isFile: () => true, isDirectory: () => false, dev: 1n, ino: 1n, size: 1n, mtimeNs: 1n }) as unknown as ReturnType<typeof statSync>);
    vi.mocked(spawn).mockImplementation(((program: string) => ended(program === "/usr/bin/xcode-select" ? 1 : 0, "git version 2.56.0\n")) as unknown as typeof spawn);
    const { createHostGit, HostGitError } = await import("../host-git.js");
    const git = createHostGit({ env: { PATH: "/usr/bin" } });
    const refused = await git.run("/project", ["status"]).then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(HostGitError);
    expect((refused as InstanceType<typeof HostGitError>).reason).toBe("unavailable");
    expect(await git.floorHolds()).toBe(false);
    expect(started().filter(program => program !== "/usr/bin/xcode-select")).toEqual([]);
  });

  it("a packaged Windows app starts the git its discovery selects from the bundle, absolute, in the call's folder, on the search path it probed it with and the user's own configuration", async () => {
    setProcessPlatform("win32");
    // The host's paths are Windows paths on every host the test runs on, as they are for the app it stands for.
    vi.doMock("node:path", async (original) => {
      const actual = await original<typeof import("node:path")>();
      return { ...actual, ...actual.win32, default: actual.win32, posix: actual.posix, win32: actual.win32 };
    });
    Object.defineProperty(process, "execPath", { value: win32.join("C:/Ave", "Ave.exe") });
    const root = win32.join("C:/Ave", "git");
    const bundled = win32.join(root, "cmd", "git.exe");
    const searchPath = [win32.dirname(bundled), win32.join(root, "ucrt64", "bin"), win32.join(root, "usr", "bin"), "C:\\Windows\\System32", "C:\\Windows"].join(";");
    vi.doMock("../../../boot/dev-flags.js", async (original) => ({ ...await original<typeof import("../../../boot/dev-flags.js")>(), isConfigured: () => true, getIsPackaged: () => true }));
    // The helper that names the system folder is a native program; everything else is the host's own discovery.
    vi.doMock("../../../main/windows-path-kind-launcher.js", async (original) => ({
      ...await original<typeof import("../../../main/windows-path-kind-launcher.js")>(),
      queryWindowsSystemDirectory: async () => "C:\\Windows\\System32",
      queryWindowsSystemDirectorySync: () => "C:\\Windows\\System32",
    }));
    vi.mocked(existsSync).mockImplementation((path) => path === win32.join(root, "ucrt64", "libexec", "git-core"));
    vi.mocked(statSync).mockImplementation(((path: string) => ({ isFile: () => path === bundled, isDirectory: () => path === "D:\\project", dev: 1n, ino: 1n, size: 1n, mtimeNs: 1n })) as unknown as typeof statSync);
    vi.mocked(spawn).mockImplementation((() => ended(0, "git version 2.56.0\n")) as unknown as typeof spawn);
    const { createHostGit } = await import("../host-git.js");
    const userConfig = "C:\\Users\\alice\\.gitconfig";
    await createHostGit({ env: { Path: "C:\\Users\\alice\\bin", SystemRoot: "C:\\Elsewhere", GIT_CONFIG_GLOBAL: userConfig } }).run("D:\\project", ["--version"]);
    // The discovery's probe of the bundle, then the call.
    expect(started()).toEqual([bundled, bundled]);
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({ cwd: win32.dirname(bundled), env: { PATH: searchPath, GIT_CONFIG_GLOBAL: "NUL" } });
    const options = vi.mocked(spawn).mock.calls[1]?.[2] as { cwd?: string; env?: NodeJS.ProcessEnv };
    expect(options.cwd).toBe("D:\\project");
    expect(options.env).toMatchObject({ PATH: searchPath, SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", GIT_CONFIG_GLOBAL: userConfig });
    expect(Object.keys(options.env ?? {}).filter(key => key.toUpperCase() === "PATH")).toEqual(["PATH"]);
  });
});
