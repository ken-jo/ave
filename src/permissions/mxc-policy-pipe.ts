import childProcess from "node:child_process";
import { dirname } from "node:path";
import { resolveWindowsPathKindHelper } from "../main/windows-path-kind-launcher.js";
import { assertManagedChildProcessAdmissionOpen, trackManagedChildProcess } from "../main/managed-child-processes.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

const MAX_POLICY_BYTES = 4 * 1024 * 1024;

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
  const stopTracking = trackManagedChildProcess(server, { killProcessGroup: false, label: "mxc:policy" });
  let bound: childProcess.ChildProcess | undefined;
  let closed = false;
  let released = false;
  let ready = false;
  let failure: Error | undefined;
  let rejectReady: (error: Error) => void = () => {};
  let resolveClosed: () => void;
  const completion = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const release = async (): Promise<void> => {
    if (!released) {
      released = true;
      clearTimeout(timer);
      if (!closed) {
        server.stdin.destroy();
        server.kill();
      }
    }
    await completion;
  };
  const fail = async (error: Error): Promise<void> => {
    if (failure) return;
    failure = error;
    if (bound?.exitCode === null && bound.signalCode === null) bound.kill();
    await release();
    rejectReady(failure);
  };
  const timer = setTimeout(() => fail(new Error("Windows sandbox policy delivery timed out")), TOOL_TIMEOUT_POLICY.mxcRequestTransportMs);
  timer.unref();
  server.on("error", (error) => { void fail(error); });
  server.stdin.on("error", (error) => { void fail(error); });
  server.stderr.resume();
  server.once("close", (code) => {
    closed = true;
    clearTimeout(timer);
    stopTracking();
    resolveClosed();
    if (!ready || code !== 0) void fail(new Error("Windows sandbox policy helper failed; rebuild the Windows native assets"));
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
      const header = Buffer.alloc(4);
      header.writeUInt32LE(bytes.length);
      server.stdin.write(Buffer.concat([header, bytes]));
    });
    return {
      bindChild: (child) => {
        if (bound !== undefined) throw new Error("Windows sandbox policy client is already bound");
        bound = child;
        child.once("error", () => { void release(); });
        child.once("close", () => { void release(); });
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
    await release();
    throw error;
  }
}
