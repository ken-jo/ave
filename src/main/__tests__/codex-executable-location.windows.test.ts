import { copyFileSync, mkdtempSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import {
  assertCodexExecutableLocation,
  assertCodexLocations,
  _resetDesktopPackageCacheForTest,
  _resetWindowsAclHostForTest,
} from "../codex-executable-location.js";
import {
  WindowsAclHost, WindowsAclHostError, _setWindowsAclTransportForTest,
  type WindowsAclRequest, type WindowsAclHostLaunch,
} from "../windows-acl-host.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

// Mocked access rules answer at the request level. The real case empties the
// seam, so the product's own ACL host runs.
const fakeRequest = vi.fn(async (request: WindowsAclRequest): Promise<string> => {
  const currentSid = "S-1-5-21-100-200-300-1001";
  const paths = request.paths.map((path) => ({
    path, owner: currentSid, daclPresent: true,
    entries: [{ sid: currentSid, mask: 0x1f01ff, flags: 0, type: 0 }],
  }));
  return JSON.stringify({ id: request.id, result: { currentSid, paths, desktopPackage: request.skipPackage
    ? { status: "skipped" } : { status: "unavailable", reason: "mapping-not-found" } } });
});

beforeEach(() => {
  _resetDesktopPackageCacheForTest();
  _resetWindowsAclHostForTest();
  _setWindowsAclTransportForTest({ request: fakeRequest, discard: () => {} });
});

const roots: string[] = [];
const realHosts: WindowsAclHost[] = [];
afterEach(async () => {
  _resetWindowsAclHostForTest();
  for (const host of realHosts.splice(0)) host.discard();
  _setWindowsAclTransportForTest(undefined);
  for (const root of roots.splice(0)) await cleanupTmpDir(root);
});

function realHostFixture() {
  const streams: { stdout: string; stderr: string }[] = [];
  let launch: WindowsAclHostLaunch | undefined;
  const host = new WindowsAclHost((command, args, options) => {
    const child = spawn(command, args, options);
    const output = { stdout: "", stderr: "" };
    streams.push(output);
    child.stdout!.on("data", (chunk: Buffer) => { output.stdout += chunk.toString("utf8"); });
    child.stderr!.on("data", (chunk: Buffer) => { output.stderr += chunk.toString("utf8"); });
    return child;
  });
  realHosts.push(host);
  _setWindowsAclTransportForTest({
    request(request, captured, limits) {
      launch = captured;
      return host.request(request, captured, limits);
    },
    discard: () => host.discard(),
  });
  const request = (id: number, paths: string[], capSids: string[] = []) => host.request(
    { id, paths, capSids, skipPackage: true }, launch!,
    { timeoutMs: TOOL_TIMEOUT_POLICY.windowsAclRequestMs, maxBytes: 256 * 1024 },
  );
  const prime = async () => {
    await assertCodexExecutableLocation(join(process.env.SystemRoot!, "System32", "cmd.exe"), "native",
      { capSidPath: join(tmpdir(), "absent-cap-fixture") });
    // Every real-host scenario starts with a complete response frame, so its
    // later reuse or recovery cannot accidentally rely on early settlement.
    const lines = streams[0]!.stdout.trim().split(/\r?\n/);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(`END ${JSON.parse(lines[0]!).id}`);
  };
  return { host, streams, request, prime, get launch() { return launch!; } };
}

it.runIf(process.platform === "win32")("reuses the real host pid while clearing prior paths and capability values", async () => {
  const { host, request, prime } = realHostFixture();
  await prime();
  const pid = host.pid;
  const fixtureSid = "S-1-5-21-100-200-300-1001";
  const first = JSON.parse(await request(100, [join(process.env.SystemRoot!, "System32", "cmd.exe")], [fixtureSid]));
  const second = JSON.parse(await request(101, []));
  expect(first.result.capSidAccounts.map((entry: { sid: string }) => entry.sid)).toEqual([fixtureSid]);
  expect(first.result.paths).toHaveLength(1);
  expect(second.result.capSidAccounts).toEqual([]);
  expect(second.result.paths).toEqual([]);
  expect(pid).toBeDefined();
  expect(host.pid).toBe(pid);
  expect(host.starts).toBe(1);
  process.stdout.write(`ACL host reuse evidence ${JSON.stringify({ pid, requests: 3, previousValuesAbsent: true })}\n`);
}, 45_000);

it.runIf(process.platform === "win32")("fails closed on a real native exception and answers the next request on a fresh host", async () => {
  const fixture = realHostFixture();
  const { host, streams, request, prime } = fixture;
  await prime();
  const previousPid = host.pid;
  await expect(request(100, [join(tmpdir(), "absent-acl-exception", "missing.exe")])).rejects.toBeInstanceOf(WindowsAclHostError);
  expect(host.pid).toBeUndefined();
  // Error serialization can arrive in several pipe chunks; fail-closed kills
  // the host on its first byte, before the diagnostic body necessarily arrives.
  expect(streams[0]!.stderr.length).toBeGreaterThan(0);
  const next = JSON.parse(await request(101, [join(process.env.SystemRoot!, "System32", "cmd.exe")]));
  expect(next.result.paths).toHaveLength(1);
  expect(host.starts).toBe(2);
  expect(host.pid).not.toBe(previousPid);
  // Observe natural termination too: the transport's stderr kill alone cannot
  // establish that the script stops instead of processing the following line.
  const { command, args, options } = fixture.launch;
  const child = spawn(command, args, options);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const exited = new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Exception host did not exit")); }, TOOL_TIMEOUT_POLICY.windowsAclRequestMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve(code); });
  });
  child.stdin.end([
    { id: 200, paths: [join(tmpdir(), "absent-acl-exception", "missing.exe")], capSids: [], skipPackage: true },
    { id: 201, paths: [], capSids: [], skipPackage: true },
  ].map((value) => JSON.stringify(value)).join("\n") + "\n");
  const exitCode = await exited;
  expect(exitCode).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("MethodInvocationException");
  process.stdout.write(`ACL host exception evidence ${JSON.stringify({ previousPid, nextPid: host.pid, failedClosed: true, naturalExitCode: exitCode, followingRequestAnswered: false })}\n`);
}, 45_000);

it.runIf(process.platform === "win32")("keeps real first-call module streams free of progress and warnings", async () => {
  const { host, streams, prime } = realHostFixture();
  const started = performance.now();
  await prime();
  const output = streams[0]!;
  expect(output.stderr).toBe("");
  const lines = output.stdout.trim().split(/\r?\n/);
  expect(lines).toHaveLength(2);
  const reply = JSON.parse(lines[0]!);
  expect(lines[1]).toBe(`END ${reply.id}`);
  expect(reply.result.paths.length).toBeGreaterThan(0);
  process.stdout.write(`ACL host stream evidence ${JSON.stringify({ pid: host.pid, elapsedMs: Math.round(performance.now() - started), stdoutLines: lines.length, stderrBytes: Buffer.byteLength(output.stderr) })}\n`);
}, 30_000);

// Stock Windows grants Authenticated Users FILE_ADD_SUBDIRECTORY on C:\, so this
// real probe reproduces the original refusal of every route on the system drive.
it.runIf(process.platform === "win32")("admits the real system command executable as a native route with real access rules", async () => {
  _setWindowsAclTransportForTest(undefined);
  await expect(assertCodexExecutableLocation(join(process.env.SystemRoot!, "System32", "cmd.exe"), "native",
    { capSidPath: join(tmpdir(), "absent-cap-fixture") })).resolves.toBeUndefined();
}, 30_000);

it.runIf(process.platform === "win32")("admits the system command executable as a native route with mocked access rules", async () => {
  await expect(assertCodexExecutableLocation(join(process.env.SystemRoot!, "System32", "cmd.exe"), "native",
    { capSidPath: join(tmpdir(), "absent-cap-fixture") })).resolves.toBeUndefined();
});

it.runIf(process.platform === "win32")("admits a temporary native executable with mocked access rules", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-native-route-")));
  roots.push(root);
  const trust = { capSidPath: join(root, "absent-cap-fixture") };
  await assertCodexLocations([{ path: root, kind: "directory", routeKind: "native" }], trust);
  const executable = join(root, "fixture.exe");
  copyFileSync(join(process.env.SystemRoot!, "System32", "cmd.exe"), executable);
  await expect(assertCodexExecutableLocation(executable, "native", trust)).resolves.toBeUndefined();
});
