import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, parse, win32 } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  accessSync: vi.fn(),
  existsSync: vi.fn(),
  statSync: vi.fn(),
}));

const root = parse(process.execPath).root;
const host = join(root, "host-bin");
const binary = process.platform === "win32" ? "git.exe" : "git";
const platform = process.platform;

function systemDirectoryReply(directory: string): ReturnType<typeof spawnSync> {
  const stdout = Buffer.from(directory + "\r\n");
  const stderr = Buffer.alloc(0);
  return { pid: 1, status: 0, signal: null, stdout, stderr, output: [null, stdout, stderr] };
}

describe("systemGitCandidates", () => {
  it("keeps semicolons inside quoted Windows PATH entries", async () => {
    const { systemGitCandidates } = await import("../host-git-executable.js");
    expect(systemGitCandidates("win32", `"D:\\Tools;Git\\cmd";'D:\\More;Tools\\Git';;D:\\Last`)).toEqual([
      "D:\\Tools;Git\\cmd\\git.exe",
      "D:\\More;Tools\\Git\\git.exe",
      "D:\\Last\\git.exe",
      "C:\\Program Files\\Git\\cmd\\git.exe",
    ]);
  });
});

describe("resolveHostGit", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv("PATHEXT", ".CMD;.EXE;.BAT");
    const { configureHostResources } = await import("../../main/host-resources.js");
    configureHostResources({ resourcePath: join(root, "host-resources"), isPackaged: true });
    vi.mocked(spawnSync).mockReturnValue(systemDirectoryReply("C:\\Windows\\System32"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setProcessPlatform(platform);
  });

  it("caches the selected executable, skipping a directory named like the binary", async () => {
    const other = join(root, "other-bin");
    vi.stubEnv("PATH", [other, host].join(delimiter));
    vi.mocked(statSync)
      .mockReturnValueOnce({ isFile: () => false } as ReturnType<typeof statSync>)
      .mockReturnValueOnce({ isFile: () => true } as ReturnType<typeof statSync>);
    const { resolveHostGit } = await import("../host-git-executable.js");

    expect(resolveHostGit({ packaged: false })?.path).toBe(join(host, binary));
    vi.stubEnv("PATH", join(root, "changed-bin"));
    expect(resolveHostGit({ packaged: false })?.path).toBe(join(host, binary));
    expect(vi.mocked(accessSync).mock.calls.map(([path]) => path)).toEqual([join(other, binary), join(host, binary)]);
  });

  it("ignores relative and empty PATH entries and discovers an executable after a miss", async () => {
    vi.stubEnv("PATH", ["", ".", "project/bin", "", " "].join(delimiter));
    vi.mocked(accessSync).mockImplementation(() => { throw new Error("missing"); });
    const { resolveHostGit, systemGitCandidates } = await import("../host-git-executable.js");

    expect(resolveHostGit({ packaged: false })).toBeNull();
    const fallbacks = systemGitCandidates(process.platform, undefined);
    expect(vi.mocked(accessSync).mock.calls.map(([path]) => path)).toEqual(fallbacks);
    vi.stubEnv("PATH", host);
    expect(resolveHostGit({ packaged: false })).toBeNull();
    expect(execFileSync).not.toHaveBeenCalled();
    vi.mocked(accessSync).mockReset();
    vi.mocked(statSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof statSync>);
    expect(resolveHostGit({ packaged: false })?.path).toBe(join(host, binary));
  });

  it("rejects Windows UNC and device PATH entries before filesystem probes", async () => {
    const { resolveHostGit } = await import("../host-git-executable.js");
    setProcessPlatform("win32");
    vi.stubEnv("PATH", '\\\\example\\share;"//example/share;tools";\\\\?\\D:\\Tools;D:\\Tools');
    vi.mocked(accessSync).mockImplementation(() => { throw new Error("missing"); });
    expect(resolveHostGit({ packaged: false })).toBeNull();
    expect(vi.mocked(accessSync).mock.calls.map(([path]) => path)).toEqual([
      "D:\\Tools\\git.exe", "C:\\Program Files\\Git\\cmd\\git.exe",
    ]);
    expect(statSync).not.toHaveBeenCalled();
    expect(existsSync).not.toHaveBeenCalled();
  });

  it.each(["available", "unlaunchable", "unverified"])("selects Windows Git when the bundle is %s", async (bundle) => {
    const { resolveHostGit } = await import("../host-git-executable.js");
    const originalExecPath = process.execPath;
    Object.defineProperty(process, "execPath", { value: join("C:/Ave", "Ave.exe") });
    setProcessPlatform("win32");
    vi.stubEnv("SystemRoot", "C:\\Windows");
    vi.stubEnv("PATH", "D:\\Tools\\Git\\cmd");
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof statSync>);
    if (bundle === "unverified") vi.mocked(spawnSync).mockReturnValue(systemDirectoryReply("relative"));
    const bundled = join("C:/Ave", "git", "cmd", "git.exe");
    const system = "D:\\Tools\\Git\\cmd\\git.exe";
    vi.mocked(execFileSync).mockImplementation((file) => {
      if (file === bundled && bundle === "unlaunchable") throw new Error("unlaunchable");
      return "git version 2.56.0";
    });
    try {
      const expected = bundle === "available" ? bundled : system;
      expect.soft(resolveHostGit({ packaged: true })?.path).toBe(expected);
      expect.soft(resolveHostGit({ packaged: true })?.path).toBe(expected);
      expect(vi.mocked(execFileSync).mock.calls.map(([file]) => file)).toEqual(bundle === "unverified" ? [] : [bundled]);
    } finally {
      Object.defineProperty(process, "execPath", { value: originalExecPath });
    }
  });

  it("uses the verified OS directory for both the bundled probe and project query", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const { setIsPackaged } = await import("../../boot/dev-flags.js");
    const { discoverDirectoryInstructions } = await import("../../memory/project-agents-md.js");
    const project = mkdtempSync(join(tmpdir(), "ave-git-query-"));
    const originalExecPath = process.execPath;
    const installRoot = join("C:/Ave", "git");
    const cwd = join(installRoot, "cmd");
    const bundled = join(cwd, "git.exe");
    const helper = join(root, "host-resources", "windows-path-kind", process.arch, "ave-path-kind.exe");
    const systemRoot = "D:\\OperatingSystem";
    const systemDirectory = win32.join(systemRoot, "System32");
    try {
      actual.mkdirSync(join(project, ".git"));
      actual.mkdirSync(join(project, "src"));
      actual.writeFileSync(join(project, "src", "AGENTS.md"), "project instructions");
      setIsPackaged(true);
      setProcessPlatform("win32");
      Object.defineProperty(process, "execPath", { value: join("C:/Ave", "Ave.exe") });
      vi.stubEnv("SystemRoot", "X:\\UntrustedRoot");
      vi.stubEnv("windir", "Y:\\UntrustedWindows");
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(statSync).mockImplementation((path) => path === bundled
        ? { isFile: () => true } as ReturnType<typeof statSync>
        : actual.statSync(path));
      vi.mocked(spawnSync).mockReturnValue(systemDirectoryReply(systemDirectory));
      vi.mocked(execFileSync).mockReturnValue("git version 2.56.0");

      expect(discoverDirectoryInstructions(project, join("src", "file.ts"), new Set(), { homeDir: project })).toEqual([]);
      const expectedOptions = {
        cwd,
        env: {
          PATH: [cwd, join(installRoot, "ucrt64", "bin"), join(installRoot, "usr", "bin"),
            systemDirectory, systemRoot].join(";"),
          SystemRoot: systemRoot,
          WINDIR: systemRoot,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "NUL",
          GIT_ALLOW_PROTOCOL: "",
        },
      };
      expect(execFileSync).toHaveBeenCalledTimes(2);
      expect.soft(execFileSync).toHaveBeenNthCalledWith(1, bundled, ["--no-lazy-fetch", "--version"], expect.objectContaining(expectedOptions));
      expect.soft(execFileSync).toHaveBeenNthCalledWith(2, bundled, expect.arrayContaining(["check-ignore"]), expect.objectContaining(expectedOptions));
      expect(spawnSync).toHaveBeenCalledExactlyOnceWith(helper, ["--system-directory"], expect.objectContaining({ env: {}, shell: false }));
    } finally {
      Object.defineProperty(process, "execPath", { value: originalExecPath });
      setProcessPlatform(platform);
      await cleanupTmpDir(project);
    }
  });

  it("runs the bundled probe with a host-owned environment and no trace output", async () => {
    const { resolveHostGit } = await import("../host-git-executable.js");
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const childProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(accessSync).mockImplementation(actual.accessSync);
    vi.mocked(statSync).mockImplementation(actual.statSync);
    const systemGit = resolveHostGit({ packaged: false });
    if (systemGit === null) throw new Error("The trace regression requires an installed Git");
    vi.resetModules();
    const { configureHostResources } = await import("../../main/host-resources.js");
    configureHostResources({ resourcePath: join(root, "host-resources"), isPackaged: true });

    const install = mkdtempSync(join(tmpdir(), "ave-git-probe-"));
    const trace = join(install, "trace.jsonl");
    const originalExecPath = process.execPath;
    const installRoot = join("C:/Ave", "git");
    const cwd = join(installRoot, "cmd");
    const safePath = process.env.PATH;
    try {
      const bundled = join(cwd, "git.exe");
      vi.mocked(accessSync).mockReset();
      vi.mocked(statSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof statSync>);
      vi.mocked(existsSync).mockReturnValue(true);
      setProcessPlatform("win32");
      Object.defineProperty(process, "execPath", { value: join("C:/Ave", "Ave.exe") });
      vi.stubEnv("SystemRoot", "C:\\Windows");
      vi.stubEnv("PATH", "D:\\untrusted;\\\\example\\share");
      vi.stubEnv("GIT_TRACE2_EVENT", trace);
      vi.stubEnv("GIT_TRACE", trace);
      vi.stubEnv("Git_Exec_Path", join(install, "other"));
      vi.mocked(execFileSync).mockImplementation((_file, _args, options) => {
        // Exercise the child environment on any installed version.
        return childProcess.execFileSync(systemGit.path, ["--version"], {
          ...options,
          cwd: install,
          env: options?.env ?? { ...process.env, PATH: safePath },
          encoding: "utf8",
        });
      });
      const { resolveHostGit: discover } = await import("../host-git-executable.js");
      const selected = discover({ packaged: true });
      expect.soft(actual.existsSync(trace)).toBe(false);
      const expectedOptions = {
        cwd,
        env: {
          PATH: [cwd, join(installRoot, "ucrt64", "bin"), join(installRoot, "usr", "bin"),
            win32.join("C:\\Windows", "System32"), "C:\\Windows"].join(";"),
          SystemRoot: "C:\\Windows",
          WINDIR: "C:\\Windows",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "NUL",
          GIT_ALLOW_PROTOCOL: "",
        },
      };
      expect(selected?.path).toBe(bundled);
      expect(Object.keys(selected?.options.env ?? {}).sort()).toEqual(Object.keys(expectedOptions.env).sort());
      expect(selected?.options).toEqual(expectedOptions);
      expect(execFileSync).toHaveBeenCalledWith(bundled, ["--no-lazy-fetch", "--version"], expect.objectContaining(expectedOptions));
    } finally {
      Object.defineProperty(process, "execPath", { value: originalExecPath });
      setProcessPlatform(platform);
      await cleanupTmpDir(install);
    }
  });
});
