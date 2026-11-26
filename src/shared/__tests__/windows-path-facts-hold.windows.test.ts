import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import crypto from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { configureHostResources } from "../../main/host-resources.js";
import { TOOL_TIMEOUT_POLICY } from "../tool-timeout-policy.js";

class FakeHelper extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn(() => true);
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
    const pipe = vi.mocked(spawn).mock.calls[0]?.[1]?.[3];
    expect(pipe).toMatch(/^\\\\\.\\pipe\\ave-hold-[0-9a-f-]{36}$/u);
    expect(held?.launcherArgs).toEqual(["--hold-pipe", pipe, "4242"]);
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

  describe("native reply limit", () => {
    const fixture = resolve("resources", "windows-path-kind", process.arch, "ave-path-kind-hold-fixture.exe");
    const pipeName = () => `\\\\.\\pipe\\ave-hold-${crypto.randomUUID()}`;
    const reply = (limit: number) => new Promise<{ code: number | null; bytes: Buffer }>((done) => {
      const child = spawn(fixture, ["--hold", root, "--pipe", pipeName()], {
        env: { ...process.env, AVE_TEST_HOLD_REPLY_LIMIT: String(limit) }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
      });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        if (chunk.includes(0x0a)) child.stdin.end();
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
