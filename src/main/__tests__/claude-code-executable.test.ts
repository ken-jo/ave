import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, constants, mkdirSync, mkdtempSync, promises as fs, readFileSync,
  readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NATIVE_PROBE_HEAVY_TEST, nativeExecutableBytes, normalizeFixtureAncestorPermissions, writeNativeExecutable,
} from "../../__tests__/support/native-executable.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { claudeCodeNpmShimTarget, pinClaudeCodeExecutable } from "../claude-code-executable.js";
import { ClaudeCodeSubscriptionClient, validateClaudeCodeRuntimeDirectories } from "../claude-code-subscription-client.js";
import * as locations from "../codex-executable-location.js";
import type { CliDiscoveryEnvironment } from "../user-cli-discovery.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await import("../../__tests__/support/native-executable.js")).maskFixtureAncestorAcl(await importOriginal()),
  spawn: vi.fn(() => { throw new Error("Unexpected executable launch"); }),
}));

const roots: string[] = [];
const fixtureTimestamp = new Date(1_700_000_000_000);
afterEach(async () => {
  expect(spawn).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  // A test may leave its sealed read-only copy undiscarded; the async removal clears the Windows read-only attribute that the synchronous one refuses.
  for (const root of roots.splice(0)) await cleanupTmpDir(root);
});

async function fixture(platform: NodeJS.Platform = process.platform) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-subscription-executable-")));
  roots.push(root);
  normalizeFixtureAncestorPermissions(root);
  const runtime = await locations.createPrivateDirectory(join(root, "runtime"));
  const bin = join(root, "bin");
  const source = writeNativeExecutable(join(bin, platform === "win32" ? "claude.exe" : "claude"), nativeExecutableBytes(platform));
  utimesSync(source, fixtureTimestamp, fixtureTimestamp);
  const discovery: CliDiscoveryEnvironment = { platform, env: { PATH: bin }, homeDir: root };
  return { root, runtime, bin, source, discovery };
}

async function npmFixture(platform: NodeJS.Platform = process.platform) {
  const base = await fixture(platform);
  const packageRoot = join(base.bin, "node_modules", "@anthropic-ai", "claude-code");
  mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
  const script = join(packageRoot, "cli.js");
  writeFileSync(script, "#!/usr/bin/env node\nconsole.log('fixture');\n", { mode: 0o700 });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code" }), { mode: 0o600 });
  const dependency = join(packageRoot, "runtime.js");
  writeFileSync(dependency, "export const value = 1;\n", { mode: 0o600 });
  const interpreter = writeNativeExecutable(join(base.bin, platform === "win32" ? "node.exe" : "node"), nativeExecutableBytes(platform));
  const launcher = platform === "win32" ? join(base.bin, "claude.cmd") : base.source;
  if (platform === "win32") {
    writeFileSync(launcher, '@ECHO off\r\n"%~dp0node.exe" "%~dp0node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n', { mode: 0o700 });
  } else {
    rmSync(launcher);
    symlinkSync(script, launcher);
  }
  for (const path of [script, dependency, interpreter, launcher]) utimesSync(path, fixtureTimestamp, fixtureTimestamp);
  return { ...base, packageRoot, script, dependency, interpreter, launcher };
}

function changeBytesKeepingMetadata(path: string): void {
  const original = statSync(path);
  const bytes = readFileSync(path);
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  chmodSync(path, 0o700);
  writeFileSync(path, bytes);
  utimesSync(path, original.atime, original.mtime);
  chmodSync(path, original.mode & 0o777);
  const changed = statSync(path);
  expect([changed.dev, changed.ino, changed.size]).toEqual([original.dev, original.ino, original.size]);
  expect(changed.mtimeMs).toBe(original.mtimeMs);
}

describe("subscription executable admission", () => {
  it("maps a guarded package location rejection to the npm guidance error", async () => {
    const { root, runtime, source } = await fixture();
    const rejected = new locations.CodexExecutableLocationError("Rejected package fixture");
    rejected.routeKind = "guarded-script";
    const client = new ClaudeCodeSubscriptionClient({ runtimeHome: runtime, workspaceDir: root,
      candidates: () => [source], _pinExecutableForTest: async () => { throw rejected; } });
    try { await expect(client.getStatus()).rejects.toMatchObject({ code: "claude-code-runtime-unsafe-npm-location" }); }
    finally { await client.stop(); }
  });

  it.each(["native", "guarded-script", "script"] as const)("maps a private directory rejection to unsafe-location with ancestor rule %s", async (rule) => {
    const directory = join(tmpdir(), "rejected-runtime");
    vi.spyOn(locations, "assertCodexLocations")
      .mockRejectedValue(new locations.CodexExecutableLocationError("Rejected fixture directory"));
    const code = rule === "guarded-script" ? "claude-code-runtime-unsafe-npm-location" : "claude-code-runtime-unsafe-location";
    await expect(validateClaudeCodeRuntimeDirectories([directory], rule)).rejects.toMatchObject({ code, message: code });
  });

  it("maps a rejected location to the unsafe-location code before probing", async () => {
    const { root, runtime, source } = await fixture();
    const rejected = new locations.CodexExecutableLocationError("Rejected fixture location");
    const client = new ClaudeCodeSubscriptionClient({
      runtimeHome: runtime, workspaceDir: root, candidates: () => [source],
      _pinExecutableForTest: async () => { throw rejected; },
    });
    try {
      await expect(client.getStatus()).rejects.toMatchObject({
        code: "claude-code-runtime-unsafe-location", message: "claude-code-runtime-unsafe-location",
      });
    } finally { await client.stop(); }
  });

  it("uses native ancestor rules for every native launch input and private directory", async () => {
    const { runtime, source, discovery } = await fixture();
    const executableLocation = vi.spyOn(locations, "assertCodexExecutableLocation").mockResolvedValue();
    const privateDirectory = vi.spyOn(locations, "assertCodexPrivateRuntimeDirectory").mockResolvedValue();
    const proof = await pinClaudeCodeExecutable(source, runtime, discovery);
    await proof.verify();
    expect(proof.routeKind).toBe("native");
    expect(executableLocation.mock.calls.length).toBeGreaterThan(0);
    expect(privateDirectory.mock.calls.length).toBeGreaterThan(0);
    expect(executableLocation.mock.calls.every(([, rule]) => rule === "native")).toBe(true);
    expect(privateDirectory.mock.calls.every(([, rule]) => rule === "native")).toBe(true);
    await proof.discard();
  });

  it("pins a hash and a sealed private native copy with no-follow opens", async () => {
    const { runtime, source, discovery } = await fixture();
    const open = vi.spyOn(fs, "open");
    const proof = await pinClaudeCodeExecutable(source, runtime, discovery);
    expect(proof.executable).not.toBe(source);
    expect(dirname(dirname(proof.executable))).toBe(runtime);
    expect(proof.args).toEqual([]);
    expect(readFileSync(proof.executable)).toEqual(readFileSync(source));
    expect(proof.identity).toContain(createHash("sha256").update(readFileSync(source)).digest("hex"));
    const creation = open.mock.calls.find(([, flags]) => typeof flags === "number" && (flags & constants.O_CREAT) !== 0)!;
    expect(Number(creation[1]) & constants.O_EXCL).toBe(constants.O_EXCL);
    if (process.platform !== "win32") {
      expect(Number(creation[1]) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      expect(statSync(proof.executable).mode & 0o777).toBe(0o500);
      expect(statSync(dirname(proof.executable)).mode & 0o777).toBe(0o700);
    }
    await expect(proof.verify()).resolves.toBeUndefined();
    await proof.discard();
    expect(readdirSync(runtime)).toEqual([]);
  });

  it("refuses the next verification after installed bytes change despite matching path and metadata", async () => {
    const { runtime, source, discovery } = await fixture();
    const proof = await pinClaudeCodeExecutable(source, runtime, discovery);
    const pinnedBytes = readFileSync(proof.executable);
    changeBytesKeepingMetadata(source);
    expect(readFileSync(proof.executable)).toEqual(pinnedBytes);
    await expect(proof.verify()).rejects.toThrow("Subscription executable changed");
  });

  it("refuses modified private bytes even after permissions and modification time are restored", async () => {
    const { runtime, source, discovery } = await fixture();
    const proof = await pinClaudeCodeExecutable(source, runtime, discovery);
    utimesSync(proof.executable, fixtureTimestamp, fixtureTimestamp);
    await expect(proof.verify()).resolves.toBeUndefined();
    changeBytesKeepingMetadata(proof.executable);
    await expect(proof.verify()).rejects.toThrow("Executable artifact changed");
  });

  it.skipIf(process.platform === "win32").each(["file", "parent"] as const)("rejects a writable %s before any executable runs", async (target) => {
    const { runtime, source, bin, discovery } = await fixture();
    chmodSync(target === "file" ? source : bin, 0o777);
    await expect(pinClaudeCodeExecutable(source, runtime, discovery)).rejects.toThrow("writable by another account");
    expect(readdirSync(runtime)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("rejects an untrusted intermediate symbolic-link owner", async () => {
    const { root, runtime, source, discovery } = await fixture();
    const relay = join(root, "relay");
    const launcher = join(root, "launcher");
    symlinkSync(source, relay);
    symlinkSync(relay, launcher);
    const lstat = vi.mocked(fs.lstat).getMockImplementation()!;
    vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      const result = await lstat(...args) as Stats;
      return String(args[0]) === relay
        ? Object.assign(Object.create(Object.getPrototypeOf(result)), result, { uid: (process.getuid?.() ?? 0) + 1 })
        : result;
    }) as typeof fs.lstat);
    await expect(pinClaudeCodeExecutable(launcher, runtime, discovery)).rejects.toThrow("untrusted owner");
    expect(readdirSync(runtime)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("rejects an unsafe intermediate symbolic-link parent", async () => {
    const { root, runtime, source, discovery } = await fixture();
    const unsafe = join(root, "unsafe");
    mkdirSync(unsafe, { mode: 0o700 });
    const relay = join(unsafe, "relay");
    symlinkSync(source, relay);
    const launcher = join(root, "launcher");
    symlinkSync(relay, launcher);
    chmodSync(unsafe, 0o777);
    await expect(pinClaudeCodeExecutable(launcher, runtime, discovery)).rejects.toThrow("writable by another account");
  });

  it("rejects a generic shell launcher instead of trying to execute it", async () => {
    const { source, runtime, discovery } = await fixture();
    writeFileSync(source, "#!/bin/sh\necho unsupported\n");
    await expect(pinClaudeCodeExecutable(source, runtime, discovery)).rejects.toThrow("Unsupported subscription launcher");
  });

  it.skipIf(process.platform === "win32").each(["file", "parent"] as const)("refuses an unsafe %s before the client's first probe without trying another candidate", async (target) => {
    const { root, runtime, source, bin, discovery } = await fixture();
    const trustedAlternative = writeNativeExecutable(join(root, "trusted", "claude"));
    chmodSync(target === "file" ? source : bin, 0o777);
    const probe = vi.fn(() => { throw new Error("Unexpected qualification probe"); });
    const client = new ClaudeCodeSubscriptionClient({
      runtimeHome: runtime,
      workspaceDir: root,
      platform: discovery.platform,
      env: discovery.env,
      homeDir: root,
      candidates: () => [source, trustedAlternative],
      spawn: probe,
    });
    try {
      await expect(client.getStatus()).rejects.toMatchObject({ code: "claude-code-runtime-unsafe-location" });
      expect(probe).not.toHaveBeenCalled();
      expect(readdirSync(runtime)).toEqual([]);
    } finally { await client.stop(); }
  });
});

describe("subscription package launch inputs", () => {
  it("uses guarded package routes and native interpreter routes without splitting the batch", NATIVE_PROBE_HEAVY_TEST, async () => {
    const { launcher, runtime, discovery } = await npmFixture("win32");
    const executableLocation = vi.spyOn(locations, "assertCodexExecutableLocation").mockResolvedValue();
    const privateDirectory = vi.spyOn(locations, "assertCodexPrivateRuntimeDirectory").mockResolvedValue();
    const batches = vi.spyOn(locations, "assertCodexLocations").mockResolvedValue();
    const proof = await pinClaudeCodeExecutable(launcher, runtime, discovery);
    await proof.verify();
    expect(proof.routeKind).toBe("guarded-script");
    expect(executableLocation.mock.calls.length).toBeGreaterThan(0);
    expect(privateDirectory.mock.calls.length).toBeGreaterThan(0);
    expect(batches.mock.calls.length).toBeGreaterThan(0);
    expect(executableLocation.mock.calls.every(([, rule]) => rule === "native" || rule === "guarded-script")).toBe(true);
    expect(privateDirectory.mock.calls.every(([, rule]) => rule === "guarded-script")).toBe(true);
    expect(batches.mock.calls.flatMap(([requests]) => requests).every((request) => request.routeKind === "guarded-script")).toBe(true);
    await proof.discard();
  });

  it.skipIf(process.platform === "win32")("pins a package script and a private native interpreter through a protected launcher link", async () => {
    const { launcher, runtime, discovery, script, interpreter } = await npmFixture();
    const proof = await pinClaudeCodeExecutable(launcher, runtime, discovery);
    expect(proof.args.slice(0, 2)).toEqual(["--no-global-search-paths", "--import"]);
    expect(proof.args[2]).toMatch(/^file:/);
    expect(proof.args[5]).not.toBe(script);
    expect(readFileSync(proof.args[5]!)).toEqual(readFileSync(script));
    expect(proof.executable).not.toBe(interpreter);
    expect(readFileSync(proof.executable)).toEqual(readFileSync(interpreter));
    await expect(proof.verify()).resolves.toBeUndefined();
  });

  it("resolves a batch-only installation to its package entry and a private native interpreter without a shell", NATIVE_PROBE_HEAVY_TEST, async () => {
    const { launcher, runtime, discovery, script, interpreter } = await npmFixture("win32");
    expect(claudeCodeNpmShimTarget(launcher)).toBe(script);
    const proof = await pinClaudeCodeExecutable(launcher, runtime, discovery);
    expect(proof.args.slice(0, 2)).toEqual(["--no-global-search-paths", "--import"]);
    expect(proof.args[2]).toMatch(/^file:/);
    expect(proof.args[5]).not.toBe(script);
    expect(readFileSync(proof.args[5]!)).toEqual(readFileSync(script));
    expect(proof.executable).not.toBe(interpreter);
    expect(proof.executable.endsWith("runtime.exe")).toBe(true);
    expect(readFileSync(proof.executable)).toEqual(nativeExecutableBytes("win32"));
    await expect(proof.verify()).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("pins the absolute shebang interpreter instead of another interpreter from the search path", async () => {
    const fixture = await npmFixture();
    const bytes = nativeExecutableBytes();
    bytes[bytes.length - 1] = 47;
    const exactInterpreter = writeNativeExecutable(join(fixture.root, "exact-interpreter", "node"), bytes);
    writeFileSync(fixture.script, `#!${exactInterpreter}\nconsole.log('fixture');\n`);
    const proof = await pinClaudeCodeExecutable(fixture.launcher, fixture.runtime, fixture.discovery);
    expect(readFileSync(proof.executable)).toEqual(bytes);
    expect(readFileSync(proof.executable)).not.toEqual(readFileSync(fixture.interpreter));
    await expect(proof.verify()).resolves.toBeUndefined();
  });

  it("resolves native batch paths independently of the host operating system", () => {
    expect(claudeCodeNpmShimTarget("C:\\Users\\example\\AppData\\Roaming\\npm\\claude.cmd", "win32"))
      .toBe("C:\\Users\\example\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js");
  });

  it("rejects a batch launcher with a different basename", () => {
    expect(() => claudeCodeNpmShimTarget(join(tmpdir(), "other.cmd"))).toThrow("Invalid subscription launcher");
  });

  it.each(["script", "dependency", "interpreter", "launcher"] as const)("refuses a changed %s after package verification", async (target) => {
    const fixture = await npmFixture("win32");
    const proof = await pinClaudeCodeExecutable(fixture.launcher, fixture.runtime, fixture.discovery);
    changeBytesKeepingMetadata(fixture[target]);
    await expect(proof.verify()).rejects.toThrow("Subscription executable changed");
  });

  it("refuses a package with a different declared identity", async () => {
    const fixture = await npmFixture("win32");
    writeFileSync(join(fixture.packageRoot, "package.json"), JSON.stringify({ name: "unrelated-package" }));
    await expect(pinClaudeCodeExecutable(fixture.launcher, fixture.runtime, fixture.discovery)).rejects.toThrow("Invalid subscription package");
  });

  it("refuses a package script that requires a shell interpreter", async () => {
    const fixture = await npmFixture("win32");
    writeFileSync(fixture.script, "#!/bin/sh\necho unsupported\n");
    await expect(pinClaudeCodeExecutable(fixture.launcher, fixture.runtime, fixture.discovery)).rejects.toThrow("Unsupported subscription interpreter");
  });

  it.skipIf(process.platform === "win32")("refuses an untrusted interpreter before creating an artifact", async () => {
    const fixture = await npmFixture("win32");
    chmodSync(fixture.interpreter, 0o777);
    await expect(pinClaudeCodeExecutable(fixture.launcher, fixture.runtime, fixture.discovery)).rejects.toThrow("writable by another account");
    expect(readdirSync(fixture.runtime)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("refuses links from the pinned package to external code", async () => {
    const fixture = await npmFixture("win32");
    symlinkSync(fixture.interpreter, join(fixture.packageRoot, "external.js"));
    await expect(pinClaudeCodeExecutable(fixture.launcher, fixture.runtime, fixture.discovery)).rejects.toThrow("contains a symbolic link");
  });
});
