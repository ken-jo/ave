// Fixture builds cover a missing or stale macOS download file helper without invoking a toolchain.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMacosDirOps, MACOS_DIR_OPS_EXECUTABLE, MACOS_DIR_OPS_TEST_BUILDS, macosDirOpsOutput } from "../../scripts/build-macos-dir-ops.mjs";

const roots: string[] = [];
const OLD = new Date("2026-01-01T00:00:00Z");
const NEW = new Date("2026-02-01T00:00:00Z");

function write(root: string, relative: string, time: Date, content = relative): void {
  mkdirSync(dirname(join(root, relative)), { recursive: true });
  writeFileSync(join(root, relative), content);
  utimesSync(join(root, relative), time, time);
}

function fixtureRoot({ helpers }: { helpers?: Date } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "ave-macos-dir-ops-"));
  roots.push(root);
  write(root, "package.json", OLD, JSON.stringify({ build: { mac: { minimumSystemVersion: "13.0" } } }));
  for (const source of ["scripts/build-macos-dir-ops.mjs", "native/macos-dir-ops/dir-ops.c", "native/macos-dir-ops/README.md"]) write(root, source, OLD);
  if (helpers) {
    for (const executable of [MACOS_DIR_OPS_EXECUTABLE, ...MACOS_DIR_OPS_TEST_BUILDS.map((build) => build.executable)]) {
      const output = macosDirOpsOutput(root, "arm64", executable);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, "built");
      utimesSync(output, helpers, helpers);
    }
  }
  return root;
}

function compilerStub(calls: string[][]) {
  return (command: string, args: string[]) => {
    calls.push([command, ...args]);
    const output = String(args[args.indexOf("-o") + 1]);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, "built");
    return { status: 0 };
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("buildMacosDirOps", () => {
  it("does nothing off macOS when asked only to refresh, and refuses an explicit build there", () => {
    const calls: string[][] = [];
    expect(buildMacosDirOps({ root: fixtureRoot(), platform: "linux", ifStale: true, spawn: compilerStub(calls), log: () => {} })).toEqual([]);
    expect(() => buildMacosDirOps({ root: fixtureRoot(), platform: "win32", spawn: compilerStub(calls), log: () => {} })).toThrow(/macOS only/);
    expect(calls).toEqual([]);
  });

  it("builds a missing helper for the requested architecture and the app's minimum macOS, with warnings as errors", () => {
    const root = fixtureRoot();
    const calls: string[][] = [];
    const built = buildMacosDirOps({ root, arch: "x64", platform: "darwin", ifStale: true, spawn: compilerStub(calls), log: () => {} });
    expect(built).toEqual([macosDirOpsOutput(root, "x64")]);
    expect(calls).toEqual([[
      "xcrun", "--sdk", "macosx", "clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=13.0", "-arch", "x86_64",
      "-o", macosDirOpsOutput(root, "x64"), join(root, "native", "macos-dir-ops", "dir-ops.c"),
    ]]);
  });

  it("builds the test-only fault variants only when asked, each with its own fault", () => {
    const root = fixtureRoot();
    const calls: string[][] = [];
    buildMacosDirOps({ root, arch: "arm64", platform: "darwin", testBuilds: true, spawn: compilerStub(calls), log: () => {} });
    expect(calls.map((call) => call[call.indexOf("-o") + 1])).toEqual([
      macosDirOpsOutput(root, "arm64"),
      macosDirOpsOutput(root, "arm64", "ave-dir-ops-short-writes"),
      macosDirOpsOutput(root, "arm64", "ave-dir-ops-stalled-writes"),
      macosDirOpsOutput(root, "arm64", "ave-dir-ops-never-ready"),
      macosDirOpsOutput(root, "arm64", "ave-dir-ops-ignores-eof"),
      macosDirOpsOutput(root, "arm64", "ave-dir-ops-reused-file-id"),
      macosDirOpsOutput(root, "arm64", "ave-dir-ops-swap-restored"),
      macosDirOpsOutput(root, "arm64", "ave-dir-ops-swap-before-plain-rename"),
      macosDirOpsOutput(root, "arm64", "ave-dir-ops-swap-commit"),
      macosDirOpsOutput(root, "arm64", "ave-dir-ops-fail-restored"),
      macosDirOpsOutput(root, "arm64", "ave-dir-ops-copy-commit-failure"),
      macosDirOpsOutput(root, "arm64", "ave-dir-ops-copy-restore-failure"),
      macosDirOpsOutput(root, "arm64", "ave-dir-ops-copy-occupied"),
    ]);
    expect(calls[0]?.some((arg) => arg.startsWith("-D"))).toBe(false);
    expect(calls[1]).toContain("-DAVE_DIR_OPS_TEST_WRITE_LIMIT=4093");
    expect(calls[2]).toContain("-DAVE_DIR_OPS_TEST_STALLED_WRITES");
    expect(calls[3]).toContain("-DAVE_DIR_OPS_TEST_NEVER_READY");
    expect(calls[4]).toContain("-DAVE_DIR_OPS_TEST_IGNORES_EOF");
    expect(calls[5]).toContain("-DAVE_DIR_OPS_TEST_REUSED_FILE_ID");
    expect(calls[6]).toContain("-DAVE_DIR_OPS_TEST_SWAP_RESTORED");
    expect(calls[7]).toContain("-DAVE_DIR_OPS_TEST_SWAP_BEFORE_PLAIN_RENAME");
    expect(calls[8]).toContain("-DAVE_DIR_OPS_TEST_SWAP_COMMIT");
    expect(calls[9]).toContain("-DAVE_DIR_OPS_TEST_FAIL_RESTORED");
    expect(calls[10]).toContain("-DAVE_DIR_OPS_TEST_COPY_COMMIT_FAILURE");
    expect(calls[11]).toContain("-DAVE_DIR_OPS_TEST_COPY_RESTORE_FAILURE");
    expect(calls[12]).toContain("-DAVE_DIR_OPS_TEST_COPY_OCCUPIED");
  });

  it("leaves helpers newer than every source alone, and rebuilds them once a source or the build script changes", () => {
    const root = fixtureRoot({ helpers: NEW });
    const calls: string[][] = [];
    const build = () => buildMacosDirOps({ root, arch: "arm64", platform: "darwin", ifStale: true, testBuilds: true, spawn: compilerStub(calls), log: () => {} });
    expect(build()).toEqual([]);
    write(root, "native/macos-dir-ops/dir-ops.c", new Date("2026-03-01T00:00:00Z"));
    expect(build()).toHaveLength(1 + MACOS_DIR_OPS_TEST_BUILDS.length);
    calls.length = 0;
    expect(build()).toEqual([]);
    // Newer than the helpers the stub just wrote.
    write(root, "scripts/build-macos-dir-ops.mjs", new Date(Date.now() + 60_000));
    expect(build()).toHaveLength(1 + MACOS_DIR_OPS_TEST_BUILDS.length);
  });

  it("fails clearly on an unsupported architecture or a failed compile", () => {
    expect(() => buildMacosDirOps({ root: fixtureRoot(), arch: "ia32", platform: "darwin", log: () => {} })).toThrow(/unsupported macOS helper architecture: ia32/);
    expect(() => buildMacosDirOps({ root: fixtureRoot(), arch: "arm64", platform: "darwin", spawn: () => ({ status: 1 }), log: () => {} })).toThrow(/build failed \(exit 1\)/);
  });
});

describe("macOS download file helper wiring", () => {
  const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));

  it("builds the helper with the app and before tests, and its fault-injecting variants only for tests", () => {
    expect(packageJson.scripts.build).toContain("node scripts/build-macos-dir-ops.mjs --if-stale &&");
    expect(packageJson.scripts.build).not.toContain("--test-builds");
    expect(packageJson.scripts["test:prepare"]).toContain("node scripts/build-macos-dir-ops.mjs --if-stale --test-builds");
    const runner = readFileSync(resolve("scripts/hooks/run-local-checks.mjs"), "utf8");
    for (const [start, end] of [
      ["function runAppTargetedVitestChecks", "function runVitestWithReport"],
      ["function runAppFastSourceChecksHoldingSlot", "function runAppCommentOnlyChecks"],
    ]) {
      const segment = runner.slice(runner.indexOf(start), runner.indexOf(end));
      expect(segment.indexOf("ensureMacosDirOps(dir);")).toBeGreaterThan(-1);
      expect(segment.indexOf("ensureMacosDirOps(dir);")).toBeLessThan(segment.indexOf('"test:vitest"'));
    }
  });

  it("packages only the production helper, at the path the host resolves, and builds it for the packaged architecture", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder's own arch macro, as package.json spells it.
    expect(packageJson.build.mac.extraResources).toEqual([{ from: "resources/macos-dir-ops/${arch}/ave-dir-ops", to: "macos-dir-ops/${arch}/ave-dir-ops" }]);
    expect(packageJson.build.files.some((pattern: string) => pattern.startsWith("resources"))).toBe(false);
    expect(readFileSync(resolve("src/main/browser/browser-download-files.ts"), "utf8"))
      .toContain('join(resourcePath, "macos-dir-ops", process.arch, "ave-dir-ops")');
    const hook = readFileSync(resolve(packageJson.build.beforePack), "utf8");
    expect(hook).toContain("buildMacosDirOps({ root: context.packager.projectDir, arch });");
    expect(readFileSync(resolve(".gitignore"), "utf8").split("\n")).toContain("/resources/macos-dir-ops/");
  });
});
