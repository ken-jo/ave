import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, promises as fs, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_CLI_MINIMUM_VERSION } from "../../shared/codex-subscription.js";
import { meetsMinimumCliVersion } from "../../shared/subscription-runtime.js";
import { CODEX_DISABLED_FEATURES } from "../codex-conversation-runtime.js";
import {
  codexExecutableCandidates,
  CodexUserRuntimeError,
  CodexUserRuntimeLocator,
  missingCodexFeatures,
  parseCodexVersion,
  resolveCodexNativeExecutable,
  type CodexProbeRunner,
} from "../codex-user-runtime.js";
import { completeCodexSchemas } from "../../__tests__/support/codex-protocol-schemas.js";
import { nativeExecutableBytes, normalizeFixtureAncestorPermissions, writeNativeExecutable } from "../../__tests__/support/native-executable.js";
import { verifyCodexExecutableArtifact } from "../codex-executable-artifact.js";
import * as executableLocation from "../codex-executable-location.js";
import { createPrivateDirectories } from "../codex-executable-location.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const aclProbeMode = vi.hoisted(() => ({ real: false }));
// Admission probes and ownership claims are counted apart: each private directory or copy the runtime creates costs one claim by design, while admission
// batching is what the probe bounds guard.
const accessRuleProbes = vi.hoisted(() => ({ count: 0, claims: 0 }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { fakeFixtureAclTransport, installFixtureAclTransport, maskFixtureAncestorAclTransport } =
    await import("../../__tests__/support/native-executable.js");
  if (process.platform !== "win32") return actual;
  const fast = fakeFixtureAclTransport(actual.execFile);
  const real = maskFixtureAncestorAclTransport(actual.spawn);
  // Each ACL host request is one access-rule probe or one ownership claim.
  installFixtureAclTransport({
    request: (...args) => {
      if (args[0].setOwner) accessRuleProbes.claims++;
      else accessRuleProbes.count++;
      return (aclProbeMode.real ? real : fast).request(...args);
    },
    discard: () => { fast.discard(); real.discard(); },
  });
  return actual;
});

const HOST = process.platform;
const NATIVE_NAME = HOST === "win32" ? "codex.exe" : "codex";

const roots: string[] = [];
afterEach(async () => {
  aclProbeMode.real = false;
  for (const root of roots.splice(0)) await cleanupTmpDir(root);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function tempRoot(): string {
  // Resolution returns real paths; compare against the real temp root.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-codex-user-runtime-")));
  roots.push(root);
  if (HOST !== "win32") normalizeFixtureAncestorPermissions(root);
  return root;
}

function writeNative(path: string): string {
  return writeNativeExecutable(path);
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

// Lay out an npm global install: the launcher package with its script and the platform package it selects. Returns the launcher a PATH lookup finds and
// the native binary it stands for.
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
  mkdirSync(path, { recursive: true, mode: 0o700 });
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

  it("requires drive-qualified or UNC Windows locations", async () => {
    expect(codexExecutableCandidates({
      platform: "win32",
      env: { PATH: "\\tools;C:relative;C:\\safe;\\\\server\\share\\bin;\\\\?\\C:\\device", CODEX_INSTALL_DIR: "\\install", APPDATA: "\\profile" },
      homeDir: "C:\\Users\\alice",
    })).toEqual(["C:\\safe\\codex.exe", "C:\\safe\\codex.cmd", "\\\\server\\share\\bin\\codex.exe", "\\\\server\\share\\bin\\codex.cmd"]);
    for (const path of ["\\tools\\codex.exe", "C:codex.exe", "\\\\?\\C:\\codex.exe"]) {
      await expect(resolveCodexNativeExecutable(path, "win32")).rejects.toMatchObject({ code: "codex-runtime-invalid-executable" });
    }
  });
});

describe("native executable resolution", () => {
  it("accepts a native binary and reports a missing path as absent (real ACL probes, end to end)", async () => {
    aclProbeMode.real = true;
    const root = tempRoot();
    if (HOST === "win32") normalizeFixtureAncestorPermissions(root);
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

  // The darwin route takes a POSIX absolute path, which a Windows temp root is not.
  it.runIf(HOST !== "win32")("routes a 64-bit universal executable to full copy validation", async () => {
    const root = tempRoot();
    const bytes = Buffer.alloc(8192);
    bytes.writeUInt32BE(0xcafebabf, 0); bytes.writeUInt32BE(1, 4);
    bytes.writeUInt32BE(process.arch === "arm64" ? 0x0100000c : 0x01000007, 8);
    bytes.writeBigUInt64BE(4096n, 16); bytes.writeBigUInt64BE(4096n, 24); bytes.writeUInt32BE(12, 32);
    nativeExecutableBytes("darwin").copy(bytes, 4096);
    const native = writeNativeExecutable(join(root, "codex"), bytes);
    const candidate = HOST === "win32" ? "/installed/codex" : native;
    if (HOST === "win32") {
      // The routing platform requires a POSIX path; its bytes live in the host fixture.
      const lstat = fs.lstat.bind(fs);
      vi.spyOn(fs, "lstat").mockImplementation((path) => lstat(String(path) === candidate ? native : path));
      vi.spyOn(fs, "realpath").mockResolvedValue(native);
      vi.spyOn(executableLocation, "assertCodexExecutableLocation").mockResolvedValue(undefined);
    }
    await expect(resolveCodexNativeExecutable(candidate, "darwin")).resolves.toBe(native);
  });
});

describe("version gate", () => {
  it("parses the CLI's version line", () => {
    expect(parseCodexVersion("codex-cli 0.153.4\n")).toBe("0.153.4");
    expect(parseCodexVersion("codex-cli 0.160.0-alpha.2")).toBe("0.160.0-alpha.2");
    expect(parseCodexVersion("something else 1.2.3")).toBeNull();
  });

  it("admits the minimum and later, and refuses earlier versions and the minimum's pre-releases", () => {
    expect(meetsMinimumCliVersion(CODEX_CLI_MINIMUM_VERSION, CODEX_CLI_MINIMUM_VERSION)).toBe(true);
    expect(meetsMinimumCliVersion("0.152.1", CODEX_CLI_MINIMUM_VERSION)).toBe(true);
    expect(meetsMinimumCliVersion("0.163.0", CODEX_CLI_MINIMUM_VERSION)).toBe(true);
    expect(meetsMinimumCliVersion("1.0.0", CODEX_CLI_MINIMUM_VERSION)).toBe(true);
    expect(meetsMinimumCliVersion("0.151.0", CODEX_CLI_MINIMUM_VERSION)).toBe(false);
    expect(meetsMinimumCliVersion("0.144.6", CODEX_CLI_MINIMUM_VERSION)).toBe(false);
    expect(meetsMinimumCliVersion("0.152.0-alpha.1", CODEX_CLI_MINIMUM_VERSION)).toBe(false);
    expect(meetsMinimumCliVersion("0.152.0+build.7", CODEX_CLI_MINIMUM_VERSION)).toBe(true);
    expect(meetsMinimumCliVersion("0.151.9+build.7", CODEX_CLI_MINIMUM_VERSION)).toBe(false);
    for (const malformed of ["", "1.0", "1.0.0.0", "1.x.0", "v1.0.0"]) expect(meetsMinimumCliVersion(malformed, CODEX_CLI_MINIMUM_VERSION)).toBe(false);
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

async function locatorHarness(input: {
  script?: ProbeScript;
  realProbes?: boolean;
  env?: (root: string) => NodeJS.ProcessEnv;
  calls?: string[][];
  run?: CodexProbeRunner;
  // Give the Windows fixture root its private access list before anything is created in it.
  privateRoot?: boolean;
} = {}) {
  const root = tempRoot();
  // Children inherit the root's access list when they are created, as the product's private directories do under the Ave home.
  if (HOST === "win32" && input.privateRoot) normalizeFixtureAncestorPermissions(root);
  const dirs = Object.fromEntries(["home", "sqlite", "workspace", "temp"].map((name) => [name, join(root, name)]));
  const runtimeDirectory = join(dirs.home!, "runtime");
  await createPrivateDirectories([...Object.values(dirs), runtimeDirectory]);
  const locator = new CodexUserRuntimeLocator({
    runtimeHome: dirs.home!,
    runtimeDirectory,
    sqliteHome: dirs.sqlite!,
    workspaceDir: dirs.workspace!,
    runtimeTempDir: dirs.temp!,
    ...(input.realProbes ? {} : { run: input.run ?? scriptedRunner(input.script ?? {}, input.calls) }),
    env: input.env?.(root) ?? { PATH: join(root, "path-bin") },
    homeDir: join(root, "user-home"),
  });
  return { root, dirs, locator };
}

describe("CodexUserRuntimeLocator", () => {
  it("reports a missing CLI as not installed, never as a substitute", async () => {
    const { locator } = await locatorHarness();
    await expect(locator.resolve()).rejects.toMatchObject({ code: "codex-runtime-not-installed" });
  });

  it("finds the CLI on PATH, qualifies it, and probes with the isolated environment (real ACL probes, end to end)", async () => {
    aclProbeMode.real = true;
    const calls: string[][] = [];
    const { root, locator, dirs } = await locatorHarness({ calls, privateRoot: true });
    const native = writeNative(join(root, "path-bin", NATIVE_NAME));
    const resolved = await locator.resolve();
    expect(resolved.version).toBe("0.153.4");
    expect(resolved.executable).not.toBe(native);
    expect(resolved.executable.startsWith(join(dirs.home!, "runtime"))).toBe(true);
    expect(readFileSync(resolved.executable)).toEqual(readFileSync(native));
    if (HOST !== "win32") {
      expect(statSync(dirname(resolved.executable)).mode & 0o777).toBe(0o700);
      expect(statSync(resolved.executable).mode & 0o777).toBe(0o500);
    }
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

  it("limits qualification to local metadata commands in an empty temporary account home", async () => {
    const calls: string[][] = [];
    const base = scriptedRunner({}, calls);
    const probeRoots = new Set<string>();
    const run: CodexProbeRunner = async (executable, args, options) => {
      const home = options.env.HOME!;
      const probeRoot = dirname(home);
      probeRoots.add(probeRoot);
      expect(dirname(probeRoot)).toBe(dirs.temp);
      expect(options.env.CODEX_HOME).toBe(home);
      expect(options.env.CODEX_SQLITE_HOME).toBe(join(probeRoot, "sqlite"));
      expect(options.env.TMPDIR).toBe(join(probeRoot, "temp"));
      expect(home).not.toBe(dirs.home);
      expect(options.env.CODEX_SQLITE_HOME).not.toBe(dirs.sqlite);
      expect(readdirSync(home)).toEqual([]);
      expect(readdirSync(options.env.CODEX_SQLITE_HOME!)).toEqual([]);
      for (const path of [probeRoot, home, options.env.CODEX_SQLITE_HOME!, options.env.TMPDIR!]) {
        if (HOST !== "win32") expect(statSync(path).mode & 0o777).toBe(0o700);
      }
      writeFileSync(join(probeRoot, "fixture-state"), "temporary state");
      return base(executable, args, options);
    };
    const { root, locator, dirs } = await locatorHarness({ run });
    writeNative(join(root, "path-bin", NATIVE_NAME));
    writeFileSync(join(dirs.home!, "auth.json"), "fixture account state");
    await locator.resolve();
    expect(probeRoots.size).toBe(1);
    const probeRoot = [...probeRoots][0]!;
    expect(calls).toEqual([
      ["--version"],
      ["features", "list"],
      ["app-server", "generate-json-schema", "--experimental", "--out", join(probeRoot, "schema")],
    ]);
    expect(existsSync(probeRoot)).toBe(false);
    expect(readdirSync(dirs.temp!)).toEqual([]);
    expect(readFileSync(join(dirs.home!, "auth.json"), "utf8")).toBe("fixture account state");
    await locator.dispose();
  });

  it.each([
    { fail: "version" }, { fail: "features" }, { fail: "schema" },
    { version: "0.1.0" }, { schemas: {} },
  ] satisfies ProbeScript[])("removes the entire temporary probe root after qualification failure %j", async (script) => {
    const homes: string[] = [];
    const base = scriptedRunner(script);
    const run: CodexProbeRunner = async (executable, args, options) => {
      homes.push(options.env.HOME!);
      writeFileSync(join(options.env.HOME!, "fixture-state"), "temporary state");
      return base(executable, args, options);
    };
    const { root, locator, dirs } = await locatorHarness({ run });
    writeNative(join(root, "path-bin", NATIVE_NAME));
    await expect(locator.resolve()).rejects.toBeInstanceOf(CodexUserRuntimeError);
    expect(homes.length).toBeGreaterThan(0);
    for (const home of homes) expect(existsSync(dirname(home))).toBe(false);
    expect(readdirSync(dirs.temp!)).toEqual([]);
    await locator.dispose();
  });

  it("removes a partially initialized probe root when private child creation fails", async () => {
    const calls: string[][] = [];
    const { root, locator, dirs } = await locatorHarness({ calls });
    writeNative(join(root, "path-bin", NATIVE_NAME));
    const mkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, "mkdir").mockImplementation((async (...args: Parameters<typeof fs.mkdir>) => {
      if (dirname(String(args[0])).startsWith(join(dirs.temp!, "probe-")) && String(args[0]).endsWith("sqlite")) {
        throw Object.assign(new Error("Fixture creation failure"), { code: "EACCES" });
      }
      return mkdir(...args);
    }) as typeof fs.mkdir);
    await expect(locator.resolve()).rejects.toMatchObject({ code: "codex-runtime-start-failed" });
    expect(calls).toEqual([]);
    expect(readdirSync(dirs.temp!)).toEqual([]);
    await locator.dispose();
  });

  it("probes a binary once until the file changes", async () => {
    const calls: string[][] = [];
    const { root, locator } = await locatorHarness({ calls });
    const native = writeNative(join(root, "path-bin", NATIVE_NAME));
    await locator.resolve();
    await locator.resolve();
    expect(calls.filter((args) => args[0] === "--version")).toHaveLength(1);
    const replacement = nativeExecutableBytes(); replacement[replacement.length - 1] = 1;
    writeFileSync(native, replacement);
    await locator.resolve();
    expect(calls.filter((args) => args[0] === "--version")).toHaveLength(2);
  });

  it("invalidates a same-size rewrite even when its modification time is restored", async () => {
    const calls: string[][] = [];
    const { root, locator } = await locatorHarness({ calls });
    const native = writeNative(join(root, "path-bin", NATIVE_NAME));
    const before = statSync(native);
    const first = await locator.resolve();
    const bytes = readFileSync(native); bytes[bytes.length - 1] = 23;
    writeFileSync(native, bytes); utimesSync(native, before.atime, before.mtime);
    const second = await locator.resolve();
    expect(calls).toHaveLength(6);
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(readFileSync(first.executable)).not.toEqual(readFileSync(second.executable));
  });

  it("removes rejected copies while caching only the compatibility failure", async () => {
    const calls: string[][] = [];
    const { root, locator, dirs } = await locatorHarness({ calls, script: { version: "0.151.0" } });
    writeNative(join(root, "path-bin", NATIVE_NAME));
    for (let count = 0; count < 3; count += 1) {
      await expect(locator.resolve()).rejects.toMatchObject({ code: "codex-runtime-version-unsupported" });
      expect(readdirSync(join(dirs.home!, "runtime"))).toEqual([]);
    }
    expect(calls).toHaveLength(1);
  });

  it("shares one qualified copy concurrently and removes its own copies on disposal", async () => {
    const calls: string[][] = [];
    const { root, locator, dirs } = await locatorHarness({ calls });
    writeNative(join(root, "path-bin", NATIVE_NAME));
    const resolved = await Promise.all([locator.resolve(), locator.resolve()]);
    expect(resolved[0]!.executable).toBe(resolved[1]!.executable);
    expect(calls).toHaveLength(3);
    expect(readdirSync(join(dirs.home!, "runtime"))).toHaveLength(1);
    await locator.dispose(); await locator.dispose();
    expect(readdirSync(join(dirs.home!, "runtime"))).toEqual([]);
    await expect(locator.resolve()).rejects.toMatchObject({ code: "codex-runtime-start-failed" });
  });

  it("retains cleanup ownership after a removal error so disposal can retry", async () => {
    const { root, locator, dirs } = await locatorHarness();
    writeNative(join(root, "path-bin", NATIVE_NAME));
    const artifact = await locator.resolve();
    const remove = fs.rm.bind(fs);
    const failure = Object.assign(new Error("temporary cleanup failure"), { code: "EIO" });
    let failed = false;
    vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      if (!failed && String(args[0]) === dirname(artifact.executable)) { failed = true; throw failure; }
      return remove(...args);
    });
    await expect(locator.dispose()).rejects.toBe(failure);
    expect(readdirSync(join(dirs.home!, "runtime"))).toHaveLength(1);
    await locator.dispose();
    expect(readdirSync(join(dirs.home!, "runtime"))).toEqual([]);
  });

  it.each(["start-failed", "version-unsupported"] as const)("evicts a %s verdict when discard fails and retains cleanup ownership", async (failureKind) => {
    const calls: string[][] = [];
    const script: ProbeScript = failureKind === "start-failed" ? { fail: "version" } : { version: "0.1.0" };
    const { root, locator, dirs } = await locatorHarness({ script, calls });
    writeNative(join(root, "path-bin", NATIVE_NAME));
    const runtime = join(dirs.home!, "runtime");
    const remove = fs.rm.bind(fs);
    const failure = Object.assign(new Error("temporary cleanup failure"), { code: "EIO" });
    let failed = false;
    vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      if (!failed && String(args[0]).startsWith(join(runtime, "artifact-"))) { failed = true; throw failure; }
      return remove(...args);
    });
    await expect(locator.resolve()).rejects.toBe(failure);
    expect(calls).toHaveLength(1);
    expect(readdirSync(runtime)).toHaveLength(1);
    delete script.fail; delete script.version;
    await expect(locator.resolve()).resolves.toMatchObject({ version: "0.153.4" });
    expect(calls).toHaveLength(4);
    expect(readdirSync(runtime)).toHaveLength(1);
    await locator.dispose();
    expect(readdirSync(runtime)).toEqual([]);
  });

  it("bounds private copies while resolve cleanup keeps failing", async () => {
    const calls: string[][] = [];
    const script: ProbeScript = { fail: "version" };
    const { root, locator, dirs } = await locatorHarness({ script, calls });
    writeNative(join(root, "path-bin", NATIVE_NAME));
    const attempt = () => locator.resolve();
    const failedProbeCount = 1;
    const runtime = join(dirs.home!, "runtime");
    const remove = fs.rm.bind(fs);
    const failure = Object.assign(new Error("persistent cleanup failure"), { code: "EIO" });
    let blocked = true;
    vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      if (blocked && String(args[0]).startsWith(join(runtime, "artifact-"))) throw failure;
      return remove(...args);
    });
    await expect(attempt()).rejects.toBe(failure);
    delete script.fail;
    for (let retry = 0; retry < 3; retry += 1) {
      await expect(attempt()).rejects.toBe(failure);
      expect(readdirSync(runtime)).toHaveLength(1);
      expect(calls).toHaveLength(failedProbeCount);
    }
    blocked = false;
    await expect(locator.resolve()).resolves.toMatchObject({ version: "0.153.4" });
    expect(readdirSync(runtime)).toHaveLength(1);
    expect(calls).toHaveLength(failedProbeCount + 3);
    await locator.dispose();
    expect(readdirSync(runtime)).toEqual([]);
  });

  it("evicts a corrupted cached artifact and qualifies fresh source bytes on retry", async () => {
    const before = accessRuleProbes.count;
    const claimsBefore = accessRuleProbes.claims;
    const calls: string[][] = [];
    const { root, locator } = await locatorHarness({ calls });
    writeNative(join(root, "path-bin", NATIVE_NAME));
    const first = await locator.resolve();
    const bytes = readFileSync(first.executable); bytes[bytes.length - 1] = 9;
    chmodSync(first.executable, 0o700); writeFileSync(first.executable, bytes); chmodSync(first.executable, 0o500);
    await expect(locator.resolve()).rejects.toMatchObject({ code: "codex-runtime-invalid-executable" });
    const next = await locator.resolve();
    expect(next.executable).not.toBe(first.executable);
    expect(next.contentHash).toBe(first.contentHash);
    expect(calls).toHaveLength(6);
    // The unbatched admission used 54 probes for these three resolutions.
    if (HOST === "win32") expect(accessRuleProbes.count - before).toBeLessThanOrEqual(33);
    // One claim for the harness directories; each of the three copies claims its directory and its files; each of the two qualifications claims its probe
    // root and that root's four directories.
    if (HOST === "win32") expect(accessRuleProbes.claims - claimsBefore).toBe(1 + 3 * 2 + 2 * 2);
  });

  it("runs every probe against the same copy despite an injected source and ancestor replacement", async () => {
    let source: string;
    let original: Buffer;
    const paths: string[] = [];
    const base = scriptedRunner({});
    const run: CodexProbeRunner = async (executable, args, options) => {
      paths.push(executable);
      expect(executable).not.toBe(source);
      expect(readFileSync(executable)).toEqual(original);
      expect(options.env.CODEX_HOME).not.toBe(dirname(dirname(dirname(executable))));
      expect(options.env.CODEX_HOME!.startsWith(join(root, "temp", "probe-"))).toBe(true);
      if (args[0] === "--version") {
        renameSync(dirname(source), `${dirname(source)}-old`);
        writeScript(source, "#!/bin/sh\necho replaced\n");
      }
      return base(executable, args, options);
    };
    const { root, locator } = await locatorHarness({ run });
    source = writeNative(join(root, "path-bin", NATIVE_NAME)); original = readFileSync(source);
    const resolved = await locator.resolve();
    expect(new Set(paths)).toEqual(new Set([resolved.executable]));
    expect(paths).toHaveLength(3);
    await expect(verifyCodexExecutableArtifact(resolved)).resolves.toBeUndefined();
    expect(readFileSync(source, "utf8")).toContain("replaced");
  });

  it("rejects an injected text replacement between discovery and snapshot without probing", async () => {
    const calls: string[][] = [];
    const { root, locator } = await locatorHarness({ calls });
    const source = writeNative(join(root, "path-bin", NATIVE_NAME));
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] === source && typeof args[1] === "number") writeScript(source, "\x7fELF\necho replaced\n");
      return open(...args);
    });
    await expect(locator.resolve()).rejects.toMatchObject({ code: "codex-runtime-invalid-executable" });
    expect(calls).toEqual([]);
  });

  it.each(["EACCES", "EIO"])("propagates %s from lstat instead of selecting a later PATH candidate", async (code) => {
    const calls: string[][] = [];
    const { root, locator } = await locatorHarness({ calls,
      env: (base) => ({ PATH: [join(base, "first"), join(base, "second")].join(HOST === "win32" ? ";" : ":") }),
    });
    const first = join(root, "first", NATIVE_NAME); writeNative(first); writeNative(join(root, "second", NATIVE_NAME));
    const lstat = fs.lstat.bind(fs);
    const failure = Object.assign(new Error("unreadable candidate"), { code });
    vi.spyOn(fs, "lstat").mockImplementation((...args) => String(args[0]) === first ? Promise.reject(failure) : lstat(...args));
    await expect(locator.resolve()).rejects.toBe(failure);
    expect(calls).toEqual([]);
  });

  it.runIf(HOST !== "win32")("refuses a world-writable PATH directory and says why", async () => {
    const calls: string[][] = [];
    const { root, locator } = await locatorHarness({ calls });
    const source = writeNative(join(root, "path-bin", NATIVE_NAME)); chmodSync(dirname(source), 0o777);
    await expect(locator.resolve()).rejects.toMatchObject({ code: "codex-runtime-unsafe-location", message: expect.stringMatching(/writable/i) });
    expect(calls).toEqual([]);
  });

  it("copies the native companion and includes its bytes in compatibility-cache identity", async () => {
    const before = accessRuleProbes.count;
    const claimsBefore = accessRuleProbes.claims;
    const calls: string[][] = [];
    const { root, locator } = await locatorHarness({ calls });
    const source = writeNative(join(root, "path-bin", NATIVE_NAME));
    const helper = writeNative(join(dirname(source), HOST === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host"));
    const first = await locator.resolve();
    expect(first.companion).not.toBeNull();
    expect(dirname(first.companion!.executable)).toBe(dirname(first.executable));
    expect(readFileSync(first.companion!.executable)).toEqual(readFileSync(helper));
    const bytes = readFileSync(helper); bytes[bytes.length - 1] = 31; writeFileSync(helper, bytes);
    const second = await locator.resolve();
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.companion!.contentHash).not.toBe(first.companion!.contentHash);
    expect(calls).toHaveLength(6);
    // The unbatched companion path used 58 probes for these two resolutions.
    if (HOST === "win32") expect(accessRuleProbes.count - before).toBeLessThanOrEqual(30);
    // One claim for the harness directories; each of the two copies claims its directory and both files together; each qualification claims its probe root
    // and that root's four directories.
    if (HOST === "win32") expect(accessRuleProbes.claims - claimsBefore).toBe(1 + 2 * 2 + 2 * 2);
  });

  it("refuses a version below the minimum and keeps the version it found", async () => {
    const { root, locator } = await locatorHarness({ script: { version: "0.151.0" } });
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
    const { root, locator } = await locatorHarness({ script: { schemas, features } });
    writeNative(join(root, "path-bin", NATIVE_NAME));
    await expect(locator.resolve()).rejects.toMatchObject({
      code: "codex-runtime-incompatible",
      version: "0.153.4",
      missing: ["feature hooks", "request turn/interrupt"],
    });
  });

  it("treats missing schema documents as a mismatch", async () => {
    const { root, locator } = await locatorHarness({ script: { schemas: {} } });
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
      const { root, locator } = await locatorHarness({ script: { fail }, calls });
      writeNative(join(root, "path-bin", NATIVE_NAME));
      await expect(locator.resolve()).rejects.toMatchObject({ code: "codex-runtime-start-failed" });
      await expect(locator.resolve()).rejects.toMatchObject({ code: "codex-runtime-start-failed" });
      expect(calls.filter((args) => args[0] === "--version")).toHaveLength(2);
    },
  );

  it("finds a CLI installed after it reported none, without being pointed at it", async () => {
    // "Check again" on the settings card is just another resolve: the user installs the CLI and Ave finds it where the installer put it. Each platform's
    // installer writes to its own official location.
    const { root, locator } = await locatorHarness({
      env: (base) => ({ PATH: join(base, "path-bin"), LOCALAPPDATA: join(base, "local-app-data") }),
    });
    await expect(locator.resolve()).rejects.toMatchObject({ code: "codex-runtime-not-installed" });
    writeNative(HOST === "win32"
      ? join(root, "local-app-data", "Programs", "OpenAI", "Codex", "bin", NATIVE_NAME)
      : join(root, "user-home", ".local", "bin", NATIVE_NAME));
    await expect(locator.resolve()).resolves.toMatchObject({ version: "0.153.4" });
  });

  it("offers no way to choose or forget a path: discovery is the only source", async () => {
    const { locator } = await locatorHarness();
    expect("choose" in locator).toBe(false);
    expect("forget" in locator).toBe(false);
  });

  it("stops at the first CLI found when it is unusable instead of trying the next one", async () => {
    const { root, locator } = await locatorHarness({
      env: (base) => ({ PATH: [join(base, "first"), join(base, "second")].join(HOST === "win32" ? ";" : ":") }),
    });
    writeScript(join(root, "first", HOST === "win32" ? "codex.cmd" : "codex"));
    writeNative(join(root, "second", NATIVE_NAME));
    await expect(locator.resolve()).rejects.toMatchObject({ code: "codex-runtime-invalid-executable" });
  });

  it("runs real probes without a shell and reads their output", async () => {
    // A system utility reports no CLI version, so a completed real probe yields an invalid-executable verdict rather than a start failure. On Windows the
    // copy must start without sibling DLLs, which rules out the Electron test host and leaves the standalone Node it was launched from.
    const { root, locator } = await locatorHarness({ realProbes: true });
    const native = join(mkdirAndReturn(join(root, "path-bin")), NATIVE_NAME);
    const standalone = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
    copyFileSync(HOST === "win32" ? standalone : "/usr/bin/true", native); chmodSync(native, 0o700);
    await expect(locator.resolve()).rejects.toMatchObject({ code: "codex-runtime-invalid-executable" });
  });

  it.runIf(HOST !== "win32")("runs real probes from a host installed beneath a group-writable application directory", async () => {
    const { root, locator } = await locatorHarness({ realProbes: true });
    const native = join(mkdirAndReturn(join(root, "path-bin")), NATIVE_NAME);
    copyFileSync("/usr/bin/true", native); chmodSync(native, 0o700);
    const applications = join(root, "Applications");
    const hostDirectory = mkdirAndReturn(join(applications, "Ave.app", "Contents", "MacOS"));
    const execPath = join(hostDirectory, "Ave");
    symlinkSync(process.execPath, execPath);
    chmodSync(applications, 0o775);
    vi.stubGlobal("process", { ...process, execPath });
    expect(statSync(applications).mode & 0o777).toBe(0o775);
    await expect(locator.resolve()).rejects.toMatchObject({ code: "codex-runtime-invalid-executable" });
  });
});
