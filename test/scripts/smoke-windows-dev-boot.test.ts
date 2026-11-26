import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { checkDevBoot, createDevBootDirectories } from "../../scripts/smoke-windows-dev-boot.mjs";

const INSPECTOR_URL = "ws://127.0.0.1:49152/01234567-89ab-cdef-0123-456789abcdef";
const READY = JSON.stringify({ msg: "main interface loaded", reason: "bootstrap-complete" });

function fixture(bootTimeoutMs = 5_000, quitTimeoutMs = 5_000) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const requestQuit = vi.fn(async (_url: string, _signal: AbortSignal) => {});
  const onLine = vi.fn();
  const onRawLine = vi.fn();
  const result = checkDevBoot(child, requestQuit, { bootTimeoutMs, quitTimeoutMs, onLine, onRawLine });
  return {
    child, requestQuit, onLine, onRawLine, result,
    mxcSummaries() {
      return onLine.mock.calls.map(([line]) => line).filter((line) => line.startsWith("mxc-runtime-root:"));
    },
    ready() {
      child.stderr.write(`Debugger listening on ${INSPECTOR_URL}\r\n`);
      child.stdout.write(`${READY}\r\n`);
    },
    exit(code: number) {
      child.emit("exit", code, null);
      child.emit("close", code, null);
    },
  };
}

afterEach(() => vi.useRealTimers());

it("places the profile and Ave home under the isolated job temp", () => {
  const runnerTemp = mkdtempSync(join(tmpdir(), "ave-boot-placement-"));
  try {
    const jobRoot = join(runnerTemp, "job");
    const jobTemp = join(jobRoot, "tmp");
    mkdirSync(jobTemp, { recursive: true });
    vi.stubEnv("RUNNER_TEMP", runnerTemp);
    const { root, home, profile } = createDevBootDirectories(jobRoot);
    expect(dirname(root)).toBe(jobTemp);
    expect(home).toBe(join(root, "home"));
    expect(profile).toBe(join(root, "profile"));
    expect(() => createDevBootDirectories("relative")).toThrow("isolated Windows CI job");
  } finally {
    vi.unstubAllEnvs();
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

it("requires the complete interface log and a per-launch loopback inspector before quitting", async () => {
  const { child, requestQuit, onLine, result, exit } = fixture();
  child.stdout.write(`noise ${READY}\r\n${JSON.stringify({ msg: "main interface loaded", reason: "renderer-reload" })}\r\n`);
  child.stderr.write(`Debugger listening on ${INSPECTOR_URL.replace("49152", "9222")}\r\n`);
  child.stderr.write(`Debugger listening on ${INSPECTOR_URL.replace("127.0.0.1", "0.0.0.0")}\r\n`);
  await Promise.resolve();
  expect(requestQuit).not.toHaveBeenCalled();

  child.stdout.write(READY.slice(0, 14));
  child.stdout.write(`${READY.slice(14)}\r\n`);
  await new Promise(setImmediate);
  expect(requestQuit).not.toHaveBeenCalled();
  child.stderr.write(`Debugger listening on ${INSPECTOR_URL}\r\n`);
  await vi.waitFor(() => expect(requestQuit).toHaveBeenCalledExactlyOnceWith(INSPECTOR_URL, expect.any(AbortSignal)));
  expect(onLine).not.toHaveBeenCalledWith(`Debugger listening on ${INSPECTOR_URL}`);
  exit(0);
  await expect(result).resolves.toBeUndefined();
});

it("reports the MXC startup check even when the shell probe has not finished", async () => {
  const { child, ready, requestQuit, result, exit, mxcSummaries } = fixture();
  child.stdout.write(`${JSON.stringify({ mxcState: "available", msg: "boot: MXC runtime root proved" })}\n`);
  ready();
  await vi.waitFor(() => expect(requestQuit).toHaveBeenCalledOnce());
  exit(0);
  await expect(result).resolves.toBeUndefined();
  expect(mxcSummaries()).toEqual(["mxc-runtime-root: available"]);
});

it.each([
  ["runtime-root-unproved", "Container runtime root cannot be used:\r\nit resolves to another path"],
  ["container-unavailable", "no container API"],
])("reports an MXC refusal (%s) without failing the smoke", async (mxcReason, mxcDetail) => {
  const { child, ready, requestQuit, result, exit, mxcSummaries } = fixture();
  ready();
  await vi.waitFor(() => expect(requestQuit).toHaveBeenCalledOnce());
  child.stderr.write(`${JSON.stringify({ mxcState: "unavailable", mxcReason, mxcDetail })}\n`);
  exit(0);
  await expect(result).resolves.toBeUndefined();
  expect(mxcSummaries()).toEqual([`mxc-runtime-root: unavailable (${mxcReason})`]);
});

it("reports a late MXC refusal in place of a successful startup check", async () => {
  const { child, ready, requestQuit, result, exit, mxcSummaries } = fixture();
  child.stdout.write('{"mxcState":"available"}\n');
  ready();
  await vi.waitFor(() => expect(requestQuit).toHaveBeenCalledOnce());
  child.stdout.write('{"mxcState":"unavailable","mxcReason":"powershell-start-failed","mxcDetail":"shell did not start"}\n');
  exit(0);
  await expect(result).resolves.toBeUndefined();
  expect(mxcSummaries()).toEqual(["mxc-runtime-root: unavailable (powershell-start-failed)"]);
});

it("keeps diagnostics from both app streams in the isolated local log", async () => {
  const { child, onLine, onRawLine, ready, requestQuit, result, exit } = fixture();
  const path = "C:\\Users\\alice\\.ave";
  const secret = "fixture-secret-sentinel";
  const detail = [path, secret].join(" ");
  const diagnostic = JSON.stringify({
    msg: detail, mxcState: "unavailable", mxcReason: "runtime-root-unproved", mxcDetail: detail,
  });
  const spoofedReason = JSON.stringify({ mxcState: "unavailable", mxcReason: secret, mxcDetail: detail });
  for (const stream of [child.stdout, child.stderr]) {
    stream.write([diagnostic, detail, spoofedReason, ""].join("\n"));
  }
  ready();
  await vi.waitFor(() => expect(requestQuit).toHaveBeenCalledOnce());
  exit(0);
  await expect(result).resolves.toBeUndefined();
  for (const stream of ["stdout", "stderr"]) {
    expect(onRawLine).toHaveBeenCalledWith(stream, diagnostic);
    expect(onRawLine).toHaveBeenCalledWith(stream, detail);
    expect(onRawLine).toHaveBeenCalledWith(stream, spoofedReason);
  }
  expect(onLine.mock.calls).toEqual([
    ["main interface loaded (bootstrap-complete)"],
    ["mxc-runtime-root: unavailable (runtime-root-unproved)"],
  ]);
});

it("sanitizes app failure messages and rejects the boot", async () => {
  const { child, onLine, result } = fixture();
  const msg = "before-quit: shutdown cleanup failed: C:\\Users\\alice\\.ave fixture-secret-sentinel";
  child.stderr.write(JSON.stringify({ msg }) + "\n");
  await expect(result).rejects.toThrow(/^before-quit: shutdown cleanup failed$/u);
  expect(onLine.mock.calls).toEqual([
    ["before-quit: shutdown cleanup failed"],
    ["mxc-runtime-root: unknown (no boot status reported)"],
  ]);
});

it("reports a missing MXC status when boot fails before any valid status record", async () => {
  const { child, result, mxcSummaries } = fixture();
  child.stdout.write('noise {"mxcState":"available"}\n{"mxcState":"unavailable"}\n{"msg":"bootstrap failed"}\n');
  await expect(result).rejects.toThrow("bootstrap failed");
  expect(mxcSummaries()).toEqual(["mxc-runtime-root: unknown (no boot status reported)"]);
});

it("fails on bootstrap failure even if the app stays open", async () => {
  const { child, requestQuit, result } = fixture();
  child.stdout.write('{"msg":"bootstrap failed","err":{"message":"host-resources-unavailable"}}\n');
  await expect(result).rejects.toThrow("bootstrap failed");
  expect(requestQuit).not.toHaveBeenCalled();
});

it.each([0, 19])("fails when the app exits early with code %i", async (code) => {
  const { requestQuit, result, exit } = fixture();
  exit(code);
  await expect(result).rejects.toThrow(`exited before quit (code ${code})`);
  expect(requestQuit).not.toHaveBeenCalled();
});

it("bounds boot when the readiness log never appears", async () => {
  vi.useFakeTimers();
  const { requestQuit, result } = fixture(100);
  const rejection = expect(result).rejects.toThrow("Timed out waiting for development desktop boot");
  await vi.advanceTimersByTimeAsync(100);
  await rejection;
  expect(requestQuit).not.toHaveBeenCalled();
});

it("bounds quit even after the inspector acknowledges it", async () => {
  vi.useFakeTimers();
  const { ready, requestQuit, result } = fixture(100, 200);
  const rejection = expect(result).rejects.toThrow("Timed out waiting for development desktop to quit");
  ready();
  await vi.advanceTimersByTimeAsync(200);
  await rejection;
  expect(requestQuit.mock.calls[0]?.[1].aborted).toBe(true);
});

it("rejects a nonzero exit after requesting quit", async () => {
  const { ready, requestQuit, result, exit } = fixture();
  ready();
  await vi.waitFor(() => expect(requestQuit).toHaveBeenCalledOnce());
  exit(23);
  await expect(result).rejects.toThrow("quit with code 23");
});

it("rejects a shutdown failure even if the process exits with code zero", async () => {
  const { child, ready, requestQuit, result, exit } = fixture();
  ready();
  await vi.waitFor(() => expect(requestQuit).toHaveBeenCalledOnce());
  child.stdout.write('{"msg":"shutdown cleanup timed out"}\n');
  exit(0);
  await expect(result).rejects.toThrow("shutdown cleanup timed out");
});
