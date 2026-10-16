import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_CLI_MINIMUM_VERSION } from "../../shared/codex-subscription.js";
import { CODEX_DISABLED_FEATURES } from "../codex-conversation-runtime.js";
import {
  codexExecutableCandidates,
  CodexExecutableConfigStore,
  CodexUserRuntimeError,
  CodexUserRuntimeLocator,
  meetsCodexMinimumVersion,
  missingCodexFeatures,
  parseCodexVersion,
  resolveCodexNativeExecutable,
  type CodexProbeRunner,
} from "../codex-user-runtime.js";
import type { FeatureNamespaceHandle } from "../storage/feature-namespace.js";
import { completeCodexSchemas } from "../../__tests__/support/codex-protocol-schemas.js";

const HOST = process.platform;
const NATIVE_NAME = HOST === "win32" ? "codex.exe" : "codex";

function nativeHeader(platform: NodeJS.Platform): Buffer {
  if (platform === "win32") return Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
  if (platform === "darwin") return Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);
  return Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  // Resolution returns real paths; compare against the real temp root.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-codex-user-runtime-")));
  roots.push(root);
  return root;
}

function writeNative(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([nativeHeader(HOST), Buffer.alloc(16)]));
  chmodSync(path, 0o755);
  return path;
}

function writeScript(path: string, body = "#!/bin/sh\necho hi\n"): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

const PLATFORM_PACKAGE: Record<string, string> = {
  "darwin-arm64": "codex-darwin-arm64",
  "darwin-x64": "codex-darwin-x64",
  "linux-arm64": "codex-linux-arm64",
  "linux-x64": "codex-linux-x64",
  "win32-arm64": "codex-win32-arm64",
  "win32-x64": "codex-win32-x64",
};
const TRIPLE: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
};

/**
 * Lay out an npm global install: the launcher package with its script and
 * the platform package it selects. Returns the launcher a PATH lookup finds
 * and the native binary it stands for.
 */
function writeNpmInstall(root: string, layout: "nested" | "hoisted"): { launcher: string; native: string } {
  const key = `${HOST}-${process.arch}`;
  const modules = HOST === "win32" ? join(root, "npm", "node_modules") : join(root, "lib", "node_modules");
  const launcherRoot = join(modules, "@openai", "codex");
  writeFileSync(join(mkdirAndReturn(launcherRoot), "package.json"), JSON.stringify({ name: "@openai/codex" }));
  writeScript(join(launcherRoot, "bin", "codex.js"), "#!/usr/bin/env node\n");
  const platformRoot = layout === "nested"
    ? join(launcherRoot, "node_modules", "@openai", PLATFORM_PACKAGE[key]!)
    : join(modules, "@openai", PLATFORM_PACKAGE[key]!);
  const native = writeNative(join(platformRoot, "vendor", TRIPLE[key]!, "bin", NATIVE_NAME));
  if (HOST === "win32") {
    const launcher = join(root, "npm", "codex.cmd");
    writeFileSync(launcher, "@ECHO off\r\nnode \"%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n");
    return { launcher, native };
  }
  const launcher = join(mkdirAndReturn(join(root, "bin")), "codex");
  symlinkSync(join(launcherRoot, "bin", "codex.js"), launcher);
  return { launcher, native };
}

function mkdirAndReturn(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

describe("codex executable candidates", () => {
  it("puts absolute PATH entries first, then the official install locations", () => {
    expect(codexExecutableCandidates({
      platform: "darwin",
      env: { PATH: "/usr/bin:relative/bin:/opt/tools/bin", CODEX_INSTALL_DIR: "/opt/codex" },
      homeDir: "/Users/alice",
    })).toEqual([
      "/usr/bin/codex",
      "/opt/tools/bin/codex",
      "/opt/codex/codex",
      "/Users/alice/.local/bin/codex",
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ]);
  });

  it("finds the Windows installer location and the npm shim, reading env names case-insensitively", () => {
    expect(codexExecutableCandidates({
      platform: "win32",
      env: {
        Path: "C:\\Tools;\"C:\\Quoted Dir\";relative",
        LocalAppData: "C:\\Users\\alice\\AppData\\Local",
        APPDATA: "C:\\Users\\alice\\AppData\\Roaming",
      },
      homeDir: "C:\\Users\\alice",
    })).toEqual([
      "C:\\Tools\\codex.exe",
      "C:\\Tools\\codex.cmd",
      "C:\\Quoted Dir\\codex.exe",
      "C:\\Quoted Dir\\codex.cmd",
      "C:\\Users\\alice\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
      "C:\\Users\\alice\\AppData\\Roaming\\npm\\codex.cmd",
    ]);
  });

  it("drops duplicates so one location is probed once", () => {
    expect(codexExecutableCandidates({
      platform: "linux",
      env: { PATH: "/usr/local/bin:/usr/local/bin" },
      homeDir: "/home/alice",
    })).toEqual(["/usr/local/bin/codex", "/home/alice/.local/bin/codex", "/opt/homebrew/bin/codex"]);
  });
});

describe("native executable resolution", () => {
  it("accepts a native binary and reports a missing path as absent", async () => {
    const root = tempRoot();
    const native = writeNative(join(root, NATIVE_NAME));
    await expect(resolveCodexNativeExecutable(native)).resolves.toBe(native);
    await expect(resolveCodexNativeExecutable(join(root, "absent", NATIVE_NAME))).resolves.toBeNull();
  });

  it.each(["nested", "hoisted"] as const)("follows an npm launcher to its %s native binary", async (layout) => {
    const root = tempRoot();
    const { launcher, native } = writeNpmInstall(root, layout);
    await expect(resolveCodexNativeExecutable(launcher)).resolves.toBe(native);
  });

  it("refuses a script that is not the official launcher instead of running it", async () => {
    const root = tempRoot();
    const script = writeScript(join(root, HOST === "win32" ? "codex.cmd" : "codex"));
    await expect(resolveCodexNativeExecutable(script)).rejects.toMatchObject({
      code: "codex-runtime-invalid-executable",
    });
  });

  it("refuses an official launcher whose native package is missing", async () => {
    const root = tempRoot();
    const { launcher, native } = writeNpmInstall(root, "nested");
    rmSync(native);
    await expect(resolveCodexNativeExecutable(launcher)).rejects.toMatchObject({
      code: "codex-runtime-invalid-executable",
    });
  });

  it("refuses relative paths and control characters", async () => {
    await expect(resolveCodexNativeExecutable("codex")).rejects.toBeInstanceOf(CodexUserRuntimeError);
    await expect(resolveCodexNativeExecutable("/tmp/co\u0000dex")).rejects.toBeInstanceOf(CodexUserRuntimeError);
  });
});

describe("version gate", () => {
  it("parses the CLI's version line", () => {
    expect(parseCodexVersion("codex-cli 0.153.4\n")).toBe("0.153.4");
    expect(parseCodexVersion("codex-cli 0.160.0-alpha.2")).toBe("0.160.0-alpha.2");
    expect(parseCodexVersion("something else 1.2.3")).toBeNull();
  });

  it("admits the minimum and later, and refuses earlier versions and the minimum's pre-releases", () => {
    expect(meetsCodexMinimumVersion(CODEX_CLI_MINIMUM_VERSION)).toBe(true);
    expect(meetsCodexMinimumVersion("0.152.1")).toBe(true);
    expect(meetsCodexMinimumVersion("0.163.0")).toBe(true);
    expect(meetsCodexMinimumVersion("1.0.0")).toBe(true);
    expect(meetsCodexMinimumVersion("0.151.0")).toBe(false);
    expect(meetsCodexMinimumVersion("0.144.6")).toBe(false);
    expect(meetsCodexMinimumVersion("0.152.0-alpha.1")).toBe(false);
  });
});

describe("feature check", () => {
  it("names each disabled feature the CLI does not list", () => {
    const listing = CODEX_DISABLED_FEATURES
      .filter((feature) => feature !== "sleep_tool")
      .map((feature) => `${feature}   stable   true`)
      .join("\n");
    expect(missingCodexFeatures(listing)).toEqual(["feature sleep_tool"]);
    expect(missingCodexFeatures(`${listing}\nsleep_tool  under development  false\n`)).toEqual([]);
  });
});

interface ProbeScript {
  version?: string;
  features?: string;
  schemas?: Record<string, unknown> | null;
  fail?: "version" | "features" | "schema";
}

function scriptedRunner(script: ProbeScript, calls: string[][] = []): CodexProbeRunner {
  return vi.fn(async (_executable, args) => {
    calls.push([...args]);
    if (args[0] === "--version") {
      if (script.fail === "version") throw new Error("timeout");
      return { code: 0, stdout: `codex-cli ${script.version ?? "0.153.4"}\n` };
    }
    if (args[0] === "features") {
      if (script.fail === "features") return { code: 1, stdout: "" };
      return {
        code: 0,
        stdout: script.features ?? CODEX_DISABLED_FEATURES.map((name) => `${name}  stable  true`).join("\n"),
      };
    }
    if (args[0] === "app-server" && args[1] === "generate-json-schema") {
      if (script.fail === "schema") return { code: 101, stdout: "" };
      const out = args[args.indexOf("--out") + 1]!;
      for (const [name, document] of Object.entries(script.schemas ?? completeCodexSchemas())) {
        writeFileSync(join(out, name), JSON.stringify(document));
      }
      return { code: 0, stdout: "" };
    }
    throw new Error(`unexpected probe ${args.join(" ")}`);
  }) as CodexProbeRunner;
}

/** A real namespace under the test's own temp root. */
function namespaceAt(dir: string): FeatureNamespaceHandle {
  return {
    dir,
    readJson: async () => { throw new Error("unused"); },
    writeJson: async () => { throw new Error("unused"); },
    childDir: async (name: string) => mkdirAndReturn(join(dir, name)),
  } as unknown as FeatureNamespaceHandle;
}

function locatorHarness(input: {
  script?: ProbeScript;
  realProbes?: boolean;
  env?: (root: string) => NodeJS.ProcessEnv;
  calls?: string[][];
} = {}) {
  const root = tempRoot();
  const dirs = Object.fromEntries(["home", "sqlite", "workspace", "temp"].map((name) => [name, mkdirAndReturn(join(root, name))]));
  const configStore = new CodexExecutableConfigStore(namespaceAt(join(root, "namespace")));
  const locator = new CodexUserRuntimeLocator({
    configStore,
    runtimeHome: dirs.home!,
    sqliteHome: dirs.sqlite!,
    workspaceDir: dirs.workspace!,
    runtimeTempDir: dirs.temp!,
    ...(input.realProbes ? {} : { run: scriptedRunner(input.script ?? {}, input.calls) }),
    env: input.env?.(root) ?? { PATH: join(root, "path-bin") },
    homeDir: join(root, "user-home"),
  });
  return { root, dirs, locator, configStore };
}

describe("CodexUserRuntimeLocator", () => {
  it("reports a missing CLI as not installed, never as a substitute", async () => {
    const { locator } = locatorHarness();
    await expect(locator.resolve()).rejects.toMatchObject({ code: "codex-runtime-not-installed" });
  });

  it("finds the CLI on PATH, qualifies it, and probes with the isolated environment", async () => {
    const calls: string[][] = [];
    const { root, locator, dirs } = locatorHarness({ calls });
    const native = writeNative(join(root, "path-bin", NATIVE_NAME));
    await expect(locator.resolve()).resolves.toEqual({ executable: native, version: "0.153.4" });
    expect(locator.lastKnownVersion()).toBe("0.153.4");
    expect(calls.map((args) => args.slice(0, 2))).toEqual([
      ["--version"],
      ["features", "list"],
      ["app-server", "generate-json-schema"],
    ]);
    expect(calls[2]).toContain("--experimental");
    // The generated schema is written under Ave's temp dir and removed afterwards.
    expect(calls[2]![calls[2]!.indexOf("--out") + 1]!.startsWith(dirs.temp!)).toBe(true);
    expect(readdirSync(dirs.temp!)).toEqual([]);
  });

  it("probes a binary once until the file changes", async () => {
    const calls: string[][] = [];
    const { root, locator } = locatorHarness({ calls });
    const native = writeNative(join(root, "path-bin", NATIVE_NAME));
    await locator.resolve();
    await locator.resolve();
    expect(calls.filter((args) => args[0] === "--version")).toHaveLength(1);
    writeFileSync(native, Buffer.concat([nativeHeader(HOST), Buffer.alloc(64)]));
    await locator.resolve();
    expect(calls.filter((args) => args[0] === "--version")).toHaveLength(2);
  });

  it("refuses a version below the minimum and keeps the version it found", async () => {
    const { root, locator } = locatorHarness({ script: { version: "0.151.0" } });
    writeNative(join(root, "path-bin", NATIVE_NAME));
    await expect(locator.resolve()).rejects.toMatchObject({
      code: "codex-runtime-version-unsupported",
      version: "0.151.0",
    });
    expect(locator.lastKnownVersion()).toBe("0.151.0");
  });

  it("reports a protocol mismatch with every missing request, field and feature", async () => {
    const schemas = completeCodexSchemas();
    const clientRequest = schemas["ClientRequest.json"] as { oneOf: { properties: { method: { enum: string[] } } }[] };
    clientRequest.oneOf = clientRequest.oneOf.filter((variant) => variant.properties.method.enum[0] !== "turn/interrupt");
    const features = CODEX_DISABLED_FEATURES.filter((name) => name !== "hooks").map((name) => `${name} stable true`).join("\n");
    const { root, locator } = locatorHarness({ script: { schemas, features } });
    writeNative(join(root, "path-bin", NATIVE_NAME));
    await expect(locator.resolve()).rejects.toMatchObject({
      code: "codex-runtime-incompatible",
      version: "0.153.4",
      missing: ["feature hooks", "request turn/interrupt"],
    });
  });

  it("treats missing schema documents as a mismatch", async () => {
    const { root, locator } = locatorHarness({ script: { schemas: {} } });
    writeNative(join(root, "path-bin", NATIVE_NAME));
    await expect(locator.resolve()).rejects.toMatchObject({
      code: "codex-runtime-incompatible",
      missing: ["schema documents"],
    });
  });

  it.each(["version", "features", "schema"] as const)(
    "reports a %s probe that cannot run as a start failure and retries it",
    async (fail) => {
      const calls: string[][] = [];
      const { root, locator } = locatorHarness({ script: { fail }, calls });
      writeNative(join(root, "path-bin", NATIVE_NAME));
      await expect(locator.resolve()).rejects.toMatchObject({ code: "codex-runtime-start-failed" });
      await expect(locator.resolve()).rejects.toMatchObject({ code: "codex-runtime-start-failed" });
      expect(calls.filter((args) => args[0] === "--version")).toHaveLength(2);
    },
  );

  it("prefers an explicit choice over discovery and never falls back when it disappears", async () => {
    const { root, locator, configStore } = locatorHarness();
    writeNative(join(root, "path-bin", NATIVE_NAME));
    const chosen = writeNative(join(root, "chosen", NATIVE_NAME));
    await locator.choose(chosen);
    await expect(configStore.getExecutable()).resolves.toBe(chosen);
    await expect(locator.resolve()).resolves.toMatchObject({ executable: chosen });
    rmSync(chosen);
    await expect(locator.resolve()).rejects.toMatchObject({ code: "codex-runtime-invalid-executable" });
    await locator.forget();
    await expect(configStore.getExecutable()).resolves.toBeNull();
    await expect(locator.resolve()).resolves.toMatchObject({ executable: join(root, "path-bin", NATIVE_NAME) });
  });

  it("refuses to remember a choice that is not a native CLI or its launcher", async () => {
    const { root, locator, configStore } = locatorHarness();
    const script = writeScript(join(root, "elsewhere", "codex-wrapper"));
    await expect(locator.choose(script)).rejects.toMatchObject({ code: "codex-runtime-invalid-executable" });
    await expect(configStore.getExecutable()).resolves.toBeNull();
  });

  it("stops at the first CLI found when it is unusable instead of trying the next one", async () => {
    const { root, locator } = locatorHarness({
      env: (base) => ({ PATH: [join(base, "first"), join(base, "second")].join(HOST === "win32" ? ";" : ":") }),
    });
    writeScript(join(root, "first", HOST === "win32" ? "codex.cmd" : "codex"));
    writeNative(join(root, "second", NATIVE_NAME));
    await expect(locator.resolve()).rejects.toMatchObject({ code: "codex-runtime-invalid-executable" });
  });

  it("runs real probes without a shell and reads their output", async () => {
    // The test runner's own native executable answers `--version` with a
    // version line that is not the CLI's, so the real probe path ends in an
    // invalid-executable verdict rather than a start failure.
    const { locator } = locatorHarness({ realProbes: true });
    await locator.choose(process.execPath);
    await expect(locator.resolve()).rejects.toMatchObject({ code: "codex-runtime-invalid-executable" });
  });
});
