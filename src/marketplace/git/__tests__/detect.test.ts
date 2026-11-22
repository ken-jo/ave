import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { parseGitVersion } from "../../../shared/git-version.js";
import { systemGitCandidates } from "../../../shared/host-git-executable.js";
import { gitRuntimeStatus } from "../detect.js";

const probe = vi.hoisted(() => ({
  versions: new Map<string, string>(),
  calls: vi.fn<(file: string, args: readonly string[]) => string>(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile(file: string, args: readonly string[], _options: unknown,
    callback: (error: (Error & { code?: number }) | null, stdout: string) => void,
  ) {
    let output: string;
    try {
      output = probe.calls(file, args);
    } catch (error) {
      const code = (error as { status?: number }).status;
      callback(Object.assign(new Error("probe failed"), { code }), "");
      return {};
    }
    callback(null, output);
    return {};
  },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async access(file: string, mode?: number) {
      if (!probe.versions.has(file)) throw new Error("missing fixture");
      await actual.access(file, mode);
    },
  };
});

describe("parseGitVersion", () => {
  it.each([
    ["git version 2.45.1", "2.45.1", [2, 45, 1]],
    ["git version 2.39.5 (Apple Git-154)", "2.39.5 (Apple Git-154)", [2, 39, 5]],
    ["git version 2.45.1.windows.1\n", "2.45.1.windows.1", [2, 45, 1]],
    ["git version 3.0", "3.0", [3, 0, 0]],
  ] as const)("%j", (output, text, [major, minor, patch]) => {
    expect(parseGitVersion(output)).toEqual({ major, minor, patch, text });
  });

  it("returns null for anything else", () => {
    expect(parseGitVersion("hub version 2.14")).toBeNull();
    expect(parseGitVersion("")).toBeNull();
  });
});

describe("systemGitCandidates", () => {
  it("searches PATH in order, then the well-known locations, without duplicates", () => {
    expect(systemGitCandidates("darwin", "/opt/homebrew/bin:relative:/usr/bin")).toEqual([
      "/opt/homebrew/bin/git", "/usr/bin/git", "/usr/local/bin/git",
    ]);
    expect(systemGitCandidates("win32", 'C:\\Tools\\Git\\cmd;"C:\\Program Files\\Git\\cmd\\";.\\bin')).toEqual([
      "C:\\Tools\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\cmd\\git.exe",
    ]);
  });

  it("uses the explicit native executable name when searching Windows PATH", () => {
    const path = ";;.;bin;C:drive-relative;\\root-relative;C:\\Tools\\Git\\cmd";
    expect(systemGitCandidates("win32", path)).toEqual([
      "C:\\Tools\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\cmd\\git.exe",
    ]);
  });
});

describe("detectGitRuntime", () => {
  let root: string;
  let old: string;
  let supported: string;
  const executable = process.platform === "win32" ? "git.exe" : "git";

  beforeEach(() => {
    vi.resetModules();
    probe.calls.mockReset();
    root = mkdtempSync(join(tmpdir(), "ave-fake-git-"));
    old = mkdtempSync(join(root, "old-"));
    supported = mkdtempSync(join(root, "supported-"));
    for (const [dir, version] of [[old, "2.45.0"], [supported, "2.45.1"]] as const) {
      const path = join(dir, executable);
      writeFileSync(path, "fixture executable", { mode: 0o755 });
      probe.versions.set(path, version);
    }
    probe.calls.mockImplementation((file, args) => {
      const version = probe.versions.get(file);
      if (!version) throw new Error("unexpected probe");
      if (version === "2.45.0" && args.includes("--no-lazy-fetch")) {
        throw Object.assign(new Error("unknown option"), { status: 129 });
      }
      return `git version ${version}`;
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    probe.versions.clear();
    await cleanupTmpDir(root);
  });

  it("probes an absolute executable even when PATHEXT omits .EXE", async () => {
    vi.stubEnv("PATH", ["", ".", "project/bin", supported].join(delimiter));
    vi.stubEnv("PATHEXT", ".CMD;.BAT");
    const { detectGitRuntime } = await import("../detect.js");
    const path = join(supported, executable);
    expect(await detectGitRuntime(null)).toMatchObject({ state: "ready", git: { kind: "system", path } });
    expect(probe.calls.mock.calls.map(([file, args]) => [file, args])).toEqual([[path, ["--no-lazy-fetch", "--version"]]]);
  });

  it("reports an older Git and chooses a later one that supports the required option", async () => {
    vi.stubEnv("PATH", old);
    const { detectGitRuntime } = await import("../detect.js");
    const systemTooOld = { path: join(old, executable), version: "2.45.0" };
    expect(await detectGitRuntime(null)).toEqual({ state: "missing", systemTooOld });
    vi.stubEnv("PATH", [old, supported].join(delimiter));
    expect(await detectGitRuntime(null)).toMatchObject({
      state: "ready", git: { kind: "system", path: join(supported, executable) }, systemTooOld,
    });
  });

  it("keeps paths out of the renderer status", () => {
    expect(gitRuntimeStatus({ state: "missing", systemTooOld: { path: "/a/git", version: "2.45.0" } }, true))
      .toEqual({ state: "missing", active: null, systemTooOld: { version: "2.45.0" }, installerProvides: true });
  });
});
