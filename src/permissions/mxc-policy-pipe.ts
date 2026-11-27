import childProcess from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { withWindowsPathKindHelper } from "../main/windows-path-kind-launcher.js";
import { assertManagedChildProcessAdmissionOpen, retainUnterminatedChildProcess, trackManagedChildProcess } from "../main/managed-child-processes.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { decodeWindowsNativeReply } from "../shared/windows-native-host.js";
import { commitUnderAdmission } from "../shared/admission-commit.js";
import { createMxcReleaseGate } from "./mxc-release-gate.js";

const MAX_POLICY_BYTES = 4 * 1024 * 1024;
const SYNCHRONIZE = 0x00100000;
const PROCESS_DUP_HANDLE = 0x40;
const DUPLICATE_SAME_ACCESS = 2;
const WAIT_TIMEOUT = 258;
const INVALID_FILE_ATTRIBUTES = 0xffff_ffff;
const FILE_ATTRIBUTE_DIRECTORY_OR_REPARSE_POINT = 0x410;
const PIPE_DISCONNECTED_ERRORS = new Set([109, 232]);

function loadPolicyWriter() {
  const requireNative = typeof require === "function" ? require : createRequire(import.meta.url);
  const ffi = requireNative("koffi") as typeof import("koffi");
  const kernel = ffi.load("kernel32.dll");
  return {
    openProcess: kernel.func("intptr_t __stdcall OpenProcess(uint32_t, int, uint32_t)"),
    currentProcess: kernel.func("intptr_t __stdcall GetCurrentProcess()"),
    duplicate: kernel.func("int __stdcall DuplicateHandle(intptr_t, intptr_t, intptr_t, void *, uint32_t, int, uint32_t)"),
    close: kernel.func("int __stdcall CloseHandle(intptr_t)"),
    wait: kernel.func("uint32_t __stdcall WaitForSingleObject(intptr_t, uint32_t)"),
    clientPid: kernel.func("int __stdcall GetNamedPipeClientProcessId(intptr_t, void *)"),
    attributes: kernel.func("uint32_t __stdcall GetFileAttributesW(str16)"),
    tick: kernel.func("uint64_t __stdcall GetTickCount64()"),
    write: kernel.func("int __stdcall WriteFile(intptr_t, void *, uint32_t, void *, void *)"),
    lastError: kernel.func("uint32_t __stdcall GetLastError()"),
  };
}

let policyWriter: ReturnType<typeof loadPolicyWriter> | undefined;

function writePolicyUnderAdmission(bytes: Buffer, gate: string, helperPid: number, clientPid: number,
  source: bigint, deadline: bigint, assertLive: () => void): void {
  const refusal = new Error("Windows sandbox policy write was refused");
  if (process.platform !== "win32") throw refusal;
  policyWriter ??= loadPolicyWriter();
  const api = policyWriter;
  const helper = api.openProcess(PROCESS_DUP_HANDLE | SYNCHRONIZE, 0, helperPid);
  if (!helper) throw refusal;
  try {
    const client = api.openProcess(SYNCHRONIZE, 0, clientPid);
    if (!client) throw refusal;
    try {
      const duplicated = Buffer.alloc(8);
      if (!api.duplicate(helper, source, api.currentProcess(), duplicated, 0, 0, DUPLICATE_SAME_ACCESS)) throw refusal;
      const pipe = duplicated.readBigInt64LE();
      try {
        const count = Buffer.alloc(4);
        commitUnderAdmission(assertLive, () => {
          const attributes = api.attributes(gate);
          if (attributes === INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_DIRECTORY_OR_REPARSE_POINT) !== 0
            || api.wait(helper, 0) !== WAIT_TIMEOUT || api.wait(client, 0) !== WAIT_TIMEOUT || BigInt(api.tick()) >= deadline) throw refusal;
          if (!api.clientPid(pipe, count)) {
            if (PIPE_DISCONNECTED_ERRORS.has(api.lastError())) return;
            throw refusal;
          }
          if (count.readUInt32LE() !== clientPid || BigInt(api.tick()) >= deadline) throw refusal;
          // The helper hands off a nonblocking pipe and waits for the write result.
          if (!api.write(pipe, bytes, bytes.length, count, null)) {
            if (PIPE_DISCONNECTED_ERRORS.has(api.lastError())) return;
            throw refusal;
          }
          if (count.readUInt32LE() !== bytes.length) throw refusal;
        });
      } finally { api.close(pipe); }
    } finally { api.close(client); }
  } finally { api.close(helper); }
}

class PolicyHelperTerminationError extends Error {
  readonly outcome = "left";
  constructor(cause: Error | undefined) {
    super("Windows sandbox policy helper was left; termination was not confirmed", { cause });
  }
}

interface MxcPolicyAdmission {
  root: string;
  signal: AbortSignal;
  assertStillValid: () => void;
  held?: boolean;
}

export async function openMxcPolicyPipe(bytes: Buffer, pipe: string, options?: boolean | MxcPolicyAdmission): Promise<{
  bindChild(child: childProcess.ChildProcess): void;
  bindHeldPolicy?(launcher: childProcess.ChildProcess, readerPid: number, onFailure: () => void): Promise<void>;
  release(): Promise<void>;
}> {
  if (!bytes.length || bytes.length > MAX_POLICY_BYTES) throw new Error("Windows sandbox policy frame length is invalid");
  if (!/^\\\\\.\\pipe\\ave-mxc-[a-f0-9]{32}$/u.test(pipe)) throw new Error("Windows sandbox policy pipe name is invalid");
  assertManagedChildProcessAdmissionOpen("mxc:policy");
  const admission = typeof options === "object" ? options : undefined;
  const held = options === true || admission?.held === true;
  const header = Buffer.alloc(4);
  header.writeUInt32LE(bytes.length);
  const frame = Buffer.concat([header, bytes]);
  const assertLive = () => {
    admission?.signal.throwIfAborted();
    admission?.assertStillValid();
    admission?.signal.throwIfAborted();
  };
  const gate = admission ? commitUnderAdmission(assertLive, () => createMxcReleaseGate(admission.root)) : undefined;
  let server: childProcess.ChildProcessWithoutNullStreams;
  try {
    server = withWindowsPathKindHelper(helper => commitUnderAdmission(assertLive, () => childProcess.spawn(helper,
      [held ? "--mxc-policy-held-v1" : "--mxc-policy", pipe, String(TOOL_TIMEOUT_POLICY.mxcRequestTransportMs), ...(gate ? [gate.path, "--authorize"] : [])], {
        cwd: dirname(helper), windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
      })));
  } catch (error) { gate?.revoke(); throw error; }
  let stopTracking: ReturnType<typeof trackManagedChildProcess> | undefined;
  let bound: childProcess.ChildProcess | undefined;
  let boundReaderPid: number | undefined;
  let closed = false;
  let exited = false;
  let released = false;
  let ready = false;
  let authorizations = 0;
  let awaitingDelivery = false;
  let failing = false;
  let failure: Error | undefined;
  let rejectReady: (error: Error) => void = () => {};
  let pendingBind: { resolve(): void; reject(error: Error): void } | undefined;
  let acknowledged = false;
  let stopHeld: (() => void) | undefined;
  let resolveClosed: () => void;
  const completion = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let releasePromise: Promise<void> | undefined;
  const recordFailure = (error: unknown): Error => failure ??= error instanceof Error ? error : new Error("Windows sandbox policy helper failed", { cause: error });
  const cleanup = (operation: () => unknown): void => {
    try { operation(); } catch (error) { recordFailure(error); }
  };
  const release = (): Promise<void> => {
    if (releasePromise) return releasePromise;
    released = true;
    pendingBind?.reject(failure ?? new Error("Windows sandbox policy binding was released"));
    pendingBind = undefined;
    clearTimeout(timer);
    admission?.signal.removeEventListener("abort", revoke);
    cleanup(() => gate?.revoke());
    releasePromise = Promise.resolve().then(async () => {
      let stopped: Promise<void> | undefined;
      if (!closed) {
        stopped = new Promise<void>((resolve) => {
          const deadline = setTimeout(() => {
            try {
              if (!exited && !closed && server.exitCode == null && server.signalCode == null) {
                cleanup(() => retainUnterminatedChildProcess(server, "mxc:policy"));
                failure = new PolicyHelperTerminationError(failure);
              }
            } finally {
              resolve();
            }
          }, TOOL_TIMEOUT_POLICY.processTreeKillMs);
          deadline.unref();
          void completion.then(() => { clearTimeout(deadline); resolve(); });
        });
      }
      cleanup(() => server.stdin.destroy());
      if (!closed && !exited && server.exitCode == null && server.signalCode == null) cleanup(() => server.kill("SIGKILL"));
      await stopped;
      if (failure) throw failure;
    });
    return releasePromise;
  };
  const fail = (error: unknown): void => {
    recordFailure(error);
    if (failing) return;
    failing = true;
    if (stopHeld !== undefined) cleanup(stopHeld);
    else if (bound?.exitCode === null && bound.signalCode === null) cleanup(() => bound?.kill());
    void release().then(() => { rejectReady(recordFailure(error)); }, (releaseError) => { rejectReady(recordFailure(releaseError)); });
  };
  const revoke = () => {
    try { gate?.revoke(); }
    catch (error) { fail(error); }
  };
  admission?.signal.addEventListener("abort", revoke, { once: true });
  const timer = setTimeout(() => fail(new Error("Windows sandbox policy delivery timed out")), TOOL_TIMEOUT_POLICY.mxcRequestTransportMs);
  timer.unref();
  server.on("error", (error) => { void fail(error); });
  server.stdin.on("error", (error) => { void fail(error); });
  server.once("exit", () => { exited = true; });
  server.once("close", (code) => {
    closed = true;
    clearTimeout(timer);
    try { stopTracking?.(); } catch (error) { recordFailure(error); }
    finally { resolveClosed(); }
    if (failure) fail(failure);
    else if (!released && (!ready || (held && !acknowledged) || code !== 0)) fail(new Error("Windows sandbox policy helper failed; rebuild the Windows native assets"));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      rejectReady = reject;
      let response = Buffer.alloc(0);
      let delivery = Buffer.alloc(0);
      const invalidResponse = () => new Error("Windows sandbox policy helper sent an invalid response");
      const incompleteResponse = () => new Error("Windows sandbox policy helper sent an incomplete response");
      const readDelivery = (chunk: Buffer): void => {
        if (released) return;
        if (delivery.length + chunk.length > 64) { fail(invalidResponse()); return; }
        delivery = Buffer.concat([delivery, chunk]);
        for (let end = delivery.indexOf(0x0a); end >= 0; end = delivery.indexOf(0x0a)) {
          try {
            const line = decodeWindowsNativeReply(delivery.subarray(0, end + 1));
            delivery = delivery.subarray(end + 1);
            if (!gate || boundReaderPid === undefined || (held && !acknowledged)) throw invalidResponse();
            if (line === "authorize\n" && !awaitingDelivery && authorizations < 2) {
              authorizations += 1;
              awaitingDelivery = true;
              commitUnderAdmission(assertLive, () => { server.stdin.write(Buffer.from([1])); });
              continue;
            }
            const offer = /^deliver ([1-9a-f][0-9a-f]{0,15}) ([1-9][0-9]{0,19})\n$/u.exec(line);
            if (!awaitingDelivery || !offer || server.pid === undefined) throw invalidResponse();
            writePolicyUnderAdmission(frame.subarray(header.length), gate.path, server.pid, boundReaderPid,
              BigInt(`0x${offer[1]}`), BigInt(offer[2]), assertLive);
            awaitingDelivery = false;
            server.stdin.write(Buffer.from([2]));
          } catch (error) { fail(error); return; }
        }
      };
      const finishDelivery = () => {
        if (!released && (delivery.length > 0 || awaitingDelivery)) fail(incompleteResponse());
      };
      server.stdout.on("data", (chunk: Buffer) => {
        if (released) return;
        if (ready && gate && !held) { readDelivery(chunk); return; }
        if (acknowledged || response.length + chunk.length > 64) {
          fail(invalidResponse());
          return;
        }
        response = Buffer.concat([response, chunk]);
        if (!response.includes(0x0a)) return;
        try {
          const frame = decodeWindowsNativeReply(response);
          if (!ready && frame === (held ? "held-v1\n" : "ready\n")) {
            ready = true;
            if (held) response = Buffer.alloc(0);
            resolve();
          } else if (held && pendingBind !== undefined && frame === "bound\n") {
            acknowledged = true;
            response = Buffer.alloc(0);
          } else fail(invalidResponse());
        } catch (cause) {
          void fail(new Error("Windows sandbox policy helper sent invalid UTF-8", { cause }));
        }
      });
      if (held) server.stdout.on("error", fail);
      server.stdout.once("end", () => {
        if (!ready || (held && !released && !acknowledged)) {
          fail(incompleteResponse());
        } else if (!released && acknowledged) {
          try {
            assertLive();
            pendingBind?.resolve();
            pendingBind = undefined;
          } catch (error) { fail(error); }
        }
        if (!held) finishDelivery();
      });
      try {
        stopTracking = trackManagedChildProcess(server, { killProcessGroup: false, label: "mxc:policy" });
        if (typeof stopTracking !== "function") throw new Error("Windows sandbox policy tracking disposer is invalid");
        if (held && gate) {
          server.stderr.on("data", readDelivery);
          server.stderr.on("error", fail);
          server.stderr.once("end", finishDelivery);
        } else server.stderr.resume();
        server.stdin.write(gate ? header : frame);
      } catch (error) {
        recordFailure(error);
        cleanup(() => retainUnterminatedChildProcess(server, "mxc:policy"));
        fail(error);
      }
    });
    if (failure) throw failure;
    const bind = (owner: childProcess.ChildProcess, readerPid: number | undefined): void => {
      if (bound !== undefined) throw new Error("Windows sandbox policy client is already bound");
      bound = owner;
      owner.once("error", () => { void release().catch(fail); });
      owner.once("close", () => { void release().catch(fail); });
      if (readerPid === undefined || !Number.isInteger(readerPid) || readerPid <= 0 || readerPid > 0xffff_ffff || closed || released) {
        fail(new Error("Windows sandbox policy client did not start"));
        return;
      }
      const pid = Buffer.alloc(4);
      pid.writeUInt32LE(readerPid);
      boundReaderPid = readerPid;
      try { commitUnderAdmission(assertLive, () => { server.stdin.write(pid); }); }
      catch (error) { fail(error); }
    };
    return {
      bindChild(child) {
        if (held) throw new Error("Windows sandbox policy requires a held reader");
        bind(child, child.pid);
      },
      ...(held && {
        bindHeldPolicy(launcher: childProcess.ChildProcess, readerPid: number, onFailure: () => void) {
          if (bound !== undefined) throw new Error("Windows sandbox policy client is already bound");
          if (released || closed) throw failure ?? new Error("Windows sandbox policy helper is unavailable");
          stopHeld = onFailure;
          return new Promise<void>((resolve, reject) => {
            pendingBind = { resolve, reject };
            try { bind(launcher, readerPid); } catch (error) { fail(error); }
          });
        },
      }),
      release,
    };
  } catch (error) {
    recordFailure(error);
    await release();
    throw error;
  }
}
