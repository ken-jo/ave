import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { assertElectronNodeVitestRuntime } from "../../scripts/assert-electron-node-vitest.mjs";
import {
  hideChildConsoles,
  normalizeElectronNodeRuntime,
  withHiddenConsole,
} from "../../scripts/normalize-electron-node-runtime.mjs";
import { documentGuardImportArgument, guardedNodeOptions } from "../../scripts/lib/document-consumer-node-options.mjs";
import {
  applyElectronVitestResult,
  createElectronVitestInvocation,
  ensureGeneratedAssets,
  missingGeneratedAssets,
  resolveElectronVitestRuntime,
  runVitestUnderElectron,
} from "../../scripts/run-vitest-under-electron.mjs";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn(() => true);
}

describe("Electron Node-mode Vitest runner", () => {
  it("passes file URLs to worker preloads", async () => {
    const configUrl = new URL("../../config/vitest.analysis.config.ts", import.meta.url);
    const analysisConfig = (await import(configUrl.href)).default as { test: { execArgv: string[] } };
    const preloads = analysisConfig.test.execArgv.filter((argument) => argument.startsWith("--import="));
    expect(preloads).toContain(documentGuardImportArgument());
    for (const argument of preloads) {
      expect(argument).toMatch(/^--import=file:\/\//);
      expect(fileURLToPath(argument.slice("--import=".length))).toBeTruthy();
    }
  });

  it("preserves a preload path with spaces through NODE_OPTIONS", () => {
    const directory = mkdtempSync(join(tmpdir(), "ave preload space "));
    try {
      const preloadPath = join(directory, "guard #1.mjs");
      writeFileSync(preloadPath, 'process.env.AVE_PRELOAD_SPACE_TEST = "loaded";\n');
      const argument = documentGuardImportArgument(preloadPath);
      expect(argument).toBe(`--import=${pathToFileURL(preloadPath).href}`);
      expect(argument).not.toContain(" ");
      expect(fileURLToPath(argument.slice("--import=".length))).toBe(preloadPath);
      const options = guardedNodeOptions("--trace-warnings", preloadPath);
      expect(options).toBe(`--trace-warnings ${argument}`);
      const child = spawnSync(process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath, [
        "-e", "process.stdout.write(process.env.AVE_PRELOAD_SPACE_TEST ?? '')",
      ], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: options },
        encoding: "utf8",
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stdout).toBe("loaded");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("locks both test entrypoints to the runtime guard", () => {
    const vitestConfig = readFileSync(
      new URL("../../vitest.config.ts", import.meta.url),
      "utf8",
    );
    const analysisConfig = readFileSync(
      new URL("../../config/vitest.analysis.config.ts", import.meta.url),
      "utf8",
    );
    const bunfig = readFileSync(new URL("../../bunfig.toml", import.meta.url), "utf8");
    expect(vitestConfig).toMatch(
      /^import "\.\/scripts\/assert-electron-node-vitest\.mjs";$/m,
    );
    expect(vitestConfig).toMatch(
      /^export \{ default \} from "\.\/config\/vitest\.analysis\.config\.js";$/m,
    );
    expect(analysisConfig).not.toContain("assert-electron-node-vitest");
    expect(bunfig).toMatch(
      /^preload = \["\.\/scripts\/assert-electron-node-vitest\.mjs"\]$/m,
    );
  });

  it("fails fast for direct Node or Bun test runners", () => {
    expect(() =>
      assertElectronNodeVitestRuntime({
        env: {},
        execPath: "C:/runtime/node.exe",
      }),
    ).toThrow("[electron-vitest-runner-required]");
    expect(() =>
      assertElectronNodeVitestRuntime({
        env: { ELECTRON_RUN_AS_NODE: "1" },
        execPath: "/usr/bin/node",
      }),
    ).toThrow("[electron-vitest-runner-required]");
    expect(() =>
      assertElectronNodeVitestRuntime({
        env: { ELECTRON_RUN_AS_NODE: "1" },
        execPath: "C:/runtime/electron.exe",
      }),
    ).not.toThrow();
    expect(() =>
      assertElectronNodeVitestRuntime({
        env: { ELECTRON_RUN_AS_NODE: "1" },
        execPath: "/opt/Electron",
      }),
    ).not.toThrow();
  });

  it("resolves explicit runtime paths and rejects invalid resolvers", () => {
    expect(
      resolveElectronVitestRuntime({
        loadElectron: () => "C:/runtime/electron.exe",
        resolveVitest: () => "C:/runtime/vitest.mjs",
        normalizerPath: "C:/runtime/normalize.mjs",
      }),
    ).toEqual({
      electronPath: "C:/runtime/electron.exe",
      vitestPath: "C:/runtime/vitest.mjs",
      normalizerPath: "C:/runtime/normalize.mjs",
    });
    expect(() =>
      resolveElectronVitestRuntime({
        loadElectron: () => "",
        resolveVitest: () => "C:/runtime/vitest.mjs",
      }),
    ).toThrow("[electron-vitest-runtime-invalid]");
  });

  it("builds a shell-free invocation and forces Electron Node mode", () => {
    const invocation = createElectronVitestInvocation(
      ["run", "./src/example.test.ts"],
      {
        electronPath: "C:/runtime/electron.exe",
        vitestPath: "C:/runtime/vitest.mjs",
        normalizerPath: "C:/runtime/normalize.mjs",
        cwd: "C:/repo",
        env: {
          ELECTRON_RUN_AS_NODE: "0",
          KEEP: "yes",
          NODE_OPTIONS: "--trace-warnings",
        },
        nodeExecPath: "C:/runtime/node.exe",
      },
    );

    expect(invocation).toEqual({
      command: "C:/runtime/electron.exe",
      args: [
        `--import=${pathToFileURL("C:/runtime/normalize.mjs").href}`,
        "C:/runtime/vitest.mjs", "run", "./src/example.test.ts",
      ],
      options: {
        cwd: "C:/repo",
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          KEEP: "yes",
          AVE_TEST_NODE_EXEC_PATH: "C:/runtime/node.exe",
          NODE_OPTIONS: guardedNodeOptions(guardedNodeOptions("--trace-warnings"), "C:/runtime/normalize.mjs"),
        },
        shell: false,
        stdio: "inherit",
        windowsHide: true,
      },
    });
    expect(() =>
      createElectronVitestInvocation(["run", 1] as unknown as string[], {
        electronPath: "electron",
        vitestPath: "vitest",
      }),
    ).toThrow("[electron-vitest-args-invalid]");
    expect(() =>
      createElectronVitestInvocation(["run"], {
        electronPath: "",
        vitestPath: "vitest",
      }),
    ).toThrow("[electron-vitest-runtime-invalid]");
  });

  it("runs the branding generator once for a worktree that lacks its outputs, and never for a complete one", () => {
    const root = mkdtempSync(join(tmpdir(), "ave-vitest-assets-"));
    try {
      const manifest = join("build", "generated-assets.json");
      const write = (relative: string) => {
        mkdirSync(join(root, relative, ".."), { recursive: true });
        writeFileSync(join(root, relative), "x");
      };
      // A fresh worktree: no manifest at all. The generator is the one that
      // knows the full list, so it must run and its manifest is then trusted.
      expect(missingGeneratedAssets({ cwd: root })).toEqual([manifest]);
      const runSync = vi.fn(() => {
        write("build/icon.png");
        write("build/tray-icon.png");
        mkdirSync(join(root, "build"), { recursive: true });
        writeFileSync(join(root, manifest), JSON.stringify(["build/icon.png", "build/tray-icon.png"]));
        return { status: 0, error: undefined };
      });
      const log = vi.fn();
      expect(ensureGeneratedAssets({
        cwd: root,
        generatorPath: "/generator.cjs",
        nodeExecPath: "/node",
        runSync,
        log,
      })).toEqual({ generated: true, missing: [manifest] });
      expect(runSync).toHaveBeenCalledWith(
        "/node",
        ["/generator.cjs"],
        expect.objectContaining({ cwd: root, shell: false, stdio: "inherit" }),
      );
      expect(log).toHaveBeenCalledTimes(1);

      // Complete tree: nothing to do, and the generator is not touched.
      expect(ensureGeneratedAssets({ cwd: root, runSync, log })).toEqual({
        generated: false,
        missing: [],
      });
      expect(runSync).toHaveBeenCalledTimes(1);

      // One listed output gone (e.g. a partial clean): only that one is
      // reported, and the generator runs again.
      rmSync(join(root, "build/tray-icon.png"));
      expect(missingGeneratedAssets({ cwd: root })).toEqual(["build/tray-icon.png"]);
      ensureGeneratedAssets({ cwd: root, runSync, log });
      expect(runSync).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed with a stable code when the generator fails or leaves outputs missing", () => {
    const root = mkdtempSync(join(tmpdir(), "ave-vitest-assets-"));
    try {
      expect(() => ensureGeneratedAssets({
        cwd: root,
        runSync: () => ({ status: 3, error: undefined }),
        log: () => {},
      })).toThrow("[electron-vitest-assets-unavailable] generator exited 3");
      expect(() => ensureGeneratedAssets({
        cwd: root,
        runSync: () => ({ status: null, error: new Error("ENOENT node") }),
        log: () => {},
      })).toThrow("[electron-vitest-assets-unavailable] ENOENT node");
      // A "successful" generator that did not actually produce the manifest is
      // still an absence, not a pass.
      expect(() => ensureGeneratedAssets({
        cwd: root,
        runSync: () => ({ status: 0, error: undefined }),
        log: () => {},
      })).toThrow("[electron-vitest-assets-unavailable] generator left assets missing");
      // A corrupt manifest counts as missing rather than as "nothing listed".
      mkdirSync(join(root, "build"), { recursive: true });
      writeFileSync(join(root, "build", "generated-assets.json"), "{not json");
      expect(missingGeneratedAssets({ cwd: root })).toEqual([join("build", "generated-assets.json")]);
      writeFileSync(join(root, "build", "generated-assets.json"), JSON.stringify({ paths: [] }));
      expect(missingGeneratedAssets({ cwd: root })).toEqual([join("build", "generated-assets.json")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fills missing assets before the CLI entrypoint launches Vitest", () => {
    const runnerSource = readFileSync(
      new URL("../../scripts/run-vitest-under-electron.mjs", import.meta.url),
      "utf8",
    );
    const mainBlock = runnerSource.indexOf("if (isMainModule()) {");
    expect(mainBlock).toBeGreaterThanOrEqual(0);
    const ensureCall = runnerSource.indexOf("ensureGeneratedAssets();", mainBlock);
    const launch = runnerSource.indexOf("runVitestUnderElectron(process.argv.slice(2))", mainBlock);
    expect(ensureCall).toBeGreaterThan(mainBlock);
    expect(launch).toBeGreaterThan(ensureCall);
  });

  it("rejects partially injected runtime paths instead of ignoring them", async () => {
    await expect(
      runVitestUnderElectron(["run"], {
        electronPath: "C:/runtime/electron.exe",
      }),
    ).rejects.toThrow("[electron-vitest-runtime-invalid]");
  });

  it("forwards termination signals, returns the child result, and removes listeners", async () => {
    const child = new FakeChild();
    const signalSource = new EventEmitter();
    const spawnProcess = vi.fn(() => child);
    const completion = runVitestUnderElectron(["run", "./test.ts"], {
      electronPath: "C:/runtime/electron.exe",
      vitestPath: "C:/runtime/vitest.mjs",
      normalizerPath: "C:/runtime/normalize.mjs",
      cwd: "C:/repo",
      env: { KEEP: "yes" },
      nodeExecPath: "C:/runtime/node.exe",
      signalSource,
      spawnProcess,
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      "C:/runtime/electron.exe",
      [
        `--import=${pathToFileURL("C:/runtime/normalize.mjs").href}`,
        "C:/runtime/vitest.mjs", "run", "./test.ts",
      ],
      expect.objectContaining({
        cwd: "C:/repo",
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          KEEP: "yes",
          AVE_TEST_NODE_EXEC_PATH: "C:/runtime/node.exe",
          NODE_OPTIONS: guardedNodeOptions(guardedNodeOptions(), "C:/runtime/normalize.mjs"),
        },
        shell: false,
      }),
    );
    signalSource.emit("SIGINT");
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
    signalSource.emit("SIGINT");
    expect(child.kill).toHaveBeenCalledTimes(2);
    child.exitCode = 7;
    child.emit("exit", 7, null);

    await expect(completion).resolves.toEqual({ code: 7, signal: null });
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
  });

  it("wraps asynchronous launch errors with a stable code", async () => {
    const child = new FakeChild();
    const completion = runVitestUnderElectron(["run"], {
      electronPath: "electron",
      vitestPath: "vitest",
      signalSource: new EventEmitter(),
      spawnProcess: () => child,
    });

    child.emit("error", new Error("spawn failed"));
    await expect(completion).rejects.toThrow(
      "[electron-vitest-launch-failed] spawn failed",
    );
  });

  it("wraps synchronous launch and runtime resolution errors with stable codes", async () => {
    await expect(
      runVitestUnderElectron(["run"], {
        electronPath: "electron",
        vitestPath: "vitest",
        spawnProcess: () => {
          throw new Error("sync spawn failed");
        },
      }),
    ).rejects.toThrow("[electron-vitest-launch-failed] sync spawn failed");
    expect(() =>
      resolveElectronVitestRuntime({
        loadElectron: () => {
          throw new Error("missing electron");
        },
      }),
    ).toThrow("[electron-vitest-runtime-unavailable] missing electron");
  });

  it("normalizes a fresh test process before its entrypoint loads", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "ave-test-runtime-"));
    const entrypoint = join(fixtureRoot, "probe.mjs");
    writeFileSync(entrypoint, [
      'import assert from "node:assert/strict";',
      'assert.match(process.versions.modules, /^\\d+$/);',
      'assert.equal(process.versions.electron, undefined);',
      'assert.equal(process.versions.chrome, undefined);',
      'assert.equal(process.resourcesPath, undefined);',
      'assert.equal(process.helperExecPath, undefined);',
    ].join("\n"));
    try {
      const runtime = resolveElectronVitestRuntime();
      await expect(runVitestUnderElectron([], {
        ...runtime,
        vitestPath: entrypoint,
      })).resolves.toEqual({ code: 0, signal: null });
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when a future Electron marker cannot be normalized", () => {
    const versions: Record<string, string> = {};
    Object.defineProperty(versions, "electron", {
      configurable: false,
      value: "future",
    });
    expect(() =>
      normalizeElectronNodeRuntime({
        env: { ELECTRON_RUN_AS_NODE: "1" },
        versions,
      }),
    ).toThrow("[electron-node-normalization-failed]");
  });

  it("defaults windowsHide for console children of the Windows test runtime only", () => {
    const callback = () => {};
    expect(withHiddenConsole(["git"])).toEqual(["git", { windowsHide: true }]);
    expect(withHiddenConsole(["git", ["status"]])).toEqual(["git", ["status"], { windowsHide: true }]);
    expect(withHiddenConsole(["git", ["status"], callback])).toEqual(["git", ["status"], { windowsHide: true }, callback]);
    expect(withHiddenConsole(["echo", callback])).toEqual(["echo", { windowsHide: true }, callback]);
    const options = { cwd: "x" };
    expect(withHiddenConsole(["git", [], options])).toEqual(["git", [], { cwd: "x", windowsHide: true }]);
    expect(options).toEqual({ cwd: "x" });
    const shown = ["git", [], { windowsHide: false }];
    expect(withHiddenConsole(shown)).toBe(shown);

    const spawn = vi.fn();
    const module = { spawn } as unknown as typeof import("node:child_process");
    const env = { ELECTRON_RUN_AS_NODE: "1" };
    const target = (platform: string) => ({ platform, env }) as unknown as NodeJS.Process;
    expect(hideChildConsoles({ target: target("darwin"), module, sync: () => {} })).toBe(false);
    expect(module.spawn).toBe(spawn);
    expect(hideChildConsoles({ target: target("win32"), module, sync: () => {} })).toBe(true);
    module.spawn("git", ["status"]);
    expect(spawn).toHaveBeenCalledWith("git", ["status"], { windowsHide: true });
  });

  it("mirrors exit codes and child termination signals", () => {
    const codeTarget = { exitCode: undefined as number | undefined };
    applyElectronVitestResult({ code: 9, signal: null }, codeTarget);
    expect(codeTarget.exitCode).toBe(9);

    const signalTarget = {
      pid: 42,
      exitCode: undefined as number | undefined,
      kill: vi.fn(),
    };
    applyElectronVitestResult(
      { code: null, signal: "SIGTERM" },
      signalTarget,
    );
    expect(signalTarget.kill).toHaveBeenCalledWith(42, "SIGTERM");
    expect(signalTarget.exitCode).toBeUndefined();

    const failedSignalTarget = {
      pid: 42,
      exitCode: undefined as number | undefined,
      kill: vi.fn(() => {
        throw new Error("signal unavailable");
      }),
    };
    applyElectronVitestResult(
      { code: null, signal: "SIGTERM" },
      failedSignalTarget,
    );
    expect(failedSignalTarget.exitCode).toBe(1);
  });
});
