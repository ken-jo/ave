import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
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
  vi.useRealTimers();
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

it("allows a cold host to become ready after the request budget", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { host, children } = fixture();
  let outcome = "pending";
  const result = host.request({ id: 1, paths: [], capSids: [], skipPackage: true, setOwner: false },
    LAUNCH, { timeoutMs: 15_000, maxBytes: LIMITS.maxBytes });
  void result.then(() => { outcome = "resolved"; }, () => { outcome = "rejected"; });
  expect(children[0]!.stdin.readableLength).toBe(0);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(outcome).toBe("pending");
  expect(children[0]!.kill).not.toHaveBeenCalled();
  children[0]!.stdout.write("READY\n");
  expect(children[0]!.stdin.readableLength).toBeGreaterThan(0);
  children[0]!.stdout.write("{}\nEND 1\n");
  await expect(result).resolves.toBe("{}");
});

it("stops a host that never becomes ready at the startup deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { children, request } = fixture();
  const pending = expect(request(1)).rejects.toMatchObject({ name: "WindowsAclHostError", message: "Windows ACL host startup timed out" });
  await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.windowsAclHostStartupMs - 1);
  expect(children[0]!.kill).not.toHaveBeenCalled();
  expect(children[0]!.stdin.readableLength).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(children[0]!.kill).toHaveBeenCalledOnce();
});

it("keeps the request deadline at fifteen seconds after a split READY line", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { host, children } = fixture();
  expect(TOOL_TIMEOUT_POLICY.windowsAclRequestMs).toBe(15_000);
  const pending = expect(host.request({ id: 1, paths: [], capSids: [], skipPackage: true, setOwner: false },
    LAUNCH, { timeoutMs: TOOL_TIMEOUT_POLICY.windowsAclRequestMs, maxBytes: LIMITS.maxBytes }))
    .rejects.toMatchObject({ name: "WindowsAclHostError", message: "Windows ACL host request timed out" });
  children[0]!.stdout.write("REA");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(children[0]!.stdin.readableLength).toBe(0);
  children[0]!.stdout.write("DY\r");
  children[0]!.stdout.write("\n");
  await vi.advanceTimersByTimeAsync(14_999);
  expect(children[0]!.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(children[0]!.kill).toHaveBeenCalledOnce();
});

it.each(["garbage\n", "READY\nextra\n", " READY\n", "READX", "\n"])("refuses invalid handshake bytes %j", async (bytes) => {
  const { children, request } = fixture();
  const pending = expect(request(1)).rejects.toMatchObject({ name: "WindowsAclHostError", message: "Windows ACL host handshake is invalid" });
  children[0]!.stdout.write(bytes);
  await pending;
  expect(children[0]!.kill).toHaveBeenCalledOnce();
  expect(children[0]!.stdin.readableLength).toBe(0);
});

it.each(["stderr", "exit", "error", "stdin error"])("fails closed on %s during startup", async (event) => {
  const { children, request } = fixture();
  const pending = expect(request(1)).rejects.toThrow();
  const child = children[0]!;
  if (event === "stderr") child.stderr.write("failure");
  else if (event === "stdin error") child.stdin.emit("error", new Error("write failed"));
  else if (event === "exit") child.emit("exit", 1, null);
  else child.emit("error", new Error("spawn failed"));
  await pending;
  expect(child.kill).toHaveBeenCalledOnce();
  expect(child.stdin.readableLength).toBe(0);
});

it("replaces a ready host when its launch key changes and handshakes again", async () => {
  const { host, children, request } = fixture();
  const first = request(1);
  children[0]!.stdout.write("READY\n");
  children[0]!.stdout.write("{}\nEND 1\n");
  await first;
  const next = host.request({ id: 2, paths: [], capSids: [], skipPackage: true, setOwner: false },
    { ...LAUNCH, args: ["changed"] }, LIMITS);
  expect(children[0]!.kill).toHaveBeenCalledOnce();
  expect(children[1]!.stdin.readableLength).toBe(0);
  children[1]!.stdout.write("READY\n");
  children[1]!.stdout.write("{}\nEND 2\n");
  await expect(next).resolves.toBe("{}");
});

it("buffers a split UTF-8 reply and split end marker before resolving", async () => {
  const { children, request } = fixture();
  const pending = request(1);
  const stdout = children[0]!.stdout;
  stdout.write("READY\n");
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
  stdout.write("READY\n");
  if (timing === "same chunk") stdout.write("{}\n{}\nEND 1\n");
  else {
    stdout.write("{}\n");
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    stdout.write("{}\nEND 1\n");
  }
  await pending;
  expect(children[0]!.kill).toHaveBeenCalledOnce();
  const next = request(2);
  children[1]!.stdout.write("READY\n");
  children[1]!.stdout.write("{}\nEND 2\n");
  await expect(next).resolves.toBe("{}");
});

it("kills output outside a request and answers the next request on a new host", async () => {
  const { children, request } = fixture();
  const first = request(1);
  children[0]!.stdout.write("READY\n");
  children[0]!.stdout.write("{}\nEND 1\n");
  await first;
  children[0]!.stdout.write("unexpected\n");
  expect(children[0]!.kill).toHaveBeenCalledOnce();
  const next = request(2);
  children[1]!.stdout.write("READY\n");
  children[1]!.stdout.write("{}\nEND 2\n");
  await expect(next).resolves.toBe("{}");
});

it("refuses a busy request without consuming the in-flight reply", async () => {
  const { children, request } = fixture();
  const first = request(1);
  await expect(request(2)).rejects.toThrow("busy");
  expect(children).toHaveLength(1);
  children[0]!.stdout.write("READY\n");
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
  expect(children[1]!.stdin.readableLength).toBe(0);
  children[1]!.stdout.write("READY\n");
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
