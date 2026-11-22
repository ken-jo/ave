import { execFileSync } from "node:child_process";
import { accessSync, existsSync, statSync } from "node:fs";
import { delimiter, join, parse } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFileSync: vi.fn(),
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

describe("resolveHostGit", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv("PATHEXT", ".CMD;.EXE;.BAT");
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

    expect(resolveHostGit({ packaged: false })).toBe(join(host, binary));
    vi.stubEnv("PATH", join(root, "changed-bin"));
    expect(resolveHostGit({ packaged: false })).toBe(join(host, binary));
    expect(vi.mocked(accessSync).mock.calls.map(([path]) => path)).toEqual([join(other, binary), join(host, binary)]);
  });

  it("ignores relative and empty PATH entries and caches a refusal when no Git exists", async () => {
    vi.stubEnv("PATH", ["", ".", "project/bin", "", " "].join(delimiter));
    vi.mocked(accessSync).mockImplementation(() => { throw new Error("missing"); });
    const { resolveHostGit, systemGitCandidates } = await import("../host-git-executable.js");

    expect(resolveHostGit({ packaged: false })).toBeNull();
    const fallbacks = systemGitCandidates(process.platform, undefined);
    expect(vi.mocked(accessSync).mock.calls.map(([path]) => path)).toEqual(fallbacks);
    vi.stubEnv("PATH", host);
    vi.mocked(accessSync).mockReset();
    expect(resolveHostGit({ packaged: false })).toBeNull();
    expect(accessSync).not.toHaveBeenCalled();
  });

  it.each([true, false])("uses the bundled Windows executable only when it runs (%s)", async (launchable) => {
    const { resolveHostGit } = await import("../host-git-executable.js");
    const originalExecPath = process.execPath;
    Object.defineProperty(process, "execPath", { value: join("C:/Ave", "Ave.exe") });
    setProcessPlatform("win32");
    vi.stubEnv("PATH", "D:\\Tools\\Git\\cmd");
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof statSync>);
    const bundled = join("C:/Ave", "git", "cmd", "git.exe");
    const system = "D:\\Tools\\Git\\cmd\\git.exe";
    vi.mocked(execFileSync).mockImplementation((file) => {
      if (file === bundled && !launchable) throw new Error("unlaunchable");
      return "git version 2.56.0";
    });
    try {
      expect(resolveHostGit({ packaged: true })).toBe(launchable ? bundled : system);
      expect(resolveHostGit({ packaged: true })).toBe(launchable ? bundled : system);
      expect(vi.mocked(execFileSync).mock.calls.map(([file]) => file)).toEqual([bundled]);
    } finally {
      Object.defineProperty(process, "execPath", { value: originalExecPath });
    }
  });
});
