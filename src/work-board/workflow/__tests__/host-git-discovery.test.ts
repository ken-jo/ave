// windows-native: the Windows job runs this file from config/windows-native-tests.txt.
import { accessSync, existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
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
});

describe("the git a stage workspace starts is the one the host's discovery resolved", () => {
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
    Object.defineProperty(process, "execPath", { value: join("C:/Ave", "Ave.exe") });
    const root = join("C:/Ave", "git");
    const bundled = join(root, "cmd", "git.exe");
    const searchPath = [dirname(bundled), join(root, "ucrt64", "bin"), join(root, "usr", "bin"), "C:\\Windows\\System32", "C:\\Windows"].join(";");
    vi.doMock("../../../boot/dev-flags.js", async (original) => ({ ...await original<typeof import("../../../boot/dev-flags.js")>(), isConfigured: () => true, getIsPackaged: () => true }));
    // The helper that names the system folder is a native program; everything else is the host's own discovery.
    vi.doMock("../../../main/windows-path-kind-launcher.js", async (original) => ({
      ...await original<typeof import("../../../main/windows-path-kind-launcher.js")>(),
      queryWindowsSystemDirectory: async () => "C:\\Windows\\System32",
      queryWindowsSystemDirectorySync: () => "C:\\Windows\\System32",
    }));
    vi.mocked(existsSync).mockImplementation((path) => path === join(root, "ucrt64", "libexec", "git-core"));
    vi.mocked(statSync).mockImplementation(((path: string) => ({ isFile: () => path === bundled, isDirectory: () => path === "D:\\project", dev: 1n, ino: 1n, size: 1n, mtimeNs: 1n })) as unknown as typeof statSync);
    vi.mocked(spawn).mockImplementation((() => ended(0, "git version 2.56.0\n")) as unknown as typeof spawn);
    const { createHostGit } = await import("../host-git.js");
    const userConfig = "C:\\Users\\alice\\.gitconfig";
    await createHostGit({ env: { Path: "C:\\Users\\alice\\bin", SystemRoot: "C:\\Elsewhere", GIT_CONFIG_GLOBAL: userConfig } }).run("D:\\project", ["--version"]);
    // The discovery's probe of the bundle, then the call.
    expect(started()).toEqual([bundled, bundled]);
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({ cwd: dirname(bundled), env: { PATH: searchPath, GIT_CONFIG_GLOBAL: "NUL" } });
    const options = vi.mocked(spawn).mock.calls[1]?.[2] as { cwd?: string; env?: NodeJS.ProcessEnv };
    expect(options.cwd).toBe("D:\\project");
    expect(options.env).toMatchObject({ PATH: searchPath, SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", GIT_CONFIG_GLOBAL: userConfig });
    expect(Object.keys(options.env ?? {}).filter(key => key.toUpperCase() === "PATH")).toEqual(["PATH"]);
  });
});
