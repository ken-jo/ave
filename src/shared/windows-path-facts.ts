import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, win32 } from "node:path";
import { toUSVString } from "node:util";
import type { Duplex } from "node:stream";
import { resolveWindowsJobLauncher } from "../main/windows-job-launcher.js";
import { isWindowsPathKindHelperTimeout, resolveWindowsPathKindHelper, windowsPathKindHelperUnavailable } from "../main/windows-path-kind-launcher.js";
import { WINDOWS_COMMAND_LINE_LIMIT, windowsCommandLineLength } from "./windows-command-line.js";
import { decodeWindowsNativeReply, runWindowsNative } from "./windows-native-host.js";
import { TOOL_TIMEOUT_POLICY } from "./tool-timeout-policy.js";

/** Match native ledger output to requests; this spelling key is never object identity. */
export function windowsPathKey(path: string): string {
  const ordinary = path.replace(/\//g, "\\").replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
  return win32.normalize(ordinary).replace(/[\\/]+$/, "").toLowerCase();
}

interface WindowsPathComponentFacts {
  readonly exists: boolean | null;
  readonly canonical: string | null;
  readonly volumeSerial: string | null;
  readonly fileId: string | null;
  /** The 32-bit volume serial exposed as Node's bigint dev. */
  readonly volumeSerialNumber: string | null;
  /** The legacy 64-bit file index exposed as Node's bigint ino. */
  readonly fileIndex: string | null;
  /** Filesystem reported by the retained native handle; absent in older helper output. */
  readonly fileSystemName?: string | null;
  /** FILE_BASIC_INFO.ChangeTime from the pinned handle; changes on content, metadata or ACL change. */
  readonly changeTime: string | null;
  readonly attributes: number;
  readonly reparseTag: number;
  readonly directory: boolean;
  /** Substitute name read from the retained link handle; null for other objects. */
  readonly reparseTarget: string | null;
}

export interface WindowsPathFacts extends WindowsPathComponentFacts {
  readonly ancestors: readonly WindowsPathComponentFacts[];
}

/** Native object identity is independent of path spelling, aliases and directory case mode. */
export function windowsObjectKey(facts: Pick<WindowsPathFacts, "volumeSerial" | "fileId">): string {
  if (facts.volumeSerial === null || facts.fileId === null) throw new Error("Windows object identity is missing");
  return `${facts.volumeSerial}:${facts.fileId}`;
}

interface WindowsAce {
  readonly type: number;
  readonly flags: number;
  readonly mask: number;
  readonly sid: string | null;
  readonly account?: string;
}

export interface WindowsDacl {
  readonly identity: { readonly volumeSerial: string; readonly fileId: string };
  readonly owner: string;
  readonly group?: string;
  readonly protected: boolean;
  readonly nullDacl: boolean;
  readonly aces: readonly WindowsAce[];
}

export interface WindowsDaclFacts extends WindowsPathFacts {
  readonly currentUserSid: string;
  readonly elevated: boolean;
  readonly principals: Readonly<Record<string, string>>;
  readonly dacl: WindowsDacl | null;
  readonly parent?: WindowsDacl | null;
  readonly contentHex?: string | null;
}

const SID_PATTERN = /^S-1-[0-9-]+$/;
const HEX_64_PATTERN = /^0x[0-9a-f]{16}$/;
const HEX_128_PATTERN = /^0x[0-9a-f]{32}$/;
// These bounds match the helper's --dacl --parent --stdin input and output buffers.
const MAX_DACL_FRAME_BYTES = 1024 * 1024;
const MAX_DACL_FRAME_PATHS = 2048;
const MAX_DACL_PATH_UNITS = 32767;
const MAX_PATH_FACTS_OUTPUT_BYTES = 8 * 1024 * 1024;

function isUint(value: unknown, maximum = 0xffffffff): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum;
}

function isComponent(value: unknown): value is WindowsPathComponentFacts {
  if (value === null || typeof value !== "object") return false;
  const row = value as WindowsPathComponentFacts;
  if (row.fileSystemName !== undefined && row.fileSystemName !== null
    && (typeof row.fileSystemName !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(row.fileSystemName))) return false;
  if (row.reparseTarget !== null && (typeof row.reparseTarget !== "string" || !row.reparseTarget || row.reparseTarget.includes("\0"))) return false;
  if (![true, false, null].includes(row.exists) || !isUint(row.attributes) || !isUint(row.reparseTag) || typeof row.directory !== "boolean") return false;
  if (row.exists === true ? typeof row.changeTime !== "string" || !HEX_64_PATTERN.test(row.changeTime) : row.changeTime !== null) {
    throw new Error("Invalid Windows path pin changeTime");
  }
  if (row.exists !== true) return [row.canonical, row.volumeSerial, row.fileId, row.volumeSerialNumber, row.fileIndex].every(field => field === null)
    && row.attributes === 0 && row.reparseTag === 0 && !row.directory;
  return typeof row.canonical === "string" && row.canonical.length > 0
    && typeof row.volumeSerial === "string" && HEX_64_PATTERN.test(row.volumeSerial)
    && typeof row.fileId === "string" && HEX_128_PATTERN.test(row.fileId)
    && typeof row.volumeSerialNumber === "string" && HEX_64_PATTERN.test(row.volumeSerialNumber)
    && BigInt(row.volumeSerialNumber) <= 0xffffffffn
    && typeof row.fileIndex === "string" && HEX_64_PATTERN.test(row.fileIndex);
}

function isDescriptor(value: unknown): value is WindowsDacl {
  if (value === null || typeof value !== "object") return false;
  const row = value as WindowsDacl;
  return typeof row.owner === "string" && SID_PATTERN.test(row.owner) && (row.group === undefined || (typeof row.group === "string" && SID_PATTERN.test(row.group)))
    && typeof row.protected === "boolean" && typeof row.nullDacl === "boolean"
    && row.identity !== null && typeof row.identity === "object"
    && typeof row.identity.volumeSerial === "string" && HEX_64_PATTERN.test(row.identity.volumeSerial)
    && typeof row.identity.fileId === "string" && HEX_128_PATTERN.test(row.identity.fileId)
    && Array.isArray(row.aces) && (!row.nullDacl || row.aces.length === 0)
    && row.aces.every(ace => ace !== null && typeof ace === "object" && isUint(ace.type, 255) && isUint(ace.flags, 255)
      && isUint(ace.mask) && (ace.sid === null || (typeof ace.sid === "string" && SID_PATTERN.test(ace.sid)))
      && (ace.account === undefined || typeof ace.account === "string"));
}

const CONTENT_TOO_LARGE_EXIT_CODE = 5;
const PATH_READ_FAILURE_EXIT_CODE = 4;

/** A refusal the requested paths caused: an open/read failure, an oversized reply, or an overlong command line. */
export function isWindowsPathFactsPathFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return (status === PATH_READ_FAILURE_EXIT_CODE && !("syscall" in error)) || code === "ENOBUFS" || code === "E2BIG";
}

function encodeParentDaclFrame(paths: readonly string[]): Buffer {
  if (paths.length > MAX_DACL_FRAME_PATHS) throw new Error("Windows DACL request exceeds the size limit");
  const entries: { path: string; length: number }[] = [];
  let size = 4; // Operand count, followed by length-prefixed UTF-8 operands.
  for (const path of paths) {
    const remaining = MAX_DACL_FRAME_BYTES - size - 4;
    if (path.length > remaining || path.length > MAX_DACL_PATH_UNITS) throw new Error("Windows DACL request exceeds the size limit");
    if (!isAbsolute(path)) throw new Error("Windows path facts require absolute paths");
    if (path.includes("\0") || toUSVString(path) !== path) throw new Error("Windows DACL request has an invalid path");
    const length = Buffer.byteLength(path);
    if (length > remaining) throw new Error("Windows DACL request exceeds the size limit");
    entries.push({ path, length });
    size += length + 4;
  }
  const input = Buffer.alloc(size + 4);
  input.writeUInt32LE(size, 0);
  input.writeUInt32LE(paths.length, 4);
  let offset = 8;
  for (const { path, length } of entries) {
    input.writeUInt32LE(length, offset);
    input.write(path, offset + 4, length, "utf8");
    offset += length + 4;
  }
  return input;
}

// A non-zero exit's message and stderr name the helper's install path and the requested paths.
function helperExitFailure(error: unknown): (Error & { status: number | null }) | undefined {
  if (typeof error !== "object" || error === null || !("status" in error) || "syscall" in error) return undefined;
  const status = typeof error.status === "number" && Number.isSafeInteger(error.status) ? error.status : null;
  return Object.assign(new Error(status === null ? "Windows path facts helper failed" : `Windows path facts helper failed (exit ${status})`), { status });
}

// An output overrun (ENOBUFS) is a reply, not a failed start.
function helperLaunchFailureCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("syscall" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^E[A-Z0-9]{1,31}$/u.test(code) && code !== "ENOBUFS" ? code : undefined;
}

function request(paths: readonly string[], mode: "--pin" | "--dacl", flags: readonly string[] = []): WindowsPathFacts[] {
  if (paths.length === 0) return [];
  const framed = mode === "--dacl" && flags.includes("--parent") && !flags.includes("--content");
  if (!framed && paths.some(path => !isAbsolute(path))) throw new Error("Windows path facts require absolute paths");
  const input = framed ? encodeParentDaclFrame(paths) : undefined;
  let output: Buffer;
  try {
    output = runWindowsNative(() => {
      const helper = resolveWindowsPathKindHelper();
      const args = [mode, ...flags, ...(framed ? ["--stdin"] : paths)];
      if (windowsCommandLineLength(helper, args) > WINDOWS_COMMAND_LINE_LIMIT) {
        throw Object.assign(new Error("Windows path facts command line exceeds the process limit"), { code: "E2BIG" });
      }
      return execFileSync(helper, args, {
        windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.windowsAclRequestMs,
        maxBuffer: MAX_PATH_FACTS_OUTPUT_BYTES, input,
      });
    });
  } catch (error) {
    // Spawn and timeout errors name the helper's install path; only their code is kept.
    if (isWindowsPathKindHelperTimeout(error)) {
      throw windowsPathKindHelperUnavailable(`Windows path facts helper did not answer within ${TOOL_TIMEOUT_POLICY.windowsAclRequestMs} ms`, "ETIMEDOUT");
    }
    const launchCode = helperLaunchFailureCode(error);
    if (launchCode !== undefined) throw windowsPathKindHelperUnavailable(`Windows path facts helper could not start (${launchCode})`, launchCode);
    const failure = helperExitFailure(error);
    if (flags.includes("--content") && failure?.status === CONTENT_TOO_LARGE_EXIT_CODE) {
      const oversized: NodeJS.ErrnoException = new Error("Windows file content exceeds the native read limit", { cause: failure });
      oversized.code = "EFBIG";
      throw oversized;
    }
    throw failure ?? error;
  }
  return decodeWindowsPathFacts(decodeWindowsNativeReply(output), paths.length, mode, flags, framed ? paths : undefined);
}

export function decodeWindowsPathFacts(output: string, expectedRows: number, mode: "--pin" | "--dacl", flags: readonly string[] = [], expectedPaths?: readonly string[]): WindowsPathFacts[] {
  const response: unknown = JSON.parse(output);
  if (!Array.isArray(response) || response.length !== expectedRows) throw new Error("Invalid Windows path facts response");
  // The wire descriptor is flat; the typed view distinguishes an absent DACL
  // snapshot from a present descriptor whose ACL is unrestricted.
  const rows = response.map((row: unknown, index) => {
    if (mode !== "--dacl" || row === null || typeof row !== "object") return row;
    const { requestPath, identity, owner, group, protected: protectedDacl, nullDacl, aces, ...facts } = row as Record<string, unknown>;
    if (expectedPaths !== undefined && requestPath !== expectedPaths[index]) throw new Error("Windows DACL request path mismatch");
    return { ...facts, dacl: identity === null ? null : { identity, owner, ...(group === undefined ? {} : { group }), protected: protectedDacl, nullDacl, aces } };
  });
  for (const row of rows as WindowsDaclFacts[]) {
    if (!isComponent(row) || !Array.isArray(row.ancestors) || !row.ancestors.every(isComponent)) throw new Error("Invalid Windows path pin");
    if (mode !== "--dacl") continue;
    if (typeof row.currentUserSid !== "string" || !SID_PATTERN.test(row.currentUserSid) || typeof row.elevated !== "boolean"
      || row.principals === null || typeof row.principals !== "object" || Array.isArray(row.principals)
      || Object.entries(row.principals).some(([sid, name]) => !SID_PATTERN.test(sid) || !["srt-sandbox", "sandbox-runtime-users"].includes(name))) {
      throw new Error("Invalid Windows DACL identity");
    }
    if (row.exists === true ? !isDescriptor(row.dacl) : row.dacl !== null) throw new Error("Invalid Windows DACL descriptor");
    if (row.dacl !== null && (row.dacl.identity.volumeSerial !== row.volumeSerial || row.dacl.identity.fileId !== row.fileId)) throw new Error("Windows DACL identity mismatch");
    if (flags.includes("--parent")) {
      const parent = row.ancestors.at(-1);
      if (parent?.exists === true ? !isDescriptor(row.parent) : row.parent !== null) throw new Error("Invalid Windows parent DACL");
      if (row.parent && (row.parent.identity.volumeSerial !== parent?.volumeSerial || row.parent.identity.fileId !== parent.fileId)) throw new Error("Windows parent DACL identity mismatch");
    }
    if (flags.includes("--content") && row.contentHex !== null
      && (typeof row.contentHex !== "string" || row.contentHex.length > 2097152 || !/^(?:[0-9a-f]{2})*$/.test(row.contentHex))) throw new Error("Invalid Windows file content");
  }
  return rows as WindowsPathFacts[];
}

export function pinWindowsPaths(paths: readonly string[]): readonly WindowsPathFacts[] {
  return request(paths, "--pin");
}

/** The job launcher's own record of a held run. "ok": its job was proven empty and the helper confirmed the held directory
 * (`stopped`: processes were still running when the command exited). "lost": the hold refused the launch or the directory
 * changed. "unconfirmed": everything else, including a launcher that ended without a record. */
export type WindowsHoldVerdict = { readonly kind: "ok"; readonly stopped: boolean } | { readonly kind: "lost" | "unconfirmed" };

export interface HeldWindowsRun {
  /** Settles once, with the launcher's record after it has exited and its output has drained, or "unconfirmed"
   * `windowsHoldStopMs` after `stop`. The hold is released at settlement, which stops anything still in its job. */
  readonly verdict: Promise<WindowsHoldVerdict>;
  /** Ask the launcher to end the run and start the deadline. Idempotent; returns `verdict`. */
  stop(): Promise<WindowsHoldVerdict>;
}

export interface HeldWindowsDirectory {
  readonly facts: WindowsPathFacts;
  /** Job launcher arguments for a held command. */
  readonly launcherArgs: readonly string[];
  /** The job launcher invocation that starts `executable` with `launcherArgs`. */
  command(executable: string, args: readonly string[]): { executable: string; args: string[] };
  /** The standard handles a held launcher is started with: owner, output, error, hold channel, verdict. */
  readonly stdio: "pipe"[];
  /** Connect the started launcher to the helper and return its run. One launcher per hold. */
  bind(launcher: ChildProcess): HeldWindowsRun;
  /** False once the helper that owns the handles has exited or failed, or after `release`. */
  isHeld(): boolean;
  /** Idempotent. */
  release(): void;
}

const HOLD_VERDICT_LIMIT = 64;
const HOLD_DRAIN_MS = 2_000;
const HOLD_REQUEST_BYTES = 8;

/** Hold a directory and every ancestor against rename and delete until `release`; undefined when the helper did not hold it.
 * The handles and the kill-on-close job live in the helper, so its exit stops the launcher and everything it started. */
export function holdWindowsDirectory(path: string): Promise<HeldWindowsDirectory | undefined> {
  if (!isAbsolute(path)) return Promise.resolve(undefined);
  let child: ChildProcess;
  try {
    child = runWindowsNative(() => spawn(resolveWindowsPathKindHelper(), ["--hold", path], { windowsHide: true, stdio: ["pipe", "pipe", "ignore", "pipe"] }));
  } catch {
    return Promise.resolve(undefined);
  }
  const channel = child.stdio[3] as Duplex;
  let settled = false;
  let released = false;
  let lost = false;
  let run: HeldWindowsRun | undefined;
  let onLost: (() => void) | undefined;
  const release = (): void => {
    if (released) return;
    released = true;
    child.stdin?.destroy();
    channel.destroy();
    child.kill();
    onLost?.();
  };
  const bind = (launcher: ChildProcess): HeldWindowsRun => {
    if (run !== undefined) throw new Error("The working directory hold already has a launcher");
    let finish!: (verdict: WindowsHoldVerdict) => void;
    let done = false;
    let deadline: NodeJS.Timeout | undefined;
    let record = "";
    const verdict = new Promise<WindowsHoldVerdict>((resolve) => {
      finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        for (const stream of launcher.stdio) stream?.destroy();
        release();
        resolve(result);
      };
    });
    const stop = (): Promise<WindowsHoldVerdict> => {
      if (!done && deadline === undefined) {
        deadline = setTimeout(() => finish({ kind: "unconfirmed" }), TOOL_TIMEOUT_POLICY.windowsHoldStopMs);
        launcher.stdin?.destroy();
      }
      return verdict;
    };
    run = { verdict, stop };
    onLost = stop;
    const [, , , relay, report] = launcher.stdio as readonly (Duplex | null | undefined)[];
    for (const stream of [launcher.stdin, relay, report, channel]) stream?.on("error", () => {});
    launcher.on("error", () => {
      // A start without a process has nothing to wait for; a failed operation on a live one is a stop request.
      if (launcher.pid === undefined) finish({ kind: "unconfirmed" });
      else void stop();
    });
    const launcherPid = launcher.pid;
    if (launcherPid === undefined || relay == null || report == null) {
      void stop();
      return run;
    }
    const stopAdmission = (): void => { relay.destroy(); void stop(); };
    const admitRelay = (): void => {
      const frame = relay.read(HOLD_REQUEST_BYTES) as Buffer | null;
      if (frame === null) return;
      relay.off("readable", admitRelay);
      relay.off("end", stopAdmission);
      if (frame.length !== HOLD_REQUEST_BYTES || frame.readUInt32LE(4) !== launcherPid) {
        stopAdmission();
        return;
      }
      channel.write(frame);
      relay.pipe(channel);
      channel.pipe(relay);
    };
    relay.on("readable", admitRelay);
    relay.once("end", stopAdmission);
    // A closed helper channel ends the launcher's read at once instead of at its admission deadline.
    channel.once("close", () => relay.destroy());
    report.on("data", (chunk: Buffer) => { if (record.length <= HOLD_VERDICT_LIMIT) record += chunk.toString("latin1"); });
    launcher.once("exit", (code) => {
      const read = (): void => {
        clearTimeout(drain);
        const ok = /^AVJ1 ok (\d{1,10}) ([01])\n$/.exec(record);
        finish(ok !== null && code !== null && code >>> 0 === Number(ok[1]) ? { kind: "ok", stopped: ok[2] === "1" }
          : record === "AVJ1 lost\n" && code === 125 ? { kind: "lost" } : { kind: "unconfirmed" });
      };
      const drain = setTimeout(read, HOLD_DRAIN_MS);
      launcher.once("close", read);
    });
    if (lost || released) void stop();
    return run;
  };
  const held = (facts: WindowsPathFacts): HeldWindowsDirectory => ({
    facts,
    launcherArgs: ["--hold"],
    command: (executable, args) => ({ executable: resolveWindowsJobLauncher(), args: ["--hold", executable, ...args] }),
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    bind,
    isHeld: () => !released && !lost,
    release,
  });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const settle = (result: HeldWindowsDirectory | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result === undefined) {
        child.stdout?.destroy();
        release();
      }
      resolve(result);
    };
    const failed = (): void => {
      if (!settled) { settle(undefined); return; }
      lost = true;
      onLost?.();
    };
    const timer = setTimeout(() => settle(undefined), TOOL_TIMEOUT_POLICY.windowsPathKindQueryMs);
    child.on("error", failed);
    child.once("exit", failed);
    child.stdin?.on("error", failed);
    channel.on("error", () => {});
    child.stdout?.on("error", () => settle(undefined));
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      const newline = chunk.indexOf(0x0a);
      const frameBytes = newline < 0 ? chunk.length : newline + 1;
      if (received + frameBytes > MAX_PATH_FACTS_OUTPUT_BYTES) {
        settle(undefined);
        return;
      }
      received += frameBytes;
      chunks.push(newline < 0 ? chunk : chunk.subarray(0, frameBytes));
      if (newline < 0) return;
      try {
        const [facts] = decodeWindowsPathFacts(decodeWindowsNativeReply(Buffer.concat(chunks, received)), 1, "--pin");
        settle(facts === undefined || child.pid === undefined ? undefined : held(facts));
      } catch {
        settle(undefined);
      }
    });
  });
}

/** Content is read on the descriptor's pinned handle, bounded to one MiB. */
export function readWindowsDacls(paths: readonly string[], options: { parent?: boolean; content?: boolean } = {}): readonly WindowsDaclFacts[] {
  // The native walk holds non-write/non-delete-shared component handles through DACL capture; separate pins add no snapshot binding.
  return request(paths, "--dacl", [...(options.parent ? ["--parent"] : []), ...(options.content ? ["--content"] : [])]) as WindowsDaclFacts[];
}

/** This is the sole admission rule for Windows path pins, including unfamiliar tags. */
export function admitWindowsReparse(facts: WindowsPathFacts, use: "grant" | "evidence" = "evidence"): boolean | "resolve" {
  let follow = false;
  for (const component of [...facts.ancestors, facts]) {
    if (component.exists === null) {
      // The non-following walk stops below a link; only resolution can prove the remaining components.
      if (use === "grant" && follow) continue;
      return false;
    }
    const tag = component.reparseTag;
    if (tag === 0 && (component.attributes & 0x400) === 0) continue;
    if (use === "evidence" || tag === 0) return false;
    if ((tag & 0x20000000) === 0) continue;
    if (tag !== 0xa0000003 && tag !== 0xa000000c) return false;
    follow = true;
  }
  return follow ? "resolve" : true;
}

export function mapWindowsGenericRights(mask: number): number {
  let mapped = mask & 0x0fffffff;
  if ((mask & 0x80000000) !== 0) mapped |= 0x120089;
  if ((mask & 0x40000000) !== 0) mapped |= 0x120116;
  if ((mask & 0x20000000) !== 0) mapped |= 0x1200a0;
  if ((mask & 0x10000000) !== 0) mapped |= 0x1f01ff;
  return mapped >>> 0;
}

export type WindowsReadDenyPrincipal = "Everyone" | "Users" | "Authenticated Users" | "INTERACTIVE" | "srt-sandbox" | "sandbox-runtime-users";

export function evaluateWindowsReadDacl(facts: WindowsDaclFacts): {
  status: "private" | "readable";
  principals?: WindowsReadDenyPrincipal[];
  reason?: string;
} {
  if (!facts.dacl) throw new Error("DACL descriptor is missing");
  if (facts.dacl.nullDacl) return { status: "readable", principals: ["Everyone"], reason: "Unrestricted DACL" };
  const principals: Readonly<Record<string, string>> = {
    "S-1-1-0": "Everyone", "S-1-5-32-545": "Users", "S-1-5-11": "Authenticated Users", "S-1-5-4": "INTERACTIVE", ...facts.principals,
  };
  const matched = new Set<WindowsReadDenyPrincipal>();
  for (const ace of facts.dacl.aces) {
    if ((ace.flags & 8) !== 0) continue;
    if (![0, 1].includes(ace.type) || ace.sid === null) throw new Error("Unsupported DACL entry");
    if (ace.type === 1) continue;
    const principal = principals[ace.sid];
    if ((mapWindowsGenericRights(ace.mask) & 1) !== 0 && principal !== undefined) matched.add(principal as WindowsReadDenyPrincipal);
  }
  return matched.size === 0 ? { status: "private" } : { status: "readable", principals: [...matched] };
}

export function leadingWindowsDenies(dacl: WindowsDacl | null, sid: string): { mask: number; inheritable: number } {
  if (!/^S-1-[0-9]+(?:-[0-9]+){0,15}$/.test(sid)) throw new Error("Invalid deny DACL SID");
  const parts = sid.slice(4).split("-").map(value => BigInt(value));
  if (parts[0]! > 0xffffffffffffn || parts.slice(1).some(value => value > 0xffffffffn)) throw new Error("Invalid deny DACL SID");
  const trustee = `S-1-${parts.join("-")}`;
  let mask = 0, inheritable = 0;
  for (const ace of dacl?.aces ?? []) {
    if (ace.type !== 1 || (ace.flags & 0x10) !== 0) break;
    if (ace.sid !== trustee || (ace.flags & 8) !== 0) continue;
    mask |= ace.mask;
    if ((ace.flags & 3) === 3 && (ace.flags & 4) === 0) inheritable |= ace.mask;
  }
  return { mask: mask >>> 0, inheritable: inheritable >>> 0 };
}

export interface WindowsOwnerAccessRule {
  sid: string;
  account?: string;
  accessControlType: number;
  fileSystemRights: number;
  inheritanceFlags: number;
  propagationFlags: number;
  isInherited: boolean;
}

export function windowsOwnerRules(dacl: WindowsDacl): WindowsOwnerAccessRule[] {
  if (dacl.nullDacl) throw new Error("Unrestricted directory DACL");
  return dacl.aces.map(ace => {
    if (![0, 1].includes(ace.type) || ace.sid === null) throw new Error("Unsupported directory DACL entry");
    return { sid: ace.sid, ...(ace.account ? { account: ace.account } : {}), accessControlType: ace.type, fileSystemRights: ace.mask | 0,
      inheritanceFlags: ((ace.flags & 2) !== 0 ? 1 : 0) | ((ace.flags & 1) !== 0 ? 2 : 0),
      propagationFlags: ((ace.flags & 4) !== 0 ? 1 : 0) | ((ace.flags & 8) !== 0 ? 2 : 0), isInherited: (ace.flags & 0x10) !== 0 };
  });
}

/** A deny entry never grants access, so it cannot let another principal in: the ownership shapes evaluate allow entries alone. It is
 * how srt-win confines its sandbox account inside the home (a FILE_DELETE_CHILD deny on the root, a write deny on config/). */
export function windowsGrantingRules<T extends { accessControlType: number }>(rules: readonly T[]): T[] {
  return rules.filter(rule => rule.accessControlType !== 1);
}

export function isOwnerOnlyDacl(descriptor: { ownerSid?: string; elevated?: boolean; rules?: WindowsOwnerAccessRule[] }, sid: string): boolean {
  const ownerValid = descriptor.ownerSid === sid || (descriptor.elevated === true && descriptor.ownerSid === "S-1-5-32-544");
  const rules = descriptor.rules === undefined ? undefined : windowsGrantingRules(descriptor.rules);
  const rule = rules?.[0];
  return ownerValid && rules?.length === 1 && rule?.sid === sid && rule.accessControlType === 0 && rule.fileSystemRights === 2032127
    && rule.inheritanceFlags === 3 && rule.propagationFlags === 0 && rule.isInherited === false;
}

export interface WindowsPolicyDescriptor {
  ownerSid: string;
  nullDacl: boolean;
  rules: { sid: string; mask: number; allow: boolean; inheritOnly: boolean }[];
}

const ADMINISTRATORS_SID = "S-1-5-32-544";
const SYSTEM_SID = "S-1-5-18";
const TRUSTED_WRITERS = new Set([ADMINISTRATORS_SID, SYSTEM_SID, "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"]);

export function windowsPolicyDescriptor(dacl: WindowsDacl): WindowsPolicyDescriptor {
  return { ownerSid: dacl.owner, nullDacl: dacl.nullDacl, rules: dacl.aces.map(ace => {
    if (![0, 1, 5, 6].includes(ace.type) || ace.sid === null) throw new Error("Unsupported policy DACL entry");
    return { sid: ace.sid, mask: ace.mask, allow: ace.type === 0 || ace.type === 5, inheritOnly: (ace.flags & 8) !== 0 };
  }) };
}

export function windowsPolicyTrustFailure(file: WindowsPolicyDescriptor, parent: WindowsPolicyDescriptor): string | null {
  if (file.ownerSid !== ADMINISTRATORS_SID && file.ownerSid !== SYSTEM_SID) return `owner ${file.ownerSid}`;
  if (!TRUSTED_WRITERS.has(parent.ownerSid)) return `parent owner ${parent.ownerSid}`;
  for (const [descriptor, label, mask] of [[file, "file", 0x500d0116], [parent, "parent", 0x500d0040]] as const) {
    if (descriptor.nullDacl) return `${label} has an unrestricted DACL`;
    for (const rule of descriptor.rules) {
      if (rule.allow && !rule.inheritOnly && (rule.mask & mask) !== 0 && !TRUSTED_WRITERS.has(rule.sid)) return `${label} writable by ${rule.sid}`;
    }
  }
  return null;
}
