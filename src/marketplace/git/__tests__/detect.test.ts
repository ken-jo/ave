import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  detectGitRuntime,
  type GitDetectionDeps,
  type ManagedGitInstall,
  nodeGitDetectionDeps,
  systemGitCandidates,
} from "../detect.js";
import { parseGitVersion } from "../git-version.js";

describe("parseGitVersion", () => {
  it.each([
    ["git version 2.38.1", "2.38.1", [2, 38, 1]],
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
      "/opt/homebrew/bin/git",
      "/usr/bin/git",
      "/usr/local/bin/git",
    ]);
    expect(systemGitCandidates("win32", 'C:\\Tools\\Git\\cmd;"C:\\Program Files\\Git\\cmd\\";.\\bin')).toEqual([
      "C:\\Tools\\Git\\cmd\\git.exe",
      "C:\\Program Files\\Git\\cmd\\git.exe",
    ]);
  });
});

function fakeDeps(overrides: Partial<GitDetectionDeps> & { versions: Record<string, string> }): GitDetectionDeps {
  return {
    platform: "linux",
    searchPath: "/a:/b",
    isExecutableFile: async (path) => path in overrides.versions,
    readVersion: async (path) => overrides.versions[path] ?? null,
    commandLineToolsInstalled: async () => true,
    findManagedGit: async () => null,
    ...overrides,
  };
}

const MANAGED: ManagedGitInstall = {
  path: "/home/u/.ave/runtime/git/2.53.0/bin/git",
  root: "/home/u/.ave/runtime/git/2.53.0",
  version: { major: 2, minor: 53, patch: 0, text: "2.53.0" },
};

describe("detectGitRuntime", () => {
  it("auto picks the first usable system git and remembers an older one it skipped", async () => {
    const detection = await detectGitRuntime(
      "auto",
      fakeDeps({ versions: { "/a/git": "git version 2.30.0", "/b/git": "git version 2.44.0" } }),
    );
    expect(detection).toMatchObject({
      state: "ready",
      git: { kind: "system", path: "/b/git" },
      systemTooOld: { path: "/a/git", version: "2.30.0" },
    });
  });

  it("auto falls back to the managed copy when the system git is too old", async () => {
    const detection = await detectGitRuntime(
      "auto",
      fakeDeps({ versions: { "/a/git": "git version 2.38.0" }, findManagedGit: async () => MANAGED }),
    );
    expect(detection).toMatchObject({
      state: "ready",
      git: { kind: "managed", path: MANAGED.path, managedRoot: MANAGED.root },
      systemTooOld: { path: "/a/git", version: "2.38.0" },
    });
  });

  it("auto reports missing when nothing is usable", async () => {
    expect(await detectGitRuntime("auto", fakeDeps({ versions: {} }))).toEqual({ state: "missing" });
  });

  it("system mode reports too-old instead of falling back", async () => {
    const detection = await detectGitRuntime(
      "system",
      fakeDeps({ versions: { "/a/git": "git version 2.38.0" }, findManagedGit: async () => MANAGED }),
    );
    expect(detection).toEqual({ state: "too-old", systemTooOld: { path: "/a/git", version: "2.38.0" } });
  });

  it("managed mode ignores the system git", async () => {
    const deps = fakeDeps({ versions: { "/a/git": "git version 2.44.0" } });
    expect(await detectGitRuntime("managed", deps)).toEqual({ state: "missing" });
    expect(await detectGitRuntime("managed", { ...deps, findManagedGit: async () => MANAGED })).toMatchObject({
      state: "ready",
      git: { kind: "managed" },
    });
  });

  it("never runs the macOS /usr/bin/git shim without the Command Line Tools", async () => {
    const ran: string[] = [];
    const deps = fakeDeps({
      platform: "darwin",
      searchPath: "/usr/bin",
      versions: { "/usr/bin/git": "git version 2.39.5 (Apple Git-154)" },
      commandLineToolsInstalled: async () => false,
      readVersion: async (path) => {
        ran.push(path);
        return "git version 2.39.5 (Apple Git-154)";
      },
    });
    expect(await detectGitRuntime("auto", deps)).toEqual({ state: "missing" });
    expect(ran).toEqual([]);
  });
});

describe("detectGitRuntime with real executables", () => {
  let dir: string;

  function fakeGit(name: string, version: string): string {
    const bin = join(dir, name);
    mkdirSync(bin, { recursive: true });
    const path = join(bin, "git");
    writeFileSync(path, `#!/bin/sh\necho "git version ${version}"\n`);
    chmodSync(path, 0o755);
    return bin;
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ave-fake-git-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.skipIf(process.platform === "win32")("refuses 2.38.0 and accepts 2.38.1", async () => {
    const old = fakeGit("old", "2.38.0");
    const ok = fakeGit("ok", "2.38.1");
    const inDir = (path: string) => path.startsWith(dir);
    const real = nodeGitDetectionDeps(async () => null);
    const deps: GitDetectionDeps = {
      ...real,
      platform: "linux",
      isExecutableFile: async (path) => inDir(path) && (await real.isExecutableFile(path)),
    };
    expect(await detectGitRuntime("system", { ...deps, searchPath: old })).toEqual({
      state: "too-old",
      systemTooOld: { path: join(old, "git"), version: "2.38.0" },
    });
    expect(await detectGitRuntime("system", { ...deps, searchPath: `${old}:${ok}` })).toMatchObject({
      state: "ready",
      git: { kind: "system", path: join(ok, "git"), version: { text: "2.38.1" } },
    });
  });
});
