import childProcess from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Duplex } from "node:stream";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../__tests__/support/deferred.js";
import * as helperPath from "../../main/windows-path-kind-launcher.js";
import * as managedChildren from "../../main/managed-child-processes.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { openMxcPolicyPipe } from "../mxc-policy-pipe.js";
import { configureHostResources } from "../../main/host-resources.js";
import { requireMxcPolicyPipeHelper } from "../../__tests__/support/mxc-capability.js";
import { createPolicyPipeHelper } from "../../__tests__/support/policy-pipe-helper.js";
import { holdWindowsDirectory, type HeldWindowsDirectory } from "../../shared/windows-path-facts.js";
import { createContainedShellLifecycle } from "../../tools/contained-shell-lifecycle.js";

const PIPE = String.raw`\\.\pipe\ave-mxc-0123456789abcdef0123456789abcdef`;

function helperChild() {
  return createPolicyPipeHelper(new childProcess.ChildProcess());
}

beforeEach(() => {
  vi.spyOn(helperPath, "withWindowsPathKindHelper").mockImplementation(launch => launch(String.raw`C:\Ave\ave-path-kind.exe`));
  vi.spyOn(managedChildren, "trackManagedChildProcess").mockReturnValue(() => {});
});

describe.skipIf(process.platform !== "win32")("native policy pipe EOF", () => {
  for (const { probe, gated } of [
    { probe: false, gated: false },
    { probe: true, gated: false },
    { probe: true, gated: true },
  ]) it(`reads the full multi-chunk payload to EOF (existence probe: ${probe}, release gate: ${gated})`, async (context) => {
    vi.restoreAllMocks();
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    requireMxcPolicyPipeHelper(context.skip);
    const payload = Buffer.from("policy-".repeat(12_000));
    const pipe = String.raw`\\.\pipe\ave-mxc-${randomBytes(16).toString("hex")}`;
    const root = gated ? mkdtempSync(join(tmpdir(), "mxc-policy-gate-")) : undefined;
    let transport: Awaited<ReturnType<typeof openMxcPolicyPipe>> | undefined;
    try {
      const owned = await openMxcPolicyPipe(payload, pipe, root === undefined ? undefined : {
        root, signal: new AbortController().signal, assertStillValid: () => {},
      });
      transport = owned;
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
        owned.bindChild(child);
      });
      expect(result.stderr).toBe("");
      expect(result.error).toBeNull();
      const counts = JSON.parse(result.stdout) as number[];
      expect(counts).toHaveLength(2);
      if (probe) expect(counts[0]).toBe(0);
      else expect(counts[0]).toBeGreaterThan(1);
      expect(counts[1]).toBeGreaterThan(1);
    } finally {
      try { await transport?.release(); }
      finally { if (root !== undefined) rmSync(root, { recursive: true, force: true }); }
    }
  });
  for (const withdraw of ["lifecycle", "proof", "granted proof"] as const) it(`refuses a held native read after ${withdraw} withdrawal`, async (context) => {
    vi.restoreAllMocks();
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    requireMxcPolicyPipeHelper(context.skip);
    const root = mkdtempSync(join(tmpdir(), "mxc-policy-withdrawal-"));
    const pipe = String.raw`\\.\pipe\ave-mxc-${randomBytes(16).toString("hex")}`;
    const controller = new AbortController();
    let proved = true;
    const assertStillValid = vi.fn(() => { if (!proved) throw new Error("Launch proof withdrawn"); });
    const granted = deferred<() => void>();
    if (withdraw === "granted proof") {
      const spawn = childProcess.spawn;
      vi.spyOn(childProcess, "spawn").mockImplementation((...args: Parameters<typeof spawn>) => {
        const server = spawn(...args);
        const stdin = server.stdin;
        if (!stdin || !Array.isArray(args[1]) || args[1][0] !== "--mxc-policy") return server;
        const write = stdin.write.bind(stdin);
        vi.spyOn(stdin, "write").mockImplementation((chunk, callback) => {
          if (!Buffer.isBuffer(chunk) || !chunk.equals(Buffer.from([1]))) return write(chunk, callback);
          granted.resolve(() => { write(chunk, callback); });
          return true;
        });
        return server;
      });
    }
    let transport: Awaited<ReturnType<typeof openMxcPolicyPipe>> | undefined;
    let child: childProcess.ChildProcess | undefined;
    try {
      const owned = await openMxcPolicyPipe(Buffer.from("held-policy"), pipe, { root, signal: controller.signal, assertStillValid });
      transport = owned;
      const done = new Promise<string>((resolveResult) => {
        child = childProcess.execFile(process.execPath, ["-e", `
          process.stdin.once("data", () => {
            const fs = require("node:fs");
            const fd = fs.openSync(process.argv[1], "r");
            try {
              const bytes = Buffer.alloc(32);
              const size = fs.readSync(fd, bytes, 0, bytes.length, null);
              process.stdout.write(bytes.subarray(0, size));
            } finally { fs.closeSync(fd); }
          });
        `, pipe], {
          windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.mxcRequestTransportMs,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        }, (_error, stdout) => resolveResult(stdout));
        owned.bindChild(child);
      });
      let before = assertStillValid.mock.calls.length;
      if (withdraw === "lifecycle") controller.abort();
      if (withdraw === "proof") proved = false;
      child?.stdin?.end("read");
      if (withdraw === "granted proof") {
        const resume = await Promise.race([granted.promise, done.then(() => { throw new Error("Native receiver never obtained a permit"); })]);
        before = assertStillValid.mock.calls.length;
        proved = false;
        expect(readdirSync(root)).toHaveLength(1);
        resume();
      }
      expect(await done).toBe("");
      if (withdraw !== "lifecycle") {
        expect(controller.signal.aborted).toBe(false);
        expect(assertStillValid.mock.calls.length).toBeGreaterThan(before);
      }
    } finally {
      child?.kill();
      try { await transport?.release().catch(() => {}); }
      finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
});
describe.skipIf(process.platform !== "win32")("native held policy delivery", () => {
  const payload = "reader-policy-".repeat(12_000);
  const reader = `
    const fs = require("node:fs");
    const expected = Buffer.from("reader-policy-".repeat(12000));
    const counts = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const fd = fs.openSync(process.argv[1], "r");
      const buffer = Buffer.alloc(1024);
      const chunks = [];
      try {
        for (;;) {
          const count = fs.readSync(fd, buffer, 0, buffer.length, null);
          if (!count) break;
          chunks.push(Buffer.from(buffer.subarray(0, count)));
        }
      } finally { fs.closeSync(fd); }
      const data = Buffer.concat(chunks);
      if (!data.equals(expected)) throw new Error("Policy payload mismatch");
      counts.push(data.length);
    }
    process.stdout.write(JSON.stringify(counts));
  `;
  const fixture = resolve("resources/windows-job", process.arch, "ave-job-policy-reader-test.exe");

  async function withHold(check: (held: HeldWindowsDirectory) => Promise<void>): Promise<void> {
    vi.restoreAllMocks();
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "ave-held-policy-")));
    const held = await holdWindowsDirectory(directory);
    try {
      if (held === undefined) throw new Error("Native directory hold failed");
      await check(held);
    } finally {
      await held?.release();
      rmSync(directory, { recursive: true, force: true });
    }
  }

  function start(held: HeldWindowsDirectory, script: string, pipe?: string, binary?: string, mode?: string, fault?: string) {
    const { executable, args } = held.command(process.execPath, ["-e", script, ...(pipe === undefined ? [] : [pipe])], true);
    if (mode !== undefined) args[0] = mode;
    const child = childProcess.spawn(binary ?? executable, args, {
      env: {
        ...process.env, ELECTRON_RUN_AS_NODE: "1",
        ...(pipe === undefined ? {} : { AVE_TEST_POLICY_READER_PIPE: pipe }),
        ...(fault === undefined ? {} : { AVE_TEST_POLICY_FAULT: fault }),
      },
      stdio: [...held.stdio, "pipe", "pipe", ...(fault === undefined ? [] : ["pipe" as const])], windowsHide: true,
    });
    const control = child.stdio.at(5) as Duplex;
    const report = child.stdio.at(6) as Duplex;
    const gate = child.stdio.at(7) as Duplex | undefined;
    for (const stream of [control, report, gate]) stream?.on("error", () => {});
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    return { child, control, report, gate, output: () => stdout.replaceAll("\r\n", "\n"), errors: () => stderr };
  }

  it.for([
    { binary: undefined, otherReaders: false, gated: false },
    { binary: fixture, otherReaders: true, gated: false },
    { binary: undefined, otherReaders: false, gated: true },
  ])("serves two exact reads through the real held launcher (other readers: $otherReaders, release gate: $gated)", async ({ binary, otherReaders, gated }, context) => {
    if (binary !== undefined && !existsSync(binary)) context.skip("Build the separate policy reader fixture to test the launcher and sibling PIDs");
    await withHold(async (held) => {
      requireMxcPolicyPipeHelper(context.skip);
      const pipe = PIPE.slice(0, -32) + randomBytes(16).toString("hex");
      const root = gated ? mkdtempSync(join(tmpdir(), "mxc-held-policy-gate-")) : undefined;
      const assertStillValid = vi.fn();
      let transport: Awaited<ReturnType<typeof openMxcPolicyPipe>> | undefined;
      try {
        const owned = await openMxcPolicyPipe(Buffer.from(payload), pipe, root === undefined ? true : {
          root, signal: new AbortController().signal, assertStillValid, held: true,
        });
        transport = owned;
        const launcher = start(held, reader, pipe, binary);
        const failed = vi.fn();
        const bindHeldPolicy = owned.bindHeldPolicy;
        if (bindHeldPolicy === undefined) throw new Error("Native held policy binder is unavailable");
        let checksAtBinding = 0;
        const bind = vi.fn(async (pid: number, onFailure: () => void) => {
          await bindHeldPolicy(launcher.child, pid, onFailure);
          checksAtBinding = assertStillValid.mock.calls.length;
        });
        const run = held.bind(launcher.child, { bindReader: bind, onFailure: failed });
        expect(await run.verdict, launcher.errors()).toEqual({ kind: "ok", stopped: false });
        expect(launcher.child.exitCode, launcher.errors()).toBe(0);
        expect(bind).toHaveBeenCalledOnce();
        expect(bind.mock.calls[0]?.[0]).not.toBe(launcher.child.pid);
        expect(failed).not.toHaveBeenCalled();
        const reads = JSON.stringify([payload.length, payload.length]);
        expect(launcher.output()).toBe(otherReaders ? `other-readers 0 0\n${reads}` : reads);
        if (gated) expect(assertStillValid.mock.calls.length - checksAtBinding).toBe(4);
      } finally {
        try { await transport?.release(); }
        finally { if (root !== undefined) rmSync(root, { recursive: true, force: true }); }
      }
    });
  });

  it.for(["bad version", "wrong PID", "trailing data", "partial", "owner loss", "timeout"] as const)(
    "kills the suspended job before user code on %s", { timeout: TOOL_TIMEOUT_POLICY.windowsHoldStopMs * 2 }, async (fault) => {
      await withHold(async (held) => {
        const launcher = start(held, "process.stdout.write('resumed');");
        const run = held.bind(launcher.child);
        let pid: number | undefined;
        const onReport = (): void => {
          const report = launcher.report.read(16) as Buffer | null;
          if (report === null) return;
          launcher.report.off("readable", onReport);
          const reply = report.subarray(0, 8);
          pid = reply.readUInt32LE(4);
          if (fault === "timeout") return;
          if (fault === "owner loss") {
            launcher.child.stdin?.destroy();
            return;
          }
          reply.write(fault === "bad version" ? "AVR2" : "AVR1");
          if (fault === "wrong PID") reply.writeUInt32LE(launcher.child.pid ?? 0, 4);
          const response = fault === "trailing data" ? Buffer.concat([reply, reply]) : fault === "partial" ? reply.subarray(0, 7) : reply;
          launcher.control.end(response, () => launcher.control.destroy());
        };
        launcher.report.on("readable", onReport);
        expect(await run.verdict, launcher.errors()).toEqual({ kind: "unconfirmed" });
        expect(launcher.child.exitCode).toBe(125);
        expect(launcher.output()).toBe("");
        if (pid === undefined || pid === 0) throw new Error("The suspended PID was not reported");
        const reportedPid = pid;
        await vi.waitFor(() => expect(() => process.kill(reportedPid, 0)).toThrow("ESRCH"));
      });
    },
  );

  it.each(["bind failure", "cancellation"] as const)("stops a real held reader on %s", async (fault) => {
    await withHold(async (held) => {
      const launcher = start(held, "process.stdout.write('resumed');");
      let acknowledge: () => void = () => {};
      const pendingBind = new Promise<void>((resolve) => { acknowledge = resolve; });
      let readerArrived: (pid: number) => void = () => {};
      const reported = new Promise<number>((resolve) => { readerArrived = resolve; });
      const failed = vi.fn();
      const run = held.bind(launcher.child, {
        async bindReader(pid) {
          readerArrived(pid);
          if (fault === "bind failure") throw new Error("binding failed");
          await pendingBind;
        },
        onFailure: failed,
      });
      const pid = await reported;
      if (fault === "cancellation") {
        void run.stop();
        acknowledge();
      }
      expect(await run.verdict, launcher.errors()).toEqual({ kind: "unconfirmed" });
      expect(launcher.output()).toBe("");
      expect(failed).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow("ESRCH"));
    });
  });

  it("refuses a reader report with a non-ASCII header byte", async () => {
    await withHold(async (held) => {
      const launcher = start(held, "process.stdout.write('resumed');");
      launcher.report.prependOnceListener("data", (chunk: Buffer) => { chunk[0] = chunk.readUInt8(0) | 0x80; });
      const bindReader = vi.fn(async () => {});
      const failed = vi.fn();
      const run = held.bind(launcher.child, { bindReader, onFailure: failed });
      expect(await run.verdict, launcher.errors()).toEqual({ kind: "unconfirmed" });
      expect(bindReader).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledOnce();
      expect(launcher.output()).toBe("");
    });
  });

  it.for([{ fault: "early report", phase: "E" }, { fault: "delayed trailer", phase: "T" }])(
    "rejects a $fault without binding or executing the child", async ({ fault, phase }, context) => {
      if (!existsSync(fixture)) context.skip("Native policy reader fixture is absent");
      await withHold(async (held) => {
        const launcher = start(held, "process.stdout.write('resumed');", undefined, fixture, undefined, fault);
        const { gate } = launcher;
        if (gate === undefined) throw new Error("Native policy fixture gate is absent");
        const report = once(launcher.report, fault === "early report" ? "end" : "data");
        const gated = once(gate, "data");
        const bindReader = vi.fn(async () => {});
        const failed = vi.fn();
        const run = held.bind(launcher.child, { bindReader, onFailure: failed });
        const [[ready]] = await Promise.all([gated, report]) as [[Buffer], unknown[]];
        expect(ready.toString()).toBe(phase);
        gate.write("+");
        expect(await run.verdict, launcher.errors()).toEqual({ kind: "unconfirmed" });
        expect(bindReader).not.toHaveBeenCalled();
        expect(failed).toHaveBeenCalledOnce();
        expect(launcher.output()).toBe("");
        expect(launcher.child.exitCode).toBe(125);
      });
    },
  );

  it.for([
    { stop: "cancellation", watcher: "first" },
    { stop: "owner loss", watcher: "first" },
    { stop: "cancellation", watcher: "delayed" },
    { stop: "owner loss", watcher: "delayed" },
  ])(
    "keeps the reader suspended on $stop after the resume reply (watcher: $watcher)", async ({ stop, watcher }, context) => {
      if (!existsSync(fixture)) context.skip("Native policy reader fixture is absent");
      await withHold(async (held) => {
        const fault = watcher === "delayed" ? "delay owner watcher" : "stop before resume";
        const launcher = start(held, "process.stdout.write('resumed');", undefined, fixture, undefined, fault);
        const { gate } = launcher;
        const { stdin } = launcher.child;
        if (gate === undefined || stdin === null) throw new Error("Native policy fixture pipes are absent");
        const gated = once(gate, "data");
        let record = "";
        launcher.child.stdio.at(4)?.on("data", (chunk: Buffer) => { record += chunk.toString("latin1"); });
        let pid = 0;
        const bindReader = vi.fn(async (reported: number) => { pid = reported; });
        const lifecycle = createContainedShellLifecycle();
        const revoked = vi.fn();
        lifecycle.onRevoke(revoked);
        const run = held.bind(launcher.child, { bindReader, onFailure: lifecycle.revoke });
        lifecycle.jobStarted(run.verdict);
        const disposed = run.verdict.then(() => lifecycle.dispose());
        const [ready] = await gated as [Buffer];
        expect(ready.toString()).toBe(watcher === "delayed" ? "D" : "R");
        expect(bindReader).toHaveBeenCalledOnce();
        expect(pid).not.toBe(0);
        expect(() => process.kill(pid, 0)).not.toThrow();
        expect(launcher.output()).toBe("");
        expect(lifecycle.signal.aborted).toBe(false);
        const ownerClosed = once(stdin, "close");
        if (stop === "cancellation") void run.stop();
        else stdin.destroy();
        await ownerClosed;
        if (stop === "cancellation") expect(revoked).toHaveBeenCalledOnce();
        gate.write("+");
        const verdict = await run.verdict;
        expect(await disposed).toEqual([]);
        await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow("ESRCH"));
        expect({ verdict, record, exitCode: launcher.child.exitCode, output: launcher.output() }, launcher.errors()).toEqual({
          verdict: { kind: "unconfirmed" }, record: "AVJ1 unconfirmed\n", exitCode: 125, output: "",
        });
        expect(lifecycle.signal.aborted).toBe(true);
        expect(revoked).toHaveBeenCalledOnce();
      });
    },
  );

  it("expires while the owner watcher holds the startup lock", { timeout: TOOL_TIMEOUT_POLICY.windowsHoldStopMs * 2 }, async (context) => {
    if (!existsSync(fixture)) context.skip("Native policy reader fixture is absent");
    await withHold(async (held) => {
      const launcher = start(held, "process.stdout.write('resumed');", undefined, fixture, undefined, "contend startup lock");
      const { gate } = launcher;
      if (gate === undefined) throw new Error("Native policy fixture gate is absent");
      const gated = once(gate, "data") as Promise<[Buffer]>;
      let record = "";
      launcher.child.stdio.at(4)?.on("data", (chunk: Buffer) => { record += chunk.toString("latin1"); });
      const bindReader = vi.fn(async (_pid: number) => { await gated; });
      const run = held.bind(launcher.child, { bindReader, onFailure: vi.fn() });
      const [ready] = await gated;
      expect(ready.toString()).toBe("L");

      // Let an unbounded acquisition proceed after the native ten-second deadline.
      let released = false;
      const release = setTimeout(() => {
        released = true;
        gate.write("+");
      }, 13_000);
      try {
        const verdict = await run.verdict;
        const pid = bindReader.mock.calls[0]?.[0];
        if (pid === undefined || pid === 0) throw new Error("The suspended PID was not bound");
        expect(bindReader).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow("ESRCH"));
        expect({ verdict, record, exitCode: launcher.child.exitCode, output: launcher.output(), released }, launcher.errors()).toEqual({
          verdict: { kind: "unconfirmed" }, record: "AVJ1 unconfirmed\n", exitCode: 125, output: "", released: false,
        });
      } finally { clearTimeout(release); }
    });
  });

  it("reaps a running held reader when the owner closes after resume", async () => {
    await withHold(async (held) => {
      const launcher = start(held, "process.stdout.write('resumed'); setInterval(() => {}, 1000);");
      const { stdin, stdout } = launcher.child;
      if (stdin === null || stdout === null) throw new Error("Native policy launcher pipes are absent");
      const running = once(stdout, "data");
      const bindReader = vi.fn(async (_pid: number) => {});
      const run = held.bind(launcher.child, { bindReader, onFailure: vi.fn() });
      await running;
      expect(launcher.output()).toBe("resumed");
      const pid = bindReader.mock.calls[0]?.[0];
      if (pid === undefined) throw new Error("The reader PID was not bound");
      stdin.destroy();
      expect(await run.verdict, launcher.errors()).toEqual({ kind: "ok", stopped: false });
      expect(launcher.child.exitCode).toBe(130);
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow("ESRCH"));
    });
  });

  it("rejects a resume frame queued before the launcher reports the reader", async () => {
    await withHold(async (held) => {
      const launcher = start(held, "process.stdout.write('resumed');");
      let reportedBytes = 0;
      launcher.report.on("data", (chunk: Buffer) => { reportedBytes += chunk.length; });
      // Keep hold admission pending until the unexpected record is in the control pipe.
      launcher.control.write(Buffer.from([0x41, 0x56, 0x52, 0x31, 1, 0, 0, 0]));
      const run = held.bind(launcher.child);
      expect(await run.verdict).toEqual({ kind: "unconfirmed" });
      expect(launcher.child.exitCode).toBe(125);
      expect(launcher.output()).toBe("");
      expect(reportedBytes).toBe(0);
    });
  });

  it("rejects an unsupported launch mode before starting a child", async () => {
    await withHold(async (held) => {
      const launcher = start(held, "process.stdout.write('resumed');", undefined, undefined, "--hold-policy-v2");
      const run = held.bind(launcher.child);
      expect(await run.verdict).toEqual({ kind: "unconfirmed" });
      expect(launcher.child.exitCode).toBe(125);
      expect(launcher.output()).toBe("");
    });
  });

  it("rejects a pipe-backed request from a legacy held host before starting a child", async () => {
    await withHold(async (held) => {
      const target = held.command(process.execPath, ["-e", "process.stdout.write('started');", "--", "--config", PIPE]);
      const child = childProcess.spawn(target.executable, target.args, {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: held.stdio, windowsHide: true,
      });
      const output: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => { output.push(chunk); });
      const run = held.bind(child);
      const result = { verdict: await run.verdict, exit: child.exitCode, output: Buffer.concat(output).toString() };
      expect(result).toEqual({ verdict: { kind: "unconfirmed" }, exit: 125, output: "" });
    });
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("native policy pipe lifecycle", () => {
  for (const platform of ["darwin", "win32"]) it.each(["kill throws", "late exit", "no exit"])(
    `retains failed registration until observed death on ${platform}: %s`, async (ending) => {
      vi.stubGlobal("process", { ...process, platform });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const bound = TOOL_TIMEOUT_POLICY.processTreeKillMs;
      const helper = helperChild();
      const trackFault = new Error("tracking failed");
      vi.mocked(managedChildren.trackManagedChildProcess).mockImplementation(() => { throw trackFault; });
      vi.spyOn(childProcess, "spawn").mockReturnValue(helper.child as ReturnType<typeof childProcess.spawn>);
      const write = vi.spyOn(helper.stdin, "write");
      vi.spyOn(helper.stdin, "destroy").mockImplementation(() => { throw new Error("input close failed"); });
      helper.kill.mockImplementation(() => {
        if (ending === "kill throws") throw new Error("termination failed");
        return true;
      });
      const failures: unknown[] = [];
      const opening = openMxcPolicyPipe(Buffer.from("policy"), PIPE).then(
        () => { throw new Error("Failed tracking admitted a launch"); },
        (error: unknown) => { failures.push(error); },
      );
      try {
        await vi.advanceTimersByTimeAsync(bound - 1);
        expect(write).not.toHaveBeenCalled();
        const beforeDeadline = { settlements: failures.length, owners: managedChildren.getManagedChildProcessCount() };
        if (ending === "late exit") {
          helper.child.emit("exit", 0, null);
          await vi.advanceTimersByTimeAsync(1);
          expect(failures).toEqual([trackFault]);
          await opening;
          expect(beforeDeadline).toEqual({ settlements: 0, owners: 1 });
        } else {
          await vi.advanceTimersByTimeAsync(1);
          expect({ beforeDeadline, failures, owners: managedChildren.getManagedChildProcessCount() }).toMatchObject({
            beforeDeadline: { settlements: 0, owners: 1 }, failures: [{ outcome: "left", cause: trackFault }], owners: 1,
          });
          await opening;
          managedChildren.forceKillManagedChildProcesses("policy helper cleanup");
          expect(managedChildren.getManagedChildProcessCount()).toBe(1);
          await managedChildren.forceKillManagedChildProcess(helper.child, "policy helper cleanup");
          helper.child.emit("error", new Error("late termination error"));
          helper.child.emit("error", new Error("repeated termination error"));
          expect(managedChildren.getManagedChildProcessCount()).toBe(1);
          helper.child.emit("close", 0, null);
        }
        expect(managedChildren.getManagedChildProcessCount()).toBe(0);
      } finally {
        helper.child.emit("close", 0, null);
      }
    },
  );

  it.each(["throws", "missing disposer"])("refuses tracking that %s and terminates the helper", async (fault) => {
    const helper = helperChild();
    helper.kill.mockReturnValue(true);
    vi.spyOn(childProcess, "spawn").mockReturnValue(helper.child as ReturnType<typeof childProcess.spawn>);
    vi.mocked(managedChildren.trackManagedChildProcess).mockImplementation(() => {
      if (fault === "throws") throw new Error("tracking failed");
      // Deliberately violate the runtime contract at this boundary.
      return undefined as unknown as ReturnType<typeof managedChildren.trackManagedChildProcess>;
    });
    const settlements: string[] = [];
    const pending = openMxcPolicyPipe(Buffer.from("policy"), PIPE).then(
      () => { settlements.push("ready"); },
      () => { settlements.push("rejected"); },
    );
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    let closeError: unknown;
    try { helper.child.emit("close", 0, null); } catch (error) { closeError = error; }
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    expect({ closeError, settlements }).toEqual({ closeError: undefined, settlements: ["rejected"] });
    expect(helper.kill).toHaveBeenCalledOnce();
    expect(helper.stdin.destroyed).toBe(true);
    await pending;
  });

  it.each([false, true])("settles when tracking disposal throws, after readiness: %s", async (afterReady) => {
    const helper = helperChild();
    helper.kill.mockReturnValue(true);
    vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      if (afterReady) queueMicrotask(() => helper.stdout.write("ready\n"));
      return helper.child as ReturnType<typeof childProcess.spawn>;
    });
    vi.mocked(managedChildren.trackManagedChildProcess).mockReturnValue(() => { throw new Error("tracking disposal failed"); });
    const opening = openMxcPolicyPipe(Buffer.from("policy"), PIPE);
    const operation = afterReady ? (await opening).release() : opening;
    const settlements: string[] = [];
    const pending = operation.then(
      () => { settlements.push("ready"); },
      (error: Error) => { settlements.push(error.message); },
    );
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    let closeError: unknown;
    try { helper.child.emit("close", 0, null); } catch (error) { closeError = error; }
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    expect({ closeError, settlements }).toEqual({ closeError: undefined, settlements: ["tracking disposal failed"] });
    await pending;
  });

  it("still terminates the helper when closing its input throws", async () => {
    const helper = helperChild();
    vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      queueMicrotask(() => helper.stdout.write("ready\n"));
      return helper.child as ReturnType<typeof childProcess.spawn>;
    });
    const transport = await openMxcPolicyPipe(Buffer.from("policy"), PIPE);
    vi.spyOn(helper.stdin, "destroy").mockImplementation(() => { throw new Error("input close failed"); });
    await expect(transport.release()).rejects.toThrow("input close failed");
    expect(helper.kill).toHaveBeenCalledOnce();
  });

  it.each(["darwin", "win32"])("bounds failed termination and reports the cleanup failure on %s", async (platform) => {
    vi.stubGlobal("process", { ...process, platform });
    expect(TOOL_TIMEOUT_POLICY.processTreeKillMs).toBe(1_000);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const helper = helperChild();
    helper.kill.mockImplementation(() => { throw new Error("termination failed"); });
    vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      queueMicrotask(() => helper.stdout.write("ready\n"));
      return helper.child as ReturnType<typeof childProcess.spawn>;
    });
    const transport = await openMxcPolicyPipe(Buffer.from("policy"), PIPE);
    try {
      const failures: unknown[] = [];
      const pending = transport.release().then(
        () => { throw new Error("Failed termination was accepted"); },
        (error: unknown) => { failures.push(error); },
      );
      await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.processTreeKillMs - 1);
      expect(failures).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      // The cause is carried raw, for whoever reports the failure to read after release.
      expect(failures).toEqual([expect.objectContaining({
        outcome: "left",
        message: "Windows sandbox policy helper was left; termination was not confirmed",
        cause: expect.objectContaining({ message: "termination failed" }),
      })]);
      await pending;
      expect(helper.kill).toHaveBeenLastCalledWith("SIGKILL");
      expect(helper.stdin.destroyed).toBe(true);
      expect(managedChildren.getManagedChildProcessCount()).toBe(1);
    } finally { helper.child.emit("close", 0, null); }
    expect(managedChildren.getManagedChildProcessCount()).toBe(0);
  });

  it("settles a failed termination whose recorded failure cannot be read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const helper = helperChild();
    const unreadable = new Error("termination failed");
    Object.defineProperty(unreadable, "message", { get: () => { throw new Error("message read failed"); } });
    helper.kill.mockImplementation(() => { throw unreadable; });
    vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      queueMicrotask(() => helper.stdout.write("ready\n"));
      return helper.child as ReturnType<typeof childProcess.spawn>;
    });
    const transport = await openMxcPolicyPipe(Buffer.from("policy"), PIPE);
    try {
      const failures: unknown[] = [];
      void transport.release().then(
        () => { failures.push("released"); },
        (error: unknown) => { failures.push(error); },
      );
      await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.processTreeKillMs);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toBeInstanceOf(Error);
      expect((failures[0] as Error & { outcome?: string }).outcome).toBe("left");
      expect((failures[0] as Error).cause).toBe(unreadable);
    } finally { helper.child.emit("close", 0, null); }
  });

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
    expect(helperPath.withWindowsPathKindHelper).toHaveBeenCalledOnce();
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
    vi.mocked(helperPath.withWindowsPathKindHelper).mockImplementation(() => { throw new Error("missing helper"); });
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
    await expect(transport.release()).rejects.toThrow("client did not start");
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

  it("rejects invalid UTF-8 in the readiness reply before binding a client", async () => {
    const helper = helperChild();
    vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      queueMicrotask(() => helper.stdout.end(Buffer.from([0x72, 0xff, 0x0a])));
      return helper.child as ReturnType<typeof childProcess.spawn>;
    });
    await expect(openMxcPolicyPipe(Buffer.from("policy"), PIPE)).rejects.toThrow(/invalid UTF-8/i);
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

  it("rejects the legacy helper readiness before sending a reader PID", async () => {
    const helper = helperChild();
    const write = vi.spyOn(helper.stdin, "write");
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      queueMicrotask(() => helper.stdout.write("ready\n"));
      return helper.child as ReturnType<typeof childProcess.spawn>;
    });
    await expect(openMxcPolicyPipe(Buffer.from("policy"), PIPE, true)).rejects.toThrow("invalid response");
    expect(spawn.mock.calls[0]?.[1]).toEqual(["--mxc-policy-held-v1", PIPE, String(TOOL_TIMEOUT_POLICY.mxcRequestTransportMs)]);
    expect(write).toHaveBeenCalledOnce();
  });

  it.each(["no acknowledgement", "duplicate acknowledgement", "invalid prefix", "success"] as const)(
    "handles held binding with %s", async (scenario) => {
      const helper = helperChild();
      const write = vi.spyOn(helper.stdin, "write");
      vi.spyOn(childProcess, "spawn").mockImplementation(() => {
        queueMicrotask(() => helper.stdout.write("held-v1\n"));
        return helper.child as ReturnType<typeof childProcess.spawn>;
      });
      const transport = await openMxcPolicyPipe(Buffer.from("policy"), PIPE, true);
      const launcher = Object.assign(new childProcess.ChildProcess(), { pid: 1234 });
      const stop = vi.fn();
      let acknowledged = false;
      const bindHeldPolicy = transport.bindHeldPolicy;
      if (bindHeldPolicy === undefined) throw new Error("Held policy binder is unavailable");
      const pending = bindHeldPolicy(launcher, 4321, stop).then(() => { acknowledged = true; });
      const binding = Buffer.alloc(4);
      binding.writeUInt32LE(4321);
      expect(write).toHaveBeenLastCalledWith(binding);
      if (scenario === "duplicate acknowledgement" || scenario === "success") helper.stdout.write("bound\n");
      await Promise.resolve();
      expect(acknowledged).toBe(false);
      if (scenario === "success") {
        helper.stdout.end();
        await pending;
        expect(acknowledged).toBe(true);
        expect(stop).not.toHaveBeenCalled();
        await transport.release();
      } else {
        const rejected = expect(pending).rejects.toThrow("response");
        helper.stdout.end(scenario === "invalid prefix" ? "\uFEFFbound\n" : scenario === "duplicate acknowledgement" ? "bound\n" : undefined);
        await rejected;
        expect(stop).toHaveBeenCalledOnce();
        await expect(transport.release()).rejects.toThrow("response");
      }
    },
  );

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
    await expect(transport.release()).rejects.toThrow("client did not start");
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
    await expect(transport.release()).rejects.toThrow("delivery timed out");
  });
});
