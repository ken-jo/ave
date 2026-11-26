import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync } from "node:fs";
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

  it("accepts a frame of exactly the limit and reports a later helper exit as a lost hold", async () => {
    const frame = padded(MAX_REPLY);
    const pending = holdWindowsDirectory(root);
    helper().stdout.write(frame.subarray(0, MAX_REPLY - 10));
    helper().stdout.write(frame.subarray(MAX_REPLY - 10));
    const held = await pending;
    expect(held?.facts.canonical).toBe((JSON.parse(row) as { canonical: string }[])[0]?.canonical);
    expect(held?.isHeld()).toBe(true);
    const lost = vi.fn();
    held?.onLost(lost);
    helper().emit("exit", 1, null);
    expect(held?.isHeld()).toBe(false);
    expect(lost).toHaveBeenCalledOnce();
    const late = vi.fn();
    held?.onLost(late);
    expect(late).toHaveBeenCalledOnce();
  });

  it("does not report a released hold as lost", async () => {
    const pending = holdWindowsDirectory(root);
    helper().stdout.write(`${row}\n`);
    const held = await pending;
    const lost = vi.fn();
    held?.onLost(lost);
    held?.release();
    helper().emit("exit", 1, null);
    expect(lost).not.toHaveBeenCalled();
    expect(held?.isHeld()).toBe(false);
    expect(helper().kill).toHaveBeenCalled();
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
});
