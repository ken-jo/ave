import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { configureHostResources } from "../../main/host-resources.js";
import { TOOL_TIMEOUT_POLICY } from "../tool-timeout-policy.js";

/** One end of a private pipe: `push` is what the process wrote, `written` what it was sent. */
class FakePipe extends Duplex {
  written = "";
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void { this.written += chunk.toString(); done(); }
}

class FakeHelper extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly channel = new FakePipe();
  readonly stdio = [this.stdin, this.stdout, null, this.channel];
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn(() => true);
}

class FakeLauncher extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly relay = new FakePipe();
  readonly report = new PassThrough();
  readonly stdio = [this.stdin, this.stdout, this.stderr, this.relay, this.report];
  pid: number | undefined = 5151;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  /** Write the record, let it arrive, then exit; `close` follows unless a descendant is said to keep the output open. */
  async end(code: number | null, record: string, closes = true): Promise<void> {
    if (record !== "") this.report.write(record);
    await new Promise((resolve) => setImmediate(resolve));
    this.exitCode = code;
    this.emit("exit", code, null);
    if (closes) this.emit("close", code, null);
  }
}

const fake = vi.hoisted(() => ({ helper: undefined as FakeHelper | undefined, real: false }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((...args: Parameters<typeof actual.spawn>) => {
      if (fake.real || fake.helper === undefined) return actual.spawn(...args);
      return fake.helper;
    }),
  };
});

import { spawn } from "node:child_process";
import { holdWindowsDirectory, pinWindowsPaths } from "../windows-path-facts.js";

const MAX_REPLY = 8 * 1024 * 1024;

describe.runIf(process.platform === "win32")("Windows directory hold helper protocol", () => {
  let root: string;
  let row: string;

  beforeEach(() => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    root = realpathSync(mkdtempSync(join(tmpdir(), "ave-hold-protocol-")));
    row = JSON.stringify(pinWindowsPaths([root]));
    fake.helper = new FakeHelper();
    fake.real = false;
    vi.mocked(spawn).mockClear();
  });
  afterEach(async () => {
    vi.useRealTimers();
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    await cleanupTmpDir(root);
  });

  const helper = () => {
    if (fake.helper === undefined) throw new Error("no fake helper");
    return fake.helper;
  };
  const padded = (bytes: number) => Buffer.from(`${row}${" ".repeat(bytes - row.length - 1)}\n`);

  it("accepts a frame of exactly the limit and loses the hold when the helper exits", async () => {
    const frame = padded(MAX_REPLY);
    const pending = holdWindowsDirectory(root);
    helper().stdout.write(frame.subarray(0, MAX_REPLY - 10));
    helper().stdout.write(frame.subarray(MAX_REPLY - 10));
    const held = await pending;
    expect(held?.facts.canonical).toBe((JSON.parse(row) as { canonical: string }[])[0]?.canonical);
    expect(held?.isHeld()).toBe(true);
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(["--hold", root]);
    expect(held?.launcherArgs).toEqual(["--hold"]);
    helper().emit("exit", 1, null);
    expect(held?.isHeld()).toBe(false);
  });

  it("releases once", async () => {
    const pending = holdWindowsDirectory(root);
    helper().stdout.write(`${row}\n`);
    const held = await pending;
    held?.release();
    held?.release();
    helper().emit("exit", 1, null);
    expect(held?.isHeld()).toBe(false);
    expect(helper().kill).toHaveBeenCalledOnce();
  });

  it("refuses a frame that crosses the limit in its final chunk", async () => {
    const frame = padded(MAX_REPLY + 1);
    const pending = holdWindowsDirectory(root);
    helper().stdout.write(frame.subarray(0, MAX_REPLY - 10));
    helper().stdout.write(frame.subarray(MAX_REPLY - 10));
    expect(await pending).toBeUndefined();
    expect(helper().kill).toHaveBeenCalled();
  });

  it.each([
    ["an asynchronous spawn error", (child: FakeHelper) => child.emit("error", new Error("spawn failed"))],
    ["an exit before the reply", (child: FakeHelper) => child.emit("exit", 4, null)],
    ["malformed output", (child: FakeHelper) => child.stdout.write("not a facts row\n")],
    ["a stdout stream error", (child: FakeHelper) => child.stdout.destroy(new Error("pipe broke"))],
  ])("refuses %s", async (_name, fail) => {
    const pending = holdWindowsDirectory(root);
    fail(helper());
    expect(await pending).toBeUndefined();
    expect(helper().kill).toHaveBeenCalled();
  });

  it("refuses a helper that does not answer in time", async () => {
    vi.useFakeTimers();
    const pending = holdWindowsDirectory(root);
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.windowsPathKindQueryMs + 1);
    expect(await pending).toBeUndefined();
    expect(helper().kill).toHaveBeenCalled();
  });

  it("refuses when the helper is missing", async () => {
    configureHostResources({ resourcePath: root, isPackaged: false });
    expect(await holdWindowsDirectory(root)).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  describe("held run verdict", () => {
    const unconfirmed = { kind: "unconfirmed" } as const;
    const start = async (launcher = new FakeLauncher()) => {
      const pending = holdWindowsDirectory(root);
      helper().stdout.write(`${row}\n`);
      const held = await pending;
      if (held === undefined) throw new Error("hold refused");
      return { held, launcher, run: held.bind(launcher as unknown as ChildProcess) };
    };
    const pendingStill = async (verdict: Promise<unknown>): Promise<boolean> => {
      const waiting = Symbol("waiting");
      return await Promise.race([verdict, new Promise((resolve) => setImmediate(() => resolve(waiting)))]) === waiting;
    };

    it.each([
      ["the exact record with its exit code", "AVJ1 ok 3 1\n", 3, { kind: "ok", stopped: true }],
      ["a full-width exit code", "AVJ1 ok 3221225786 0\n", 3221225786, { kind: "ok", stopped: false }],
      ["a lost record with the launcher's refusal code", "AVJ1 lost\n", 125, { kind: "lost" }],
      ["an unconfirmed record", "AVJ1 unconfirmed\n", 125, unconfirmed],
      ["no record, as after a killed launcher or a dead helper", "", 0, unconfirmed],
      ["no record and no exit code", "", null, unconfirmed],
      ["a record whose code differs from the exit", "AVJ1 ok 0 0\n", 1, unconfirmed],
      ["a lost record with another exit code", "AVJ1 lost\n", 0, unconfirmed],
      ["a record followed by more bytes", "AVJ1 ok 0 0\nAVJ1 ok 0 0\n", 0, unconfirmed],
      ["a garbled record", "AVJ1 ok zero 0\n", 0, unconfirmed],
      ["a record without its line end", "AVJ1 ok 0 0", 0, unconfirmed],
    ] as const)("reads %s", async (_name, record, code, verdict) => {
      const { held, launcher, run } = await start();
      await launcher.end(code, record);
      expect(await run.verdict).toEqual(verdict);
      expect(held.isHeld()).toBe(false);
      expect(helper().kill).toHaveBeenCalledOnce();
    });

    it("carries the launcher's frames to the helper and the helper's replies back", async () => {
      const { launcher } = await start();
      launcher.relay.push("hello");
      helper().channel.push("reply");
      await vi.waitFor(() => {
        expect(helper().channel.written).toBe("hello");
        expect(launcher.relay.written).toBe("reply");
      });
    });

    it("publishes nothing while the launcher runs, whatever it has written and whatever the helper does", async () => {
      const { launcher, run } = await start();
      launcher.report.write("AVJ1 ok 0 0\n");
      expect(await pendingStill(run.verdict)).toBe(true);
      helper().emit("exit", 1, null);
      expect(await pendingStill(run.verdict)).toBe(true);
      // The helper's exit is a stop request to the launcher, never a verdict of its own.
      expect(launcher.stdin.destroyed).toBe(true);
      await launcher.end(0, "");
      expect(await run.verdict).toEqual({ kind: "ok", stopped: false });
    });

    it("answers a launcher that never exits with unconfirmed at the stop deadline and releases the hold", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { held, launcher, run } = await start();
      const stopped = run.stop();
      expect(run.stop()).toBe(stopped);
      expect(launcher.stdin.destroyed).toBe(true);
      await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.windowsHoldStopMs - 1);
      expect(await pendingStill(run.verdict)).toBe(true);
      expect(helper().kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await stopped).toEqual(unconfirmed);
      expect(held.isHeld()).toBe(false);
      expect(helper().kill).toHaveBeenCalledOnce();
      // A record that arrives after the deadline changes nothing.
      await launcher.end(0, "AVJ1 ok 0 0\n");
      expect(await run.verdict).toEqual(unconfirmed);
    });

    it("starts the deadline at the stop request, not at the launcher's exit", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { launcher, run } = await start();
      void run.stop();
      await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.windowsHoldStopMs - 100);
      // Exited without closing its output: the drain allowance would end later than the stop deadline.
      await launcher.end(130, "AVJ1 ok 130 0\n", false);
      await vi.advanceTimersByTimeAsync(100);
      expect(await run.verdict).toEqual(unconfirmed);
    });

    it("reads an exited launcher whose output a survivor keeps open after the drain allowance", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { launcher, run } = await start();
      await launcher.end(7, "AVJ1 ok 7 1\n", false);
      expect(await pendingStill(run.verdict)).toBe(true);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await run.verdict).toEqual({ kind: "ok", stopped: true });
    });

    it("answers a start that produced no process with unconfirmed", async () => {
      const launcher = new FakeLauncher();
      launcher.pid = undefined;
      const { held, run } = await start(launcher);
      launcher.emit("error", new Error("spawn failed"));
      expect(await run.verdict).toEqual(unconfirmed);
      expect(held.isHeld()).toBe(false);
    });

    it("turns an error on a started launcher into a stop request and waits for its record", async () => {
      const { launcher, run } = await start();
      launcher.emit("error", new Error("kill failed"));
      expect(launcher.stdin.destroyed).toBe(true);
      expect(await pendingStill(run.verdict)).toBe(true);
      await launcher.end(130, "AVJ1 ok 130 0\n");
      expect(await run.verdict).toEqual({ kind: "ok", stopped: false });
    });

    it("stops a launcher bound after the helper was lost", async () => {
      const pending = holdWindowsDirectory(root);
      helper().stdout.write(`${row}\n`);
      const held = await pending;
      helper().emit("exit", 1, null);
      const launcher = new FakeLauncher();
      const run = held?.bind(launcher as unknown as ChildProcess);
      expect(launcher.stdin.destroyed).toBe(true);
      await launcher.end(125, "AVJ1 lost\n");
      expect(await run?.verdict).toEqual({ kind: "lost" });
    });

    it("takes one launcher", async () => {
      const { held } = await start();
      expect(() => held.bind(new FakeLauncher() as unknown as ChildProcess)).toThrow();
    });
  });

  describe("native reply limit", () => {
    const fixture = resolve("resources", "windows-path-kind", process.arch, "ave-path-kind-hold-fixture.exe");
    const reply = (limit: number) => new Promise<{ code: number | null; bytes: Buffer }>((done) => {
      const child = spawn(fixture, ["--hold", root], {
        env: { ...process.env, AVE_TEST_HOLD_REPLY_LIMIT: String(limit) }, stdio: ["pipe", "pipe", "ignore", "pipe"], windowsHide: true,
      });
      const chunks: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        if (chunk.includes(0x0a)) child.stdin?.end();
      });
      child.on("close", code => done({ code, bytes: Buffer.concat(chunks) }));
    });

    it("writes exactly the limit on the wire and refuses one byte over it", async () => {
      if (!existsSync(fixture)) throw new Error("Build the hold fixture: bun run build:windows-job -- -Helper path-kind -HoldFixture");
      fake.real = true;
      const full = await reply(MAX_REPLY);
      expect(full.code).toBe(0);
      expect(full.bytes.subarray(-2).toString("hex")).toBe("5d0a");
      expect(full.bytes.includes(0x0d)).toBe(false);
      const atLimit = await reply(full.bytes.length);
      expect(atLimit.code).toBe(0);
      expect(atLimit.bytes.length).toBe(full.bytes.length);
      const over = await reply(full.bytes.length - 1);
      expect(over.code).toBe(3);
      expect(over.bytes.length).toBe(0);
    });
  });
});
