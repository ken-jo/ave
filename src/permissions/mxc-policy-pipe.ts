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

export async function openMxcPolicyPipe(bytes: Buffer, pipe: string, admission?: {
  root: string; signal: AbortSignal; assertStillValid: () => void;
}): Promise<{
  bindChild(child: childProcess.ChildProcess): void;
  release(): Promise<void>;
}> {
  if (!bytes.length || bytes.length > MAX_POLICY_BYTES) throw new Error("Windows sandbox policy frame length is invalid");
  if (!/^\\\\\.\\pipe\\ave-mxc-[a-f0-9]{32}$/u.test(pipe)) throw new Error("Windows sandbox policy pipe name is invalid");
  assertManagedChildProcessAdmissionOpen("mxc:policy");
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
      ["--mxc-policy", pipe, String(TOOL_TIMEOUT_POLICY.mxcRequestTransportMs), ...(gate ? [gate.path, "--authorize"] : [])], {
        cwd: dirname(helper), windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
      })));
  } catch (error) { gate?.revoke(); throw error; }
  let stopTracking: ReturnType<typeof trackManagedChildProcess> | undefined;
  let bound: childProcess.ChildProcess | undefined;
  let closed = false;
  let exited = false;
  let released = false;
  let ready = false;
  let authorizations = 0;
  let awaitingDelivery = false;
  let failing = false;
  let failure: Error | undefined;
  let rejectReady: (error: Error) => void = () => {};
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
    if (bound?.exitCode === null && bound.signalCode === null) cleanup(() => bound?.kill());
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
    else if (!released && (!ready || code !== 0)) fail(new Error("Windows sandbox policy helper failed; rebuild the Windows native assets"));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      rejectReady = reject;
      let response = Buffer.alloc(0);
      server.stdout.on("data", (chunk: Buffer) => {
        if (released) return;
        if (response.length + chunk.length > 64) {
          void fail(new Error("Windows sandbox policy helper sent an invalid response"));
          return;
        }
        response = Buffer.concat([response, chunk]);
        for (let end = response.indexOf(0x0a); end >= 0; end = response.indexOf(0x0a)) {
          let line: string;
          try { line = decodeWindowsNativeReply(response.subarray(0, end + 1)); }
          catch (cause) {
            fail(new Error("Windows sandbox policy helper sent invalid UTF-8", { cause }));
            return;
          }
          response = response.subarray(end + 1);
          if (!ready && line === "ready\n") {
            ready = true;
            resolve();
          } else if (ready && gate && bound && line === "authorize\n" && !awaitingDelivery && authorizations < 2) {
            authorizations += 1;
            awaitingDelivery = true;
            try { commitUnderAdmission(assertLive, () => { server.stdin.write(Buffer.from([1])); }); }
            catch (error) { fail(error); return; }
          } else {
            const offer = /^deliver ([1-9a-f][0-9a-f]{0,15}) ([1-9][0-9]{0,19})\n$/u.exec(line);
            if (!awaitingDelivery || !gate || !offer || server.pid === undefined || bound?.pid === undefined) {
              fail(new Error("Windows sandbox policy helper sent an invalid response"));
              return;
            }
            try {
              writePolicyUnderAdmission(frame.subarray(header.length), gate.path, server.pid, bound.pid,
                BigInt(`0x${offer[1]}`), BigInt(offer[2]), assertLive);
              awaitingDelivery = false;
              server.stdin.write(Buffer.from([2]));
            } catch (error) { fail(error); return; }
          }
        }
      });
      server.stdout.once("end", () => {
        if (!released && (!ready || response.length > 0)) fail(new Error("Windows sandbox policy helper sent an incomplete response"));
      });
      try {
        stopTracking = trackManagedChildProcess(server, { killProcessGroup: false, label: "mxc:policy" });
        if (typeof stopTracking !== "function") throw new Error("Windows sandbox policy tracking disposer is invalid");
        server.stderr.resume();
        server.stdin.write(gate ? frame.subarray(0, header.length) : frame);
      } catch (error) {
        recordFailure(error);
        cleanup(() => retainUnterminatedChildProcess(server, "mxc:policy"));
        fail(error);
      }
    });
    if (failure) throw failure;
    return {
      bindChild: (child) => {
        if (bound !== undefined) throw new Error("Windows sandbox policy client is already bound");
        bound = child;
        child.once("error", () => { void release().catch(fail); });
        child.once("close", () => { void release().catch(fail); });
        if (child.pid === undefined || !Number.isInteger(child.pid) || child.pid <= 0 || child.pid > 0xffff_ffff || closed || released) {
          void fail(new Error("Windows sandbox policy client did not start"));
          return;
        }
        const pid = Buffer.alloc(4);
        pid.writeUInt32LE(child.pid);
        try { commitUnderAdmission(assertLive, () => { server.stdin.write(pid); }); }
        catch (error) { fail(error); }
      },
      release,
    };
  } catch (error) {
    recordFailure(error);
    await release();
    throw error;
  }
}
