import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitRuntimeMode } from "../../../shared/git-runtime-mode.js";
import type { GitRuntimeProgress } from "../../../shared/git-runtime.js";
import type { GitDetectionDeps, ManagedGitInstall } from "../detect.js";
import { GitRuntimeService } from "../runtime-service.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ave-git-runtime-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Detection over a fake machine: `versions` maps an executable path to its `--version` output. */
function fakeDeps(versions: Record<string, string>) {
  return (findManagedGit: () => Promise<ManagedGitInstall | null>): GitDetectionDeps => ({
    platform: "linux",
    searchPath: "/usr/bin",
    isExecutableFile: async (path) => path in versions,
    readVersion: async (path) => versions[path] ?? null,
    commandLineToolsInstalled: async () => true,
    findManagedGit,
  });
}

function installMarker(version: string): void {
  const dir = join(root, version);
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "git"), "");
  writeFileSync(join(dir, ".ave-ready.json"), JSON.stringify({ version }));
}

function service(options: { mode?: GitRuntimeMode; versions?: Record<string, string>; progress?: GitRuntimeProgress[] } = {}) {
  return new GitRuntimeService({
    runtimeRoot: root,
    mode: () => options.mode ?? "auto",
    download: async () => {
      throw new Error("no network in this test (via http://alice:proxy-canary@proxy.corp:8080)");
    },
    onProgress: (progress) => options.progress?.push(progress),
    platform: "linux",
    arch: "x64",
    pins: { version: "2.53.0", assets: { "linux-x64": { url: "https://example.invalid/git.tar.gz", sha256: "0".repeat(64), size: 1 } } },
    detectionDeps: fakeDeps(options.versions ?? {}),
  });
}

describe("GitRuntimeService.status", () => {
  it("reports a usable system git as active", async () => {
    const status = await service({ versions: { "/usr/bin/git": "git version 2.50.1" } }).status();
    expect(status).toEqual({
      mode: "auto",
      state: "ready",
      active: { kind: "system", version: "2.50.1", path: "/usr/bin/git" },
      systemTooOld: null,
      managed: { version: "2.53.0", installed: false, available: true, size: 1 },
      lastInstallError: null,
    });
  });

  it("falls back to the managed copy when the system git is too old, and says so", async () => {
    installMarker("2.53.0");
    const status = await service({ versions: { "/usr/bin/git": "git version 2.34.1" } }).status();
    expect(status.state).toBe("ready");
    expect(status.active).toEqual({ kind: "managed", version: "2.53.0", path: join(root, "2.53.0", "bin", "git") });
    expect(status.systemTooOld).toEqual({ path: "/usr/bin/git", version: "2.34.1" });
    expect(status.managed.installed).toBe(true);
  });

  it("follows the configured mode", async () => {
    expect((await service({ mode: "system", versions: { "/usr/bin/git": "git version 2.34.1" } }).status()).state).toBe("too-old");
    expect((await service({ mode: "managed", versions: { "/usr/bin/git": "git version 2.50.1" } }).status()).state).toBe("missing");
  });
});

describe("GitRuntimeService.install", () => {
  it("records a failed install in the status instead of throwing", async () => {
    const progress: GitRuntimeProgress[] = [];
    const status = await service({ progress }).install();
    expect(status.lastInstallError).toMatchObject({ code: "GIT_RUNTIME_INSTALL_FAILED", detail: { reason: "downloading" } });
    // The status crosses to the renderer: its message goes scrubbed.
    expect(status.lastInstallError!.message).toContain("no network in this test (via http://[REDACTED:CREDENTIALS]@proxy.corp:8080)");
    expect(progress[progress.length - 1]).toMatchObject({ phase: "failed", code: "GIT_RUNTIME_INSTALL_FAILED" });
    expect(status.managed.installed).toBe(false);
  });

  it("clears the last failure once an install succeeds", async () => {
    const runtime = service();
    expect((await runtime.install()).lastInstallError).not.toBeNull();
    installMarker("2.53.0");
    const status = await runtime.install();
    expect(status.lastInstallError).toBeNull();
    expect(status.managed.installed).toBe(true);
  });
});
