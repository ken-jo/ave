import childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as helperPath from "../../main/windows-path-kind-launcher.js";
import * as managedChildren from "../../main/managed-child-processes.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { openMxcPolicyPipe } from "../mxc-policy-pipe.js";
import { configureHostResources } from "../../main/host-resources.js";
import { requireMxcPolicyPipeHelper } from "../../__tests__/support/mxc-capability.js";

const PIPE = String.raw`\\.\pipe\ave-mxc-0123456789abcdef0123456789abcdef`;

function helperChild() {
  const child = new childProcess.ChildProcess();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr });
  const kill = vi.spyOn(child, "kill").mockImplementation(() => {
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return true;
  });
  return { child, stdin, stdout, stderr, kill };
}

beforeEach(() => {
  vi.spyOn(helperPath, "resolveWindowsPathKindHelper").mockReturnValue(String.raw`C:\Ave\ave-path-kind.exe`);
  vi.spyOn(managedChildren, "trackManagedChildProcess").mockReturnValue(() => {});
});

describe.skipIf(process.platform !== "win32")("native policy pipe EOF", () => {
  for (const probe of [false, true]) it(`reads the full multi-chunk payload to EOF after an existence probe: ${probe}`, async (context) => {
    vi.restoreAllMocks();
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    requireMxcPolicyPipeHelper(context.skip);
    const payload = Buffer.from("policy-".repeat(12_000));
    const pipe = String.raw`\\.\pipe\ave-mxc-${randomBytes(16).toString("hex")}`;
    const transport = await openMxcPolicyPipe(payload, pipe);
    try {
      const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>((resolveResult) => {
        const child = childProcess.execFile(process.execPath, ["-e", `
          const fs = require("node:fs");
          const pipe = process.argv[1];
          const expected = Buffer.from("policy-".repeat(12_000));
          const counts = [];
          for (let attempt = 0; attempt < 2; attempt++) {
            const fd = fs.openSync(pipe, "r");
            try {
              if (${probe} && attempt === 0) { counts.push(0); continue; }
              const chunks = [];
              const buffer = Buffer.alloc(1024);
              for (;;) {
                const count = fs.readSync(fd, buffer, 0, buffer.length, null);
                if (count === 0) break;
                chunks.push(Buffer.from(buffer.subarray(0, count)));
              }
              if (!Buffer.concat(chunks).equals(expected)) throw new Error("Policy payload mismatch");
              counts.push(chunks.length);
            } finally { fs.closeSync(fd); }
          }
          process.stdout.write(JSON.stringify(counts));
        `, pipe], {
          windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.mxcRequestTransportMs,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        }, (error, stdout, stderr) => resolveResult({ error, stdout, stderr }));
        transport.bindChild(child);
      });
      expect(result.stderr).toBe("");
      expect(result.error).toBeNull();
      const counts = JSON.parse(result.stdout) as number[];
      expect(counts).toHaveLength(2);
      if (probe) expect(counts[0]).toBe(0);
      else expect(counts[0]).toBeGreaterThan(1);
      expect(counts[1]).toBeGreaterThan(1);
    } finally { await transport.release(); }
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("native policy pipe lifecycle", () => {
  it("sends policy and launcher PID only over private helper stdin", async () => {
    const helper = helperChild();
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      queueMicrotask(() => helper.stdout.write("ready\n"));
      return helper.child as ReturnType<typeof childProcess.spawn>;
    });
    const transport = await openMxcPolicyPipe(Buffer.from("policy"), PIPE);
    const client = new childProcess.ChildProcess();
    Object.assign(client, { pid: 1234 });
    transport.bindChild(client);
    const received = helper.stdin.read() as Buffer;
    expect(received.readUInt32LE(0)).toBe(6);
    expect(received.subarray(4, 10).toString()).toBe("policy");
    expect(received.readUInt32LE(10)).toBe(1234);
    expect(helperPath.resolveWindowsPathKindHelper).toHaveBeenCalledOnce();
    const resolvedHelper = String.raw`C:\Ave\ave-path-kind.exe`;
    expect(spawn.mock.calls[0]?.[0]).toBe(resolvedHelper);
    expect(spawn.mock.calls[0]?.[2]).toEqual({
      cwd: dirname(resolvedHelper), windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
    });
    expect(spawn.mock.calls[0]?.[1]).toEqual(["--mxc-policy", PIPE, String(TOOL_TIMEOUT_POLICY.mxcRequestTransportMs)]);
    expect(spawn.mock.calls[0]?.[1]).not.toContain("policy");
    await transport.release();
    await transport.release();
    expect(helper.kill).toHaveBeenCalledOnce();
    expect(helper.stdin.destroyed).toBe(true);
  });

  it("refuses to search for a helper when resource identity resolution fails", async () => {
    vi.mocked(helperPath.resolveWindowsPathKindHelper).mockImplementation(() => { throw new Error("missing helper"); });
    const spawn = vi.spyOn(childProcess, "spawn");
    await expect(openMxcPolicyPipe(Buffer.from("policy"), PIPE)).rejects.toThrow("missing helper");
    expect(spawn).not.toHaveBeenCalled();
  });

  for (const size of [0, 4 * 1024 * 1024 + 1]) it(`rejects invalid policy frame length ${size} before spawn`, async () => {
    const spawn = vi.spyOn(childProcess, "spawn");
    await expect(openMxcPolicyPipe(Buffer.alloc(size), PIPE)).rejects.toThrow("frame length is invalid");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects filesystem paths in the pipe argument before spawn", async () => {
    const spawn = vi.spyOn(childProcess, "spawn");
    await expect(openMxcPolicyPipe(Buffer.from("policy"), String.raw`C:\example\policy.json`)).rejects.toThrow("pipe name is invalid");
    expect(spawn).not.toHaveBeenCalled();
  });

  for (const pid of [0, -1, 1.5, 0x1_0000_0000]) it(`rejects invalid launcher PID ${pid} without sending a PID frame`, async () => {
    const helper = helperChild();
    vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      queueMicrotask(() => helper.stdout.write("ready\n"));
      return helper.child as ReturnType<typeof childProcess.spawn>;
    });
    const transport = await openMxcPolicyPipe(Buffer.from("policy"), PIPE);
    expect((helper.stdin.read() as Buffer).length).toBe(10);
    const client = new childProcess.ChildProcess();
    Object.assign(client, { pid });
    const kill = vi.spyOn(client, "kill").mockReturnValue(true);
    transport.bindChild(client);
    await transport.release();
    expect(helper.stdin.read()).toBeNull();
    expect(helper.kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledOnce();
  });

  for (const response of ["ready\r\n", "ready"]) it(`fails closed on malformed readiness ${JSON.stringify(response)}`, async () => {
    const helper = helperChild();
    vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      queueMicrotask(() => helper.stdout.end(response));
      return helper.child as ReturnType<typeof childProcess.spawn>;
    });
    await expect(openMxcPolicyPipe(Buffer.from("policy"), PIPE)).rejects.toThrow(/invalid response|incomplete response/);
    expect(helper.kill).toHaveBeenCalledOnce();
  });

  it("fails closed when the private policy write is interrupted", async () => {
    const helper = helperChild();
    vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      queueMicrotask(() => helper.stdin.emit("error", new Error("short policy write")));
      return helper.child as ReturnType<typeof childProcess.spawn>;
    });
    await expect(openMxcPolicyPipe(Buffer.from("policy"), PIPE)).rejects.toThrow("short policy write");
    expect(helper.kill).toHaveBeenCalledOnce();
  });

  it("keeps release pending until the helper closes, including repeated calls", async () => {
    const helper = helperChild();
    helper.kill.mockReturnValue(true);
    vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      queueMicrotask(() => helper.stdout.write("ready\n"));
      return helper.child as ReturnType<typeof childProcess.spawn>;
    });
    const transport = await openMxcPolicyPipe(Buffer.from("policy"), PIPE);
    let settled = false;
    const pending = Promise.all([transport.release(), transport.release()]).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(helper.kill).toHaveBeenCalledOnce();
    helper.child.emit("close", null, "SIGTERM");
    await pending;
    expect(settled).toBe(true);
  });

  it("closes the pipe helper when launcher spawn fails", async () => {
    const helper = helperChild();
    vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      queueMicrotask(() => helper.stdout.write("ready\n"));
      return helper.child as ReturnType<typeof childProcess.spawn>;
    });
    const transport = await openMxcPolicyPipe(Buffer.from("policy"), PIPE);
    const client = new childProcess.ChildProcess();
    transport.bindChild(client);
    client.emit("error", new Error("spawn ENOENT"));
    await transport.release();
    expect(helper.kill).toHaveBeenCalledOnce();
    expect(helper.stdin.destroyed).toBe(true);
  });

  it("cleans up a helper that fails to spawn", async () => {
    const helper = helperChild();
    vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      queueMicrotask(() => { helper.child.emit("error", new Error("spawn ENOENT")); helper.child.emit("close", -1, null); });
      return helper.child as ReturnType<typeof childProcess.spawn>;
    });
    await expect(openMxcPolicyPipe(Buffer.from("policy"), PIPE)).rejects.toThrow("spawn ENOENT");
    expect(helper.stdin.destroyed).toBe(true);
  });

  it("bounds helper preparation and closes it on timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const helper = helperChild();
    helper.kill.mockReturnValue(true);
    vi.spyOn(childProcess, "spawn").mockReturnValue(helper.child as ReturnType<typeof childProcess.spawn>);
    let settled = false;
    const pending = expect(openMxcPolicyPipe(Buffer.from("policy"), PIPE).finally(() => { settled = true; })).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.mxcRequestTransportMs);
    expect(helper.kill).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    helper.child.emit("close", null, "SIGTERM");
    await pending;
  });

  it("kills the bound launcher if delivery expires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const helper = helperChild();
    vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      queueMicrotask(() => helper.stdout.write("ready\n"));
      return helper.child as ReturnType<typeof childProcess.spawn>;
    });
    const transport = await openMxcPolicyPipe(Buffer.from("policy"), PIPE);
    const client = new childProcess.ChildProcess();
    Object.assign(client, { pid: 1234 });
    const kill = vi.spyOn(client, "kill").mockReturnValue(true);
    transport.bindChild(client);
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.mxcRequestTransportMs);
    expect(kill).toHaveBeenCalled();
    expect(helper.kill).toHaveBeenCalledOnce();
    await transport.release();
  });
});
