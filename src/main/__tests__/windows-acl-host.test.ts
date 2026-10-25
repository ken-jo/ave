import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import {
  WindowsAclHost,
  _setWindowsAclTransportForTest,
  windowsAclTransportSeam,
  type WindowsAclHostLaunch,
} from "../windows-acl-host.js";

const LAUNCH: WindowsAclHostLaunch = { command: "fixture", args: [], options: { windowsHide: true, env: {} } };
const LIMITS = { timeoutMs: 1_000, maxBytes: 1_024 };
const hosts: WindowsAclHost[] = [];

afterEach(() => {
  for (const host of hosts.splice(0)) host.discard();
  _setWindowsAclTransportForTest(undefined);
  vi.unstubAllEnvs();
});

function fixture() {
  const children: ReturnType<typeof childFixture>[] = [];
  const host = new WindowsAclHost(() => {
    const child = childFixture();
    children.push(child);
    return child as unknown as ChildProcess;
  });
  hosts.push(host);
  const request = (id: number) => host.request({ id, paths: [], capSids: [], skipPackage: false, setOwner: false }, LAUNCH, LIMITS);
  return { host, children, request };
}

function childFixture() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    unref: vi.fn(), kill: vi.fn(() => true),
  });
}

it("buffers a split UTF-8 reply and split end marker before resolving", async () => {
  const { children, request } = fixture();
  const pending = request(1);
  const stdout = children[0]!.stdout;
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const reply = Buffer.from('{"path":"한글"}');
  stdout.write(reply.subarray(0, 10));
  stdout.write(reply.subarray(10));
  stdout.write("\r\n");
  await Promise.resolve();
  expect(settled).toBe(false);
  stdout.write("EN");
  stdout.write("D 1\r\n");
  await expect(pending).resolves.toBe(reply.toString("utf8"));
});

it.each(["same chunk", "next chunk"])("refuses an extra reply in the %s and restarts", async (timing) => {
  const { children, request } = fixture();
  const pending = expect(request(1)).rejects.toThrow("more than one reply");
  // Keep an early assertion failure handled while the next pipe turn runs.
  void pending.catch(() => {});
  const stdout = children[0]!.stdout;
  if (timing === "same chunk") stdout.write("{}\n{}\nEND 1\n");
  else {
    stdout.write("{}\n");
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    stdout.write("{}\nEND 1\n");
  }
  await pending;
  expect(children[0]!.kill).toHaveBeenCalledOnce();
  const next = request(2);
  children[1]!.stdout.write("{}\nEND 2\n");
  await expect(next).resolves.toBe("{}");
});

it("kills output outside a request and answers the next request on a new host", async () => {
  const { children, request } = fixture();
  const first = request(1);
  children[0]!.stdout.write("{}\nEND 1\n");
  await first;
  children[0]!.stdout.write("unexpected\n");
  expect(children[0]!.kill).toHaveBeenCalledOnce();
  const next = request(2);
  children[1]!.stdout.write("{}\nEND 2\n");
  await expect(next).resolves.toBe("{}");
});

it("refuses a busy request without consuming the in-flight reply", async () => {
  const { children, request } = fixture();
  const first = request(1);
  await expect(request(2)).rejects.toThrow("busy");
  expect(children).toHaveLength(1);
  children[0]!.stdout.write("{}\nEND 1\n");
  await expect(first).resolves.toBe("{}");
  expect(children[0]!.kill).not.toHaveBeenCalled();
});

it("ignores late stdout, stderr, exit and error events from a discarded host", async () => {
  const { children, host, request } = fixture();
  const first = expect(request(1)).rejects.toThrow("stopped");
  host.discard();
  await first;
  const next = request(2);
  const old = children[0]!;
  old.stdout.write("late\n");
  old.stderr.write("late");
  old.emit("exit", 1, null);
  old.emit("error", new Error("late"));
  old.stdin.emit("error", new Error("late write"));
  expect(children[1]!.kill).not.toHaveBeenCalled();
  children[1]!.stdout.write("{}\nEND 2\n");
  await expect(next).resolves.toBe("{}");
});

it("allows only the guarded test setter to replace the transport", () => {
  const transport = { request: vi.fn(), discard: vi.fn() };
  _setWindowsAclTransportForTest(transport);
  expect(windowsAclTransportSeam.override).toBe(transport);
  expect(Object.isFrozen(windowsAclTransportSeam)).toBe(true);
  vi.stubEnv("NODE_ENV", "production");
  expect(() => _setWindowsAclTransportForTest(undefined)).toThrow("test-only");
  expect(windowsAclTransportSeam.override).toBe(transport);
  vi.unstubAllEnvs();
});
