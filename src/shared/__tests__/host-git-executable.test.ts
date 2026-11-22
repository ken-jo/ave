import { accessSync, statSync } from "node:fs";
import { delimiter, join, parse } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  accessSync: vi.fn(),
  statSync: vi.fn(),
}));

const root = parse(process.execPath).root;
const host = join(root, "host-bin");
const binary = process.platform === "win32" ? "git.exe" : "git";

describe("resolveHostGit", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv("PATHEXT", ".CMD;.EXE;.BAT");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("caches the selected executable, skipping a directory named like the binary", async () => {
    const other = join(root, "other-bin");
    vi.stubEnv("PATH", [other, host].join(delimiter));
    vi.mocked(statSync)
      .mockReturnValueOnce({ isFile: () => false } as ReturnType<typeof statSync>)
      .mockReturnValueOnce({ isFile: () => true } as ReturnType<typeof statSync>);
    const { resolveHostGit } = await import("../host-git-executable.js");

    expect(resolveHostGit(false)).toBe(join(host, binary));
    vi.stubEnv("PATH", join(root, "changed-bin"));
    expect(resolveHostGit(false)).toBe(join(host, binary));
    expect(vi.mocked(accessSync).mock.calls.map(([path]) => path)).toEqual([join(other, binary), join(host, binary)]);
  });

  it("ignores relative and empty PATH entries and caches a refusal when no Git exists", async () => {
    vi.stubEnv("PATH", ["", ".", "project/bin", "", " "].join(delimiter));
    vi.mocked(accessSync).mockImplementation(() => { throw new Error("missing"); });
    const { resolveHostGit, systemGitCandidates } = await import("../host-git-executable.js");

    expect(resolveHostGit(false)).toBeNull();
    const fallbacks = systemGitCandidates(process.platform, undefined);
    expect(vi.mocked(accessSync).mock.calls.map(([path]) => path)).toEqual(fallbacks);
    vi.stubEnv("PATH", host);
    vi.mocked(accessSync).mockReset();
    expect(resolveHostGit(false)).toBeNull();
    expect(accessSync).not.toHaveBeenCalled();
  });
});
