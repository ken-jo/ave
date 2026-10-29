// Fixture builds cover missing or stale native launchers without invoking a toolchain.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hasCppBuildTools,
  missingBuildToolsMessage,
  prepareWindowsJob,
  windowsJobLauncherPath,
  windowsJobLauncherState,
  windowsJobSources,
} from "../../scripts/prepare-windows-job.mjs";

const roots: string[] = [];
const OLD = new Date("2026-01-01T00:00:00Z");
const NEW = new Date("2026-02-01T00:00:00Z");
const LAUNCHER = windowsJobLauncherPath("x64");
const PATH_KIND = join("resources", "windows-path-kind", "x64", "ave-path-kind.exe");

function write(root: string, relative: string, time: Date): void {
  mkdirSync(dirname(join(root, relative)), { recursive: true });
  writeFileSync(join(root, relative), relative);
  utimesSync(join(root, relative), time, time);
}

function fixtureRoot({ launcher }: { launcher?: Date } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "ave-windows-job-"));
  roots.push(root);
  for (const source of ["scripts/build-windows-job.ps1", "native/windows-job/launcher.cpp", "native/windows-job/README.md"]) {
    write(root, source, OLD);
  }
  write(root, "native/windows-path-kind/main.cpp", OLD);
  write(root, PATH_KIND, NEW);
  if (launcher) write(root, LAUNCHER, launcher);
  return root;
}

function buildStub(root: string, calls: string[][]) {
  return (command: string, args: string[]) => {
    calls.push([command, ...args]);
    write(root, args.includes("path-kind") ? PATH_KIND : LAUNCHER, new Date());
    return { status: 0 };
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("windowsJobLauncherState", () => {
  it("does nothing off Windows, even without a launcher", () => {
    expect(windowsJobLauncherState(fixtureRoot(), { platform: "linux", arch: "x64" }).state).toBe("skip");
  });

  it("reports a missing launcher", () => {
    expect(windowsJobLauncherState(fixtureRoot(), { platform: "win32", arch: "x64" })).toEqual({ state: "missing", launcher: LAUNCHER });
  });

  it("reports a launcher older than a nested source or the build script as stale", () => {
    const root = fixtureRoot({ launcher: NEW });
    write(root, "native/windows-job/include/job.h", new Date("2026-03-01T00:00:00Z"));
    expect(windowsJobSources(root)).toContain(join("native", "windows-job", "include", "job.h"));
    expect(windowsJobLauncherState(root, { platform: "win32", arch: "x64" }))
      .toEqual({ state: "stale", launcher: LAUNCHER, newer: join("native", "windows-job", "include", "job.h") });

    const scriptRoot = fixtureRoot({ launcher: NEW });
    write(scriptRoot, "scripts/build-windows-job.ps1", new Date("2026-03-01T00:00:00Z"));
    expect(windowsJobLauncherState(scriptRoot, { platform: "win32", arch: "x64" }).state).toBe("stale");
  });

  it("reports a launcher newer than every source as fresh", () => {
    expect(windowsJobLauncherState(fixtureRoot({ launcher: NEW }), { platform: "win32", arch: "x64" }).state).toBe("fresh");
  });

  it("looks for the launcher of the requested architecture", () => {
    const root = fixtureRoot({ launcher: NEW });
    expect(windowsJobLauncherState(root, { platform: "win32", arch: "arm64" }).state).toBe("missing");
  });
});

describe("prepareWindowsJob", () => {
  it("builds a missing launcher through build:windows-job for the host architecture", () => {
    const root = fixtureRoot();
    const calls: string[][] = [];
    const lines: string[] = [];
    const found = prepareWindowsJob({
      root, platform: "win32", arch: "x64", findBuildTools: () => true, runSync: buildStub(root, calls), log: (line) => lines.push(line),
    });
    expect(found.state).toBe("missing");
    expect(calls).toEqual([["bun.exe", "run", "build:windows-job", "-Arch", "x64"]]);
    expect(lines).toEqual([`[windows-job] building ${LAUNCHER} (missing)`, `[windows-path-kind] up to date: ${PATH_KIND}`]);
  });

  it("rebuilds a stale launcher and names the newer source", () => {
    const root = fixtureRoot({ launcher: OLD });
    write(root, "native/windows-job/launcher.cpp", NEW);
    const calls: string[][] = [];
    const lines: string[] = [];
    prepareWindowsJob({ root, platform: "win32", arch: "x64", findBuildTools: () => true, runSync: buildStub(root, calls), log: (line) => lines.push(line) });
    expect(calls).toHaveLength(1);
    expect(lines).toEqual([`[windows-job] building ${LAUNCHER} (older than ${join("native", "windows-job", "launcher.cpp")})`, `[windows-path-kind] up to date: ${PATH_KIND}`]);
  });

  it("skips a fresh launcher without looking for the build tools", () => {
    const root = fixtureRoot({ launcher: NEW });
    const calls: string[][] = [];
    const lines: string[] = [];
    const found = prepareWindowsJob({
      root, platform: "win32", arch: "x64",
      findBuildTools: () => { throw new Error("must not probe"); }, runSync: buildStub(root, calls), log: (line) => lines.push(line),
    });
    expect(found.state).toBe("fresh");
    expect(calls).toEqual([]);
    expect(lines).toEqual([`[windows-job] up to date: ${LAUNCHER}`, `[windows-path-kind] up to date: ${PATH_KIND}`]);
  });

  it("does nothing off Windows", () => {
    const root = fixtureRoot();
    const calls: string[][] = [];
    const lines: string[] = [];
    expect(prepareWindowsJob({ root, platform: "darwin", arch: "arm64", runSync: buildStub(root, calls), log: (line) => lines.push(line) }).state).toBe("skip");
    expect([calls, lines]).toEqual([[], []]);
  });

  it.each(["missing", "source", "script"])("prepares a path classifier with %s changes independently of the job launcher", (change) => {
    const root = fixtureRoot({ launcher: new Date("2026-04-01T00:00:00Z") });
    if (change === "missing") rmSync(join(root, PATH_KIND));
    else write(root, change === "script" ? "scripts/build-windows-job.ps1" : "native/windows-path-kind/include/path.h", new Date("2026-03-01T00:00:00Z"));
    const calls: string[][] = [];
    prepareWindowsJob({ root, platform: "win32", arch: "x64", findBuildTools: () => true, runSync: buildStub(root, calls), log: () => {} });
    expect(calls).toEqual([["bun.exe", "run", "build:windows-job", "--", "-Helper", "path-kind", "-Arch", "x64"]]);
  });

  it("refuses a missing path classifier without build tools or a successful build", () => {
    const root = fixtureRoot({ launcher: NEW });
    rmSync(join(root, PATH_KIND));
    const options = { root, platform: "win32" as const, arch: "x64", log: () => {} };
    expect(() => prepareWindowsJob({ ...options, findBuildTools: () => false }))
      .toThrow("run: bun run build:windows-job -- -Helper path-kind");
    expect(() => prepareWindowsJob({ ...options, findBuildTools: () => true, runSync: () => ({ status: 0 }) }))
      .toThrow(`did not produce an up-to-date ${PATH_KIND}`);
  });

  it("fails without the C++ build tools, naming the toolchain and the command, and does not build", () => {
    const root = fixtureRoot();
    const calls: string[][] = [];
    const run = () => prepareWindowsJob({ root, platform: "win32", arch: "x64", findBuildTools: () => false, runSync: buildStub(root, calls), log: () => {} });
    expect(run).toThrow(missingBuildToolsMessage(LAUNCHER));
    expect(missingBuildToolsMessage(LAUNCHER)).toContain("Visual Studio C++ build tools (MSVC");
    expect(missingBuildToolsMessage(LAUNCHER)).toMatch(/run: bun run build:windows-job$/);
    expect(calls).toEqual([]);
  });

  it("fails when the build fails or leaves no up-to-date launcher", () => {
    const root = fixtureRoot();
    const options = { root, platform: "win32" as const, arch: "x64", findBuildTools: () => true, log: () => {} };
    expect(() => prepareWindowsJob({ ...options, runSync: () => ({ status: 1 }) })).toThrow("bun run build:windows-job failed (exit 1)");
    expect(() => prepareWindowsJob({ ...options, runSync: () => ({ status: 0 }) })).toThrow("did not produce an up-to-date");
  });
});

describe("hasCppBuildTools", () => {
  const programFilesX86 = "C:\\Program Files (x86)";

  it("is false without vswhere or without an MSVC installation", () => {
    expect(hasCppBuildTools({ programFilesX86: "", runSync: () => { throw new Error("must not run"); } })).toBe(false);
    expect(hasCppBuildTools({ programFilesX86, exists: () => false, runSync: () => { throw new Error("must not run"); } })).toBe(false);
    expect(hasCppBuildTools({ programFilesX86, exists: () => true, runSync: () => ({ status: 0, stdout: "\r\n" }) })).toBe(false);
    expect(hasCppBuildTools({ programFilesX86, exists: () => true, runSync: () => ({ status: 1, stdout: "" }) })).toBe(false);
  });

  it("asks vswhere for the component build-windows-job.ps1 requires", () => {
    const calls: [string, string[]][] = [];
    expect(hasCppBuildTools({
      programFilesX86, exists: () => true,
      runSync: (command, args) => { calls.push([command, args]); return { status: 0, stdout: "C:\\VS\\BuildTools\r\n" }; },
    })).toBe(true);
    expect(calls[0][0]).toContain(join("Microsoft Visual Studio", "Installer", "vswhere.exe"));
    expect(calls[0][1]).toEqual(expect.arrayContaining(["-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"]));
    const buildScript = readFileSync(resolve("scripts/build-windows-job.ps1"), "utf8");
    expect(buildScript).toContain("-requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64");
  });
});

describe("Windows job launcher preparation wiring", () => {
  it("runs from test:prepare and from the hook tiers that call test:vitest directly", () => {
    const scripts = JSON.parse(readFileSync(resolve("package.json"), "utf8")).scripts;
    expect(scripts["test:prepare"]).toContain("node scripts/prepare-windows-job.mjs");
    const runner = readFileSync(resolve("scripts/hooks/run-local-checks.mjs"), "utf8");
    for (const [start, end] of [
      ["function runAppTargetedVitestChecks", "function runVitestWithReport"],
      ["function runAppFastSourceChecksHoldingSlot", "function runAppCommentOnlyChecks"],
    ]) {
      const segment = runner.slice(runner.indexOf(start), runner.indexOf(end));
      expect(segment.indexOf("ensureWindowsJobLauncher(dir);")).toBeGreaterThan(-1);
      expect(segment.indexOf("ensureWindowsJobLauncher(dir);")).toBeLessThan(segment.indexOf('"test:vitest"'));
    }
  });
});
