import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir, type } from "node:os";
import { basename, dirname, join } from "node:path";

import { posixHomeProtectionFailure } from "../shared/ave-home.js";
import { writeExitDiagnostic } from "../shared/exit-diagnostic.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import SRT_WIN_BUILD_RECEIPTS from "./generated/srt-win-build-receipts.js";
import { _registerSrtWinCopyForTest, _srtWinTempRootForTest } from "./srt-win-copy-owner.js";
import SRT_WIN_PINS from "./srt-win-pins.json" with { type: "json" };
import { runWindowsSrtWinParent } from "./srt-win-private-parent.js";

export class SrtWinIntegrityError extends Error {
  constructor(readonly code: "srt-win-integrity-mismatch" | "srt-win-not-found", options?: ErrorOptions) {
    super(code === "srt-win-not-found" ? "Windows sandbox helper is missing" : "Windows sandbox helper integrity verification failed", options);
    this.name = "SrtWinIntegrityError";
  }
}

export function assertSrtWinDigest(bytes: Uint8Array, arch: string): void {
  const receipt = Object.hasOwn(SRT_WIN_BUILD_RECEIPTS, arch) ? SRT_WIN_BUILD_RECEIPTS[arch] : undefined;
  const target = arch === "x64" ? "x86_64-pc-windows-msvc" : arch === "arm64" ? "aarch64-pc-windows-msvc" : undefined;
  if (!receipt || !target || receipt.schemaVersion !== 1 ||
      receipt.sourceRevision !== SRT_WIN_PINS.source.revision || receipt.sourceArchiveSha256 !== SRT_WIN_PINS.source.sha256 ||
      receipt.nativePatchSha256 !== SRT_WIN_PINS.nativePatchSha256 || receipt.rustToolchain !== SRT_WIN_PINS.rustToolchain ||
      receipt.target !== target || createHash("sha256").update(bytes).digest("hex") !== receipt.binarySha256) {
    throw new SrtWinIntegrityError("srt-win-integrity-mismatch");
  }
}

const COPY_NAME = /^copy-([0-9]{1,10})-[a-f0-9]{32}$/;

function helperTempRoot(): string {
  const temp = tmpdir();
  return _srtWinTempRootForTest(temp) ?? temp;
}

const MAC_ACL_COMMAND_OPTIONS = {
  encoding: "utf8",
  env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  timeout: TOOL_TIMEOUT_POLICY.windowsAclRequestMs,
} as const;

function assertPosixHelperBoundary(parent: string, allowMissing = false): void {
  if (posixHomeProtectionFailure(parent, { allowMissing }) !== undefined) throw new Error("Private helper path is not protected");
  if (type() !== "Darwin") return;

  const paths: string[] = [];
  // All components of this canonical path can affect the private parent's name.
  for (let path = allowMissing ? dirname(parent) : parent;; path = dirname(path)) {
    paths.push(path);
    if (path === dirname(path)) break;
  }
  // Escape filenames and print ACL entries even when the mode row displays an xattr marker.
  const output = execFileSync("/bin/ls", ["-ldebn", "--", ...paths], MAC_ACL_COMMAND_OPTIONS);
  let directoryCount = 0;
  for (const row of output.trimEnd().split("\n")) {
    if (/^d[rwxstST-]{9}[+@ ] /.test(row)) directoryCount++;
    else if (!/^ \d+: [\da-f-]{36} (?:inherited )?deny [a-z_,]+$/i.test(row)) {
      throw new Error("Private helper path has an extended access grant or unreadable ACL");
    }
  }
  if (directoryCount !== paths.length) throw new Error("Private helper path ACL is unverified");
}

// A sticky or private temporary hierarchy protects the verified parent from replacement.
function posixPrivateParent(temp: string, create = false): string | undefined {
  const uid = process.geteuid?.();
  if (uid === undefined) throw new Error("Private helper owner is unavailable");
  const parent = join(temp, `ave-srt-win.${uid}`);
  if (create && lstatSync(parent, { throwIfNoEntry: false }) === undefined) {
    assertPosixHelperBoundary(parent, true);
    let created = false;
    try {
      mkdirSync(parent, { mode: 0o700 });
      created = true;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (created && type() === "Darwin") execFileSync("/bin/chmod", ["-N", parent], MAC_ACL_COMMAND_OPTIONS);
  }
  const entry = lstatSync(parent, { throwIfNoEntry: false });
  if (entry === undefined && !create) return undefined;
  if (!entry?.isDirectory() || (entry.mode & 0o7777) !== 0o700) {
    throw new Error("Private helper parent is not protected");
  }
  assertPosixHelperBoundary(parent);
  return parent;
}

function removePosixTree(path: string): void {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry === undefined) return;
  if (entry.isDirectory()) {
    for (const name of readdirSync(path)) removePosixTree(join(path, name));
    rmdirSync(path);
  } else {
    unlinkSync(path);
  }
}

function hasLiveOwner(name: string): boolean {
  const match = COPY_NAME.exec(name);
  if (match === null) return false;
  const pid = Number(match[1]);
  if (pid <= 0 || pid > 0x7fff_ffff) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function sweepTempRoot(temp: string, windows: boolean): void {
  try {
    const canonical = realpathSync.native(temp);
    if (windows) {
      runWindowsSrtWinParent("sweep", canonical, { legacyTemp: temp });
      return;
    }
    const parent = posixPrivateParent(canonical);
    if (parent === undefined) return;
    for (const name of readdirSync(parent)) {
      // A live PID only defers removal. The verified parent authorizes the sweep.
      if (hasLiveOwner(name)) continue;
      try { removePosixTree(join(parent, name)); }
      catch { /* A later startup can reclaim this copy. */ }
    }
  } catch { /* Missing or unverified storage cannot authorize cleanup. */ }
}

export function sweepStaleSrtWinDirectories(): void {
  sweepTempRoot(helperTempRoot(), type() === "Windows_NT");
}

// The bundled helper supports two architectures; 32-bit hosts use x64.
export function getSrtWinArchitecture(arch: string = process.arch): "arm64" | "x64" {
  return arch === "arm64" ? "arm64" : "x64";
}

let swept = false;

const copies = new Map<string, { readonly executable: string; readonly arch: string }>();
const copyDisposers = new Set<() => void>();

function ownPrivateCopy(directory: string, remove: () => void): () => void {
  const dispose = (): void => {
    if (copyDisposers.delete(dispose)) remove();
  };
  copyDisposers.add(dispose);
  _registerSrtWinCopyForTest(directory, dispose);
  return dispose;
}

function readHelper(path: string): Buffer {
  try {
    if (!lstatSync(path).isFile()) throw new SrtWinIntegrityError("srt-win-integrity-mismatch");
    return readFileSync(path);
  } catch (error) {
    if (error instanceof SrtWinIntegrityError) throw error;
    throw new SrtWinIntegrityError((error as NodeJS.ErrnoException).code === "ENOENT"
      ? "srt-win-not-found" : "srt-win-integrity-mismatch");
  }
}

function verifyCopyParent(executable: string, windows: boolean): void {
  const parent = dirname(dirname(dirname(executable)));
  const temp = dirname(parent);
  if (windows) runWindowsSrtWinParent("verify", temp, { expectedParent: basename(parent) });
  else if (posixPrivateParent(temp) !== parent) throw new Error("Private helper parent is missing");
}

// Execute a private verified snapshot. Keep it for process lifetime because status, install and teardown re-spawn it.
export function prepareSrtWinExecutable(source: string, arch = getSrtWinArchitecture()): string {
  const windows = type() === "Windows_NT";
  const requestedTemp = helperTempRoot();
  if (!swept) {
    swept = true;
    sweepTempRoot(requestedTemp, windows);
  }
  const bytes = readHelper(source);
  assertSrtWinDigest(bytes, arch);
  const key = `${arch}:${source}`;
  const cached = copies.get(key);
  let dispose: (() => void) | undefined;
  try {
    if (cached) {
      verifyCopyParent(cached.executable, windows);
      assertSrtWinDigest(readHelper(cached.executable), arch);
      return cached.executable;
    }
    const temp = realpathSync.native(requestedTemp);
    const name = `copy-${process.pid}-${randomBytes(16).toString("hex")}`;
    let directory: string | undefined;
    if (windows) {
      runWindowsSrtWinParent("allocate", temp, { copy: name, bytes, onAllocated: (sid) => {
        directory = join(temp, `ave-srt-win.${sid}`, name);
        const allocated = directory;
        dispose = ownPrivateCopy(directory, () => {
          if (lstatSync(allocated, { throwIfNoEntry: false }) !== undefined) runWindowsSrtWinParent("dispose", temp, { copy: name });
        });
      } });
    } else {
      const parent = posixPrivateParent(temp, true);
      if (parent === undefined) throw new Error("Private helper parent is missing");
      directory = join(parent, name);
      mkdirSync(directory, { mode: 0o700 });
      const allocated = directory;
      dispose = ownPrivateCopy(directory, () => {
        if (posixPrivateParent(temp) !== undefined) removePosixTree(allocated);
      });
      const bin = join(directory, "bin");
      mkdirSync(bin, { mode: 0o700 });
      writeFileSync(join(bin, "srt-win.exe"), bytes, { flag: "wx", mode: 0o700 });
    }
    if (directory === undefined) throw new Error("Private helper creation was not confirmed");
    const executable = join(directory, "bin", "srt-win.exe");
    assertSrtWinDigest(readHelper(executable), arch);
    copies.set(key, { executable, arch });
    return executable;
  } catch (error) {
    try { dispose?.(); } catch { /* Startup can reclaim partial copies. */ }
    if (error instanceof SrtWinIntegrityError) throw error;
    throw new SrtWinIntegrityError("srt-win-integrity-mismatch", { cause: error });
  }
}

export function srtWinPrivateDirectories(): string[] {
  // The native parent delete-child deny must stay inside the private outer directory.
  return [...copies.values()].map((copy) => dirname(copy.executable));
}

// Recheck immediately before each host-controlled helper spawn.
export function assertSrtWinSpawnIntegrity(executable: string): void {
  if (process.platform !== "win32" || basename(executable).toLowerCase() !== "srt-win.exe") return;
  const copy = [...copies.values()].find((candidate) => candidate.executable === executable);
  if (!copy) throw new SrtWinIntegrityError("srt-win-integrity-mismatch");
  try { verifyCopyParent(executable, true); }
  catch (cause) { throw new SrtWinIntegrityError("srt-win-integrity-mismatch", { cause }); }
  assertSrtWinDigest(readHelper(executable), copy.arch);
}

// The sandbox runtime spawns this copy again when its session reset revokes and restores the session's ACEs. The quit sequence awaits that reset
// before the process exits; until it has succeeded, the copy must survive this module's exit handler, which Node runs before the runtime's own
// (registered later, at initialize), so that handler or the next boot can retry the release.
let runtimeReleasePending = false;

export function markSrtWinRuntimeReleasePending(): void {
  if (copies.size > 0) runtimeReleasePending = true;
}

export function markSrtWinRuntimeReleased(): void {
  runtimeReleasePending = false;
}

export function isSrtWinRuntimeReleasePending(): boolean {
  return runtimeReleasePending;
}

process.once("exit", () => {
  if (copyDisposers.size === 0) return;
  if (runtimeReleasePending) {
    // The runtime's exit handler runs next and still finds the copy; the next boot's stale-copy sweep removes it, and its ACL recovery covers a crash.
    writeExitDiagnostic("srt-win: sandbox session was not released before exit; the private helper copy is kept for the runtime's exit handler, the next boot's sweep and ACL recovery");
    return;
  }
  for (const dispose of copyDisposers) {
    try { dispose(); } catch { /* The next startup can reclaim the copy. */ }
  }
});
