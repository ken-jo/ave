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
  nativeExecutableBytes, normalizeFixtureAncestorPermissions, writeNativeExecutable,
} from "../../__tests__/support/native-executable.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { ClaudeCodeNativeRequiredError, pinClaudeCodeExecutable } from "../claude-code-executable.js";
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
  it("maps a native private directory rejection to the location code", async () => {
    const directory = join(tmpdir(), "rejected-runtime");
    vi.spyOn(locations, "assertCodexLocations").mockRejectedValue(new locations.CodexExecutableLocationError("Rejected fixture directory"));
    await expect(validateClaudeCodeRuntimeDirectories([directory])).rejects.toMatchObject({ code: "claude-code-runtime-unsafe-location" });
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
    expect(proof).not.toHaveProperty("args");
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
    await expect(pinClaudeCodeExecutable(source, runtime, discovery)).rejects.toBeInstanceOf(ClaudeCodeNativeRequiredError);
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

describe("unsupported subscription installations", () => {
  it.each(["darwin", "win32"] as const)("refuses a package launcher on %s without probing it or choosing a later native install", async (platform) => {
    const f = await npmFixture(platform);
    const spawn = vi.fn(() => { throw new Error("Unexpected process launch"); });
    const client = new ClaudeCodeSubscriptionClient({ runtimeHome: f.runtime, workspaceDir: f.root,
      platform, env: f.discovery.env, homeDir: f.root, candidates: () => [f.launcher, f.interpreter], spawn });
    try {
      await expect(client.getStatus()).rejects.toMatchObject({ code: "claude-code-runtime-native-required" });
      await expect(client.startBrowserLogin()).rejects.toMatchObject({ code: "claude-code-runtime-native-required" });
      expect(spawn).not.toHaveBeenCalled();
      expect(readdirSync(f.runtime)).toEqual([]);
    } finally { await client.stop(); }
  });

  it.each(["claude-code", "claude-code-darwin-arm64"])("refuses native bytes managed by a package installation %s", async (packageName) => {
    const f = await fixture();
    const target = writeNativeExecutable(join(f.bin, "node_modules", "@anthropic-ai", packageName, "claude"));
    await expect(pinClaudeCodeExecutable(target, f.runtime, f.discovery)).rejects.toBeInstanceOf(ClaudeCodeNativeRequiredError);
    expect(readdirSync(f.runtime)).toEqual([]);
  });

  it("refuses a symlink to a package-managed native binary", async () => {
    const f = await fixture();
    const target = writeNativeExecutable(join(f.bin, "node_modules", "@anthropic-ai", "claude-code", "native"));
    const launcher = join(f.bin, "package-link");
    symlinkSync(target, launcher);
    await expect(pinClaudeCodeExecutable(launcher, f.runtime, f.discovery)).rejects.toBeInstanceOf(ClaudeCodeNativeRequiredError);
    expect(readdirSync(f.runtime)).toEqual([]);
  });
});
