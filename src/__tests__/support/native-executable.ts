import type * as ChildProcessModule from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, promises as fs, type Stats, writeFileSync } from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import { vi } from "vitest";
import type { CodexExecutableArtifact } from "../../main/codex-executable-artifact.js";

const readLstat = fs.lstat.bind(fs);
const fixtureAncestors = new Set<string>();

/** Loader-shaped bytes for format tests; probes use an injected runner. */
export function nativeExecutableBytes(platform: NodeJS.Platform = process.platform, arch: NodeJS.Architecture = process.arch): Buffer {
  const bytes = Buffer.alloc(4096);
  if (platform === "linux") {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    bytes.writeUInt16LE(2, 16);
    bytes.writeUInt16LE(arch === "arm64" ? 183 : 62, 18);
    bytes.writeUInt32LE(1, 20);
    bytes.writeBigUInt64LE(0x400080n, 24);
    bytes.writeBigUInt64LE(64n, 32);
    bytes.writeUInt16LE(64, 52);
    bytes.writeUInt16LE(56, 54);
    bytes.writeUInt16LE(1, 56);
    bytes.writeUInt32LE(1, 64);
    bytes.writeUInt32LE(5, 68);
    bytes.writeBigUInt64LE(0x400000n, 80);
    bytes.writeBigUInt64LE(BigInt(bytes.length), 96);
    bytes.writeBigUInt64LE(BigInt(bytes.length), 104);
    bytes.writeBigUInt64LE(4096n, 112);
  } else if (platform === "darwin") {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
    bytes.writeUInt32LE(2, 12);
    bytes.writeUInt32LE(2, 16);
    bytes.writeUInt32LE(96, 20);
    bytes.writeUInt32LE(0x19, 32);
    bytes.writeUInt32LE(72, 36);
    bytes.writeBigUInt64LE(4096n, 64);
    bytes.writeBigUInt64LE(4096n, 80);
    bytes.writeUInt32LE(5, 88);
    bytes.writeUInt32LE(5, 92);
    bytes.writeUInt32LE(0x80000028, 104);
    bytes.writeUInt32LE(24, 108);
    bytes.writeBigUInt64LE(128n, 112);
  } else {
    bytes.writeUInt16LE(0x5a4d, 0);
    bytes.writeUInt32LE(128, 60);
    bytes.writeUInt32LE(0x00004550, 128);
    bytes.writeUInt16LE(arch === "arm64" ? 0xaa64 : 0x8664, 132);
    bytes.writeUInt16LE(1, 134);
    bytes.writeUInt16LE(240, 148);
    bytes.writeUInt16LE(2, 150);
    bytes.writeUInt16LE(0x20b, 152);
    bytes.writeUInt32LE(4096, 168);
    bytes.writeUInt32LE(4096, 184);
    bytes.writeUInt32LE(512, 188);
    bytes.writeUInt32LE(8192, 208);
    bytes.writeUInt32LE(512, 212);
    bytes.writeUInt32LE(16, 260);
    bytes.writeUInt32LE(512, 400);
    bytes.writeUInt32LE(4096, 404);
    bytes.writeUInt32LE(512, 408);
    bytes.writeUInt32LE(512, 412);
    bytes.writeUInt32LE(0x60000020, 428);
  }
  return bytes;
}

export function writeNativeExecutable(path: string, bytes = nativeExecutableBytes(), mode = 0o755): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes);
  chmodSync(path, mode);
  return path;
}

const windowsPathKey = (path: string): string => win32.normalize(path).replace(/[\\/]+$/, "").toLowerCase();

/** Tests own their tree; the host's shared temporary ancestors are outside it. */
export function normalizeFixtureAncestorPermissions(root: string): void {
  for (let current = dirname(resolve(root)); ; current = dirname(current)) {
    fixtureAncestors.add(process.platform === "win32" ? windowsPathKey(current) : current);
    if (dirname(current) === current) break;
  }
  if (process.platform === "win32") return;
  vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
    const stat = await readLstat(...args) as Stats;
    if (!fixtureAncestors.has(String(args[0]))) return stat;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { mode: stat.mode & ~0o022 });
  }) as typeof fs.lstat);
}

/**
 * Wait budget for steps gated on a native location check. On Windows each
 * check runs a PowerShell ACL probe that alone takes most of a second, so the
 * one-second `vi.waitFor` default races it; elsewhere the default stands.
 */
export const NATIVE_LOCATION_WAIT = { timeout: process.platform === "win32" ? 15_000 : 1_000 } as const;

/**
 * Test budget for the few Windows tests that admit a whole fixture through
 * serial ACL probes: about 65 PowerShell probes at ~0.6 s each, ~40 s with
 * the machine idle, which parallel load pushes past the 45-second default.
 * The tests assert admission outcomes, not speed.
 */
export const NATIVE_PROBE_HEAVY_TEST = process.platform === "win32" ? { timeout: 240_000 } : {};

/** Windows counterpart: the real ACL probe runs, then fixture ancestors read as owner-only. */
export function maskFixtureAncestorAcl(actual: typeof ChildProcessModule): typeof ChildProcessModule {
  if (process.platform !== "win32") return actual;
  const execFile = ((...args: unknown[]) => {
    const [file, argv, options, callback] = args as [string, string[], ChildProcessModule.ExecFileOptions, Function];
    if (typeof options?.env?.AVE_EXECUTABLE_ACL_PATHS !== "string" || typeof callback !== "function") {
      return (actual.execFile as (...rest: unknown[]) => ChildProcessModule.ChildProcess)(...args);
    }
    return actual.execFile(file, argv, options, (error, stdout, stderr) => {
      if (error) return callback(error, stdout, stderr);
      let masked: string;
      try {
        // Only strict ancestors are rewritten; the fixture root and its tree keep their real ACLs.
        const result = JSON.parse(String(stdout).replace(/^﻿/, "")) as { currentSid: string; paths: { path: string }[] };
        result.paths = result.paths.map((path) => fixtureAncestors.has(windowsPathKey(path.path))
          ? { ...path, owner: result.currentSid, daclPresent: true, entries: [{ sid: result.currentSid, mask: 0x1f01ff, flags: 0, type: 0 }] }
          : path);
        masked = JSON.stringify(result);
      } catch {
        masked = stdout as string;
      }
      callback(error, masked, stderr);
    });
  }) as typeof actual.execFile;
  return { ...actual, execFile };
}

export function codexExecutableArtifactFixture(home: string): CodexExecutableArtifact {
  const parent = join(home, "runtime");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(parent, "artifact-"));
  const bytes = nativeExecutableBytes();
  const executable = writeNativeExecutable(join(directory, process.platform === "win32" ? "codex.exe" : "codex"), bytes, 0o500);
  return { executable, contentHash: createHash("sha256").update(bytes).digest("hex"), companion: null };
}
