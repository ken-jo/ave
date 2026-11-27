import childProcess from "node:child_process";
import { dirname } from "node:path";
import { withWindowsPathKindHelper } from "../main/windows-path-kind-launcher.js";
import { assertManagedChildProcessAdmissionOpen, retainUnterminatedChildProcess, trackManagedChildProcess } from "../main/managed-child-processes.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { decodeWindowsNativeReply } from "../shared/windows-native-host.js";

const MAX_POLICY_BYTES = 4 * 1024 * 1024;

class PolicyHelperTerminationError extends Error {
  readonly outcome = "left";
  constructor(cause: Error | undefined) {
    super("Windows sandbox policy helper was left; termination was not confirmed", { cause });
  }
}

export async function openMxcPolicyPipe(bytes: Buffer, pipe: string, held = false): Promise<{
  bindChild(child: childProcess.ChildProcess): void;
  bindHeldPolicy?(launcher: childProcess.ChildProcess, readerPid: number, onFailure: () => void): Promise<void>;
  release(): Promise<void>;
}> {
  if (!bytes.length || bytes.length > MAX_POLICY_BYTES) throw new Error("Windows sandbox policy frame length is invalid");
  if (!/^\\\\\.\\pipe\\ave-mxc-[a-f0-9]{32}$/u.test(pipe)) throw new Error("Windows sandbox policy pipe name is invalid");
  assertManagedChildProcessAdmissionOpen("mxc:policy");
  const server = withWindowsPathKindHelper(helper => childProcess.spawn(helper, [held ? "--mxc-policy-held-v1" : "--mxc-policy", pipe, String(TOOL_TIMEOUT_POLICY.mxcRequestTransportMs)], {
    cwd: dirname(helper), windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
  }));
  let stopTracking: ReturnType<typeof trackManagedChildProcess> | undefined;
  let bound: childProcess.ChildProcess | undefined;
  let closed = false;
  let exited = false;
  let released = false;
  let ready = false;
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
      server.stdout.on("data", (chunk: Buffer) => {
        if (released) return;
        if (response.length + chunk.length > 64) {
          void fail(new Error("Windows sandbox policy helper sent an invalid response"));
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
            pendingBind.resolve();
            pendingBind = undefined;
          } else void fail(new Error("Windows sandbox policy helper sent an invalid response"));
        } catch (cause) {
          void fail(new Error("Windows sandbox policy helper sent invalid UTF-8", { cause }));
        }
      });
      server.stdout.once("end", () => {
        if (!ready || (held && !released && !acknowledged)) void fail(new Error("Windows sandbox policy helper sent an incomplete response"));
      });
      try {
        stopTracking = trackManagedChildProcess(server, { killProcessGroup: false, label: "mxc:policy" });
        if (typeof stopTracking !== "function") throw new Error("Windows sandbox policy tracking disposer is invalid");
        server.stderr.resume();
        const header = Buffer.alloc(4);
        header.writeUInt32LE(bytes.length);
        server.stdin.write(Buffer.concat([header, bytes]));
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
      server.stdin.write(pid);
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
