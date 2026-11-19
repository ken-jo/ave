import childProcess from "node:child_process";
import { dirname } from "node:path";
import { resolveWindowsPathKindHelper } from "../main/windows-path-kind-launcher.js";
import { assertManagedChildProcessAdmissionOpen, retainUnterminatedChildProcess, trackManagedChildProcess } from "../main/managed-child-processes.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

const MAX_POLICY_BYTES = 4 * 1024 * 1024;

class PolicyHelperTerminationError extends Error {
  readonly outcome = "left";
  constructor(cause: Error | undefined) {
    super(`Windows sandbox policy helper was left; termination was not confirmed${cause ? `: ${cause.message}` : ""}`, { cause });
  }
}

export async function openMxcPolicyPipe(bytes: Buffer, pipe: string): Promise<{
  bindChild(child: childProcess.ChildProcess): void;
  release(): Promise<void>;
}> {
  if (!bytes.length || bytes.length > MAX_POLICY_BYTES) throw new Error("Windows sandbox policy frame length is invalid");
  if (!/^\\\\\.\\pipe\\ave-mxc-[a-f0-9]{32}$/u.test(pipe)) throw new Error("Windows sandbox policy pipe name is invalid");
  const helper = resolveWindowsPathKindHelper();
  assertManagedChildProcessAdmissionOpen("mxc:policy");
  const server = childProcess.spawn(helper, ["--mxc-policy", pipe, String(TOOL_TIMEOUT_POLICY.mxcRequestTransportMs)], {
    cwd: dirname(helper), windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
  });
  let stopTracking: ReturnType<typeof trackManagedChildProcess> | undefined;
  let bound: childProcess.ChildProcess | undefined;
  let closed = false;
  let exited = false;
  let released = false;
  let ready = false;
  let failing = false;
  let failure: Error | undefined;
  let rejectReady: (error: Error) => void = () => {};
  let resolveClosed: () => void;
  const completion = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let releasePromise: Promise<void> | undefined;
  const recordFailure = (error: unknown): Error => failure ??= error instanceof Error ? error : new Error(String(error));
  const cleanup = (operation: () => unknown): void => {
    try { operation(); } catch (error) { recordFailure(error); }
  };
  const release = (): Promise<void> => {
    if (releasePromise) return releasePromise;
    released = true;
    clearTimeout(timer);
    releasePromise = Promise.resolve().then(async () => {
      let stopped: Promise<void> | undefined;
      if (!closed) {
        stopped = new Promise<void>((resolve) => {
          const deadline = setTimeout(() => {
            if (!exited && !closed && server.exitCode == null && server.signalCode == null) {
              cleanup(() => retainUnterminatedChildProcess(server, "mxc:policy"));
              failure = new PolicyHelperTerminationError(failure);
            }
            resolve();
          }, process.platform === "win32" ? TOOL_TIMEOUT_POLICY.windowsProcessTreeKillMs : TOOL_TIMEOUT_POLICY.processTreeKillMs);
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
      let response = "";
      server.stdout.setEncoding("utf8");
      server.stdout.on("data", (chunk: string) => {
        if (released) return;
        response += chunk;
        if (response === "ready\n") { ready = true; resolve(); }
        else if (response.length > 64 || response.includes("\n")) void fail(new Error("Windows sandbox policy helper sent an invalid response"));
      });
      server.stdout.once("end", () => {
        if (!ready) void fail(new Error("Windows sandbox policy helper sent an incomplete response"));
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
        server.stdin.write(pid);
      },
      release,
    };
  } catch (error) {
    recordFailure(error);
    await release();
    throw error;
  }
}
