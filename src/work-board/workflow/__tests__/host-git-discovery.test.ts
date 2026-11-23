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
  vi.doUnmock("../../../shared/host-git-executable.js");
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

  it("a packaged Windows app starts the git it bundles, absolute, in the call's folder, on the search path its discovery probed it with and the user's own configuration", async () => {
    setProcessPlatform("win32");
    Object.defineProperty(process, "execPath", { value: "C:\\Program Files\\Ave\\Ave.exe" });
    const bundled = "C:\\Program Files\\Ave\\git\\cmd\\git.exe";
    const searchPath = "C:\\Program Files\\Ave\\git\\cmd;C:\\Program Files\\Ave\\git\\ucrt64\\bin;C:\\Windows\\System32;C:\\Windows";
    const roots: (string | null)[] = [];
    vi.doMock("../../../boot/dev-flags.js", async (original) => ({ ...await original<typeof import("../../../boot/dev-flags.js")>(), isConfigured: () => true, getIsPackaged: () => true }));
    vi.doMock("../../../shared/host-git-executable.js", async (original) => {
      const real = await original<typeof import("../../../shared/host-git-executable.js")>();
      return {
        ...real,
        withHostGitRecovery: async <T>(root: string | null, use: (discovery: import("../../../shared/host-git-executable.js").GitDiscovery) => Promise<T>): Promise<T> => {
          roots.push(root);
          return use({ git: {
            path: bundled, version: { major: 2, minor: 56, patch: 0, text: "2.56.0" },
            options: { cwd: dirname(bundled), env: { PATH: searchPath, SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL", GIT_ALLOW_PROTOCOL: "" } },
            installer: { path: bundled, root: "C:\\Program Files\\Ave\\git", prefix: "ucrt64", systemDirectory: "C:\\Windows\\System32", systemRoot: "C:\\Windows" },
          } } as import("../../../shared/host-git-executable.js").GitDiscovery);
        },
      };
    });
    vi.mocked(spawn).mockImplementation((() => ended(0, "git version 2.56.0\n")) as unknown as typeof spawn);
    const { createHostGit } = await import("../host-git.js");
    const userConfig = "C:\\Users\\alice\\.gitconfig";
    await createHostGit({ env: { Path: "C:\\Users\\alice\\bin", SystemRoot: "C:\\Elsewhere", GIT_CONFIG_GLOBAL: userConfig } }).run("D:\\project", ["--version"]);
    expect(roots).toEqual([join(dirname(process.execPath), "git")]);
    expect(started()).toEqual([bundled]);
    const options = vi.mocked(spawn).mock.calls[0]?.[2] as { cwd?: string; env?: NodeJS.ProcessEnv };
    expect(options.cwd).toBe("D:\\project");
    expect(options.env).toMatchObject({ PATH: searchPath, SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", GIT_CONFIG_GLOBAL: userConfig });
    expect(Object.keys(options.env ?? {}).filter(key => key.toUpperCase() === "PATH")).toEqual(["PATH"]);
  });
});
