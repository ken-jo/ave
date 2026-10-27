import type * as ChildProcessModule from "node:child_process";
import { windowsPowerShellEnv } from "../../shared/windows-powershell-env.js";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, promises as fs, realpathSync, type Stats, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import type { CodexExecutableArtifact } from "../../main/codex-executable-artifact.js";
// Keep process execution imports out so process-module mock factories can load this helper.
import { WindowsAclHost, WindowsAclHostError, _setWindowsAclTransportForTest, type WindowsAclTransport } from "../../main/windows-acl-host.js";
import { configureHostResources } from "../../main/host-resources.js";

const readLstat = fs.lstat.bind(fs);
const fixtureAncestors = new Set<string>();
// Capture TEMP at load so tests may replace it before fixture construction.
const fixtureTempRoot = tmpdir();
let fixtureCurrentSid: Promise<string> | undefined;

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

export function normalizeFixtureAncestorPermissions(root: string): void {
  for (let current = dirname(resolve(root)); ; current = dirname(current)) {
    fixtureAncestors.add(process.platform === "win32" ? windowsPathKey(current) : current);
    if (dirname(current) === current) break;
  }
  if (process.platform === "win32") {
    // Load lazily to avoid cycling through the process-module mock factory.
    const { execFileSync } = createRequire(import.meta.url)("node:child_process") as typeof ChildProcessModule;
    // Confine ACL changes to fixture roots; inherited drive-wide grants invalidate private-copy tests.
    const fixtureRoot = realpathSync(root);
    const insideTemp = relative(realpathSync(fixtureTempRoot), fixtureRoot);
    if (!insideTemp || insideTemp === ".." || insideTemp.startsWith(`..${win32.sep}`) || isAbsolute(insideTemp)) {
      throw new Error("Private fixture must be inside the test temporary directory");
    }
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
      "$acl = [System.Security.AccessControl.DirectorySecurity]::new()",
      "$acl.SetAccessRuleProtection($true, $false)",
      "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')",
      "$acl.AddAccessRule($rule)",
      "Set-Acl -LiteralPath $env:AVE_PRIVATE_FIXTURE -AclObject $acl",
    ].join("\n");
    execFileSync(win32.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, env: windowsPowerShellEnv({ ...process.env, AVE_PRIVATE_FIXTURE: fixtureRoot }) });
    return;
  }
  vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
    const stat = await readLstat(...args) as Stats;
    if (!fixtureAncestors.has(String(args[0]))) return stat;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { mode: stat.mode & ~0o022 });
  }) as typeof fs.lstat);
}

/** Windows ACL host startup can exceed the default wait budget. */
export const NATIVE_LOCATION_WAIT = { timeout: process.platform === "win32" ? 15_000 : 1_000 } as const;

/** Serial ACL requests need a larger Windows test budget under parallel load. */
export const NATIVE_PROBE_HEAVY_TEST = process.platform === "win32" ? { timeout: 240_000 } : {};

export function installFixtureAclTransport(transport: WindowsAclTransport): void {
  _setWindowsAclTransportForTest(transport);
}

export const fixtureAclHost: { current?: WindowsAclHost } = {};

/** Keep real host replies while masking fixture ancestors; spawn outside suite mocks. */
export function maskFixtureAncestorAclTransport(spawn: typeof ChildProcessModule.spawn): WindowsAclTransport {
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  const host = new WindowsAclHost((command, args, options) => spawn(command, args, options));
  fixtureAclHost.current = host;
  return {
    async request(request, launch, limits) {
      const reply = await host.request(request, launch, limits);
      try {
        // Rewrite only strict ancestors; preserve real ACLs for the fixture tree.
        const envelope = JSON.parse(reply.replace(/^﻿/, "")) as { id: unknown; result: { currentSid: string; paths: { path: string }[] } };
        const { result } = envelope;
        result.paths = result.paths.map((path) => fixtureAncestors.has(windowsPathKey(path.path))
          ? { ...path, owner: result.currentSid, daclPresent: true, entries: [{ sid: result.currentSid, mask: 0x1f01ff, flags: 0, type: 0 }] }
          : path);
        return JSON.stringify(envelope);
      } catch {
        return reply;
      }
    },
    discard: () => host.discard(),
  };
}

export function maskFixtureAncestorAcl(actual: typeof ChildProcessModule): typeof ChildProcessModule {
  if (process.platform !== "win32") return actual;
  installFixtureAclTransport(maskFixtureAncestorAclTransport(actual.spawn));
  return actual;
}

export function fakeFixtureAclTransport(execFile: typeof ChildProcessModule.execFile): WindowsAclTransport {
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  return {
    async request(request) {
      try {
        // Open the path object itself, including reparse points.
        for (const path of request.paths) await readLstat(path);
        fixtureCurrentSid ??= new Promise<string>((resolveSid, reject) => {
          execFile(win32.join(process.env.SystemRoot!, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
            windowsHide: true,
            encoding: "utf8",
          }, (error, stdout) => {
            if (error) return reject(error);
            const sid = /\bS-1-(?:\d+-)*\d+\b/.exec(stdout)?.[0];
            if (!sid) return reject(new Error("Current account SID is unavailable"));
            resolveSid(sid);
          });
        }).catch((error: unknown) => {
          fixtureCurrentSid = undefined;
          throw error;
        });
        const currentSid = await fixtureCurrentSid;
        return JSON.stringify({
          id: request.id,
          result: {
            currentSid,
            paths: request.paths.map((path) => ({
              path, owner: currentSid, daclPresent: true,
              entries: [{ sid: currentSid, mask: 0x1f01ff, flags: 0, type: 0 }],
            })),
            desktopPackage: request.skipPackage ? { status: "skipped" } : { status: "unavailable", reason: "mapping-not-found" },
            ...request.setOwner ? { claims: request.paths.map((path) => ({ path, previousOwner: currentSid, outcome: "kept" })) } : {},
          },
        });
      } catch (cause) {
        // A failed path open ends the host instead of reporting spawn ENOENT.
        throw new WindowsAclHostError(String(cause));
      }
    },
    discard() {},
  };
}

export function fakeFixtureAcl(actual: typeof ChildProcessModule): typeof ChildProcessModule {
  if (process.platform !== "win32") return actual;
  installFixtureAclTransport(fakeFixtureAclTransport(actual.execFile));
  return actual;
}

export async function codexExecutableArtifactFixture(home: string): Promise<CodexExecutableArtifact> {
  const { createPrivateDirectory, createPrivateObjects, createPrivateTempDirectory } = await import("../../main/codex-executable-location.js");
  const parent = await createPrivateDirectory(join(home, "runtime"));
  const directory = await createPrivateTempDirectory(join(parent, "artifact-"));
  const bytes = nativeExecutableBytes();
  const executable = await createPrivateObjects(async (created) => {
    const path = writeNativeExecutable(join(directory, process.platform === "win32" ? "codex.exe" : "codex"), bytes, 0o500);
    created.push(path);
    return path;
  });
  return { executable, contentHash: createHash("sha256").update(bytes).digest("hex"), companion: null };
}
