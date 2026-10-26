import { copyFileSync, mkdtempSync, readdirSync, realpathSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi, type TestContext } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import {
  assertCodexExecutableLocation,
  assertCodexLocations,
  claimPrivateOwnership,
  CodexExecutableLocationError,
  createPrivateDirectories,
  createPrivateDirectory,
  createPrivateTempDirectory,
  _resetDesktopPackageCacheForTest,
  _resetWindowsAclHostForTest,
} from "../codex-executable-location.js";
import {
  WindowsAclHost, WindowsAclHostError, _setWindowsAclTransportForTest,
  type WindowsAclRequest, type WindowsAclHostLaunch,
} from "../windows-acl-host.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { windowsPowerShellEnv } from "../../shared/windows-powershell-env.js";
import { readWindowsDirectoryDacls } from "../../shared/ave-home.js";
import { setFixtureOwner } from "../../__tests__/support/fixture-owner.js";
import { configureHostResources } from "../host-resources.js";

// Mocked access rules answer at the request level. The real case empties the seam, so the product's own ACL host runs.
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
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
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
  // Every reply that went through the product's transport, in order.
  const replies: string[] = [];
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
    async request(request, captured, limits) {
      launch = captured;
      const line = await host.request(request, captured, limits);
      replies.push(line);
      return line;
    },
    discard: () => host.discard(),
  });
  const request = (id: number, paths: string[], capSids: string[] = []) => host.request(
    { id, paths, capSids, skipPackage: true, setOwner: false }, launch!,
    { timeoutMs: TOOL_TIMEOUT_POLICY.windowsAclRequestMs, maxBytes: 256 * 1024 },
  );
  const prime = async () => {
    await assertCodexExecutableLocation(join(process.env.SystemRoot!, "System32", "cmd.exe"), "native",
      { capSidPath: join(tmpdir(), "absent-cap-fixture") });
    // Every real-host scenario starts with a complete response frame, so its later reuse or recovery cannot accidentally rely on early settlement.
    const lines = streams[0]!.stdout.trim().split(/\r?\n/);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(`END ${JSON.parse(lines[0]!).id}`);
  };
  const owners = async (id: number, paths: string[]) => (JSON.parse(await request(id, paths)) as RawReply).result.paths.map(({ owner }) => owner);
  return { host, streams, replies, request, owners, prime, get launch() { return launch!; } };
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
  // Error serialization can arrive in several pipe chunks; fail-closed kills the host on its first byte, before the diagnostic body necessarily arrives.
  expect(streams[0]!.stderr.length).toBeGreaterThan(0);
  const next = JSON.parse(await request(101, [join(process.env.SystemRoot!, "System32", "cmd.exe")]));
  expect(next.result.paths).toHaveLength(1);
  expect(host.starts).toBe(2);
  expect(host.pid).not.toBe(previousPid);
  // Observe natural termination too: the transport's stderr kill alone cannot establish that the script stops instead of processing the following line.
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

// Stock Windows grants Authenticated Users FILE_ADD_SUBDIRECTORY on C:\, so this real probe reproduces the original refusal of every route on the system drive.
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
  roots.push(root); setFixtureOwner(root);
  const trust = { capSidPath: join(root, "absent-cap-fixture") };
  await assertCodexLocations([{ path: root, kind: "directory", routeKind: "native" }], trust);
  const executable = join(root, "fixture.exe");
  copyFileSync(join(process.env.SystemRoot!, "System32", "cmd.exe"), executable); setFixtureOwner(executable);
  await expect(assertCodexExecutableLocation(executable, "native", trust)).resolves.toBeUndefined();
});

interface RawReply { result: { currentSid: string; machineDomainSid: string | null; paths: { path: string; owner: string }[] } }

it.runIf(process.platform === "win32")("claims created directories and files for the current account through the resident host", async () => {
  const { host, request, prime } = realHostFixture();
  await prime();
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "ave-owner-claim-")));
  roots.push(parent); setFixtureOwner(parent);
  // Keep fixture ownership independent of the token default owner.
  const unclaimed = realpathSync(mkdtempSync(join(parent, "unclaimed-"))); setFixtureOwner(unclaimed);
  const directory = await createPrivateTempDirectory(join(parent, "claimed-"));
  const file = join(directory, "copy.bin");
  writeFileSync(file, "private"); setFixtureOwner(file);
  await claimPrivateOwnership([file]);
  const reply = JSON.parse(await request(300, [unclaimed, directory, file])) as RawReply;
  const [defaultOwner, directoryOwner, fileOwner] = reply.result.paths.map(({ owner }) => owner);
  expect(directoryOwner).toBe(reply.result.currentSid);
  expect(fileOwner).toBe(reply.result.currentSid);
  // Claims are request lines to the same resident host, not new processes.
  expect(host.starts).toBe(1);
  process.stdout.write(`ACL host owner claim evidence ${JSON.stringify({ defaultOwner, account: reply.result.currentSid, claimed: [directoryOwner, fileOwner], starts: host.starts })}\n`);
}, 45_000);

// Set an owner this process may not take for itself; icacls enables the restore privilege an elevated token holds.
function setOwner(path: string, sid: string): void {
  execFileSync(join(process.env.SystemRoot!, "System32", "icacls.exe"), [path, "/setowner", `*${sid}`, "/q"],
    { windowsHide: true, stdio: "pipe" });
}

function requireRestorePrivilege(context: TestContext): void {
  const privileges = execFileSync(join(process.env.SystemRoot!, "System32", "whoami.exe"), ["/priv"], { encoding: "utf8", windowsHide: true });
  if (!/\bSeRestorePrivilege\b/.test(privileges)) context.skip("SeRestorePrivilege is absent; this token cannot create a foreign-owned fixture");
}

interface ClaimReply { result: { currentSid: string; claims: { path: string; previousOwner: string; outcome: string }[] } }

it.runIf(process.platform === "win32")("replaces inherited foreign access when claiming a private runtime directory", async (context) => {
  requireRestorePrivilege(context);
  const fixture = realHostFixture();
  await fixture.prime();
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "ave-owner-access-")));
  roots.push(parent); setFixtureOwner(parent);
  const [parentDacl] = readWindowsDirectoryDacls([parent]);
  execFileSync(join(process.env.SystemRoot!, "System32", "icacls.exe"),
    [parent, "/inheritance:r", "/grant:r", `*${parentDacl.currentUserSid}:(OI)(CI)F`, "/q"], { windowsHide: true, stdio: "pipe" });
  expect(readWindowsDirectoryDacls([parent])[0]).toMatchObject({ protected: true });
  execFileSync(join(process.env.SystemRoot!, "System32", "icacls.exe"),
    [parent, "/grant", "*S-1-5-32-545:(OI)(CI)RX", "/q"], { windowsHide: true, stdio: "pipe" });
  const directory = realpathSync(mkdtempSync(join(parent, "runtime-"))); setFixtureOwner(directory);
  const [before] = readWindowsDirectoryDacls([directory]);
  expect(before.rules).toContainEqual(expect.objectContaining({ sid: "S-1-5-32-545", isInherited: true }));
  if (!before.elevated) context.skip("An elevated token is required to create the Administrators-owned private directory fixture");
  setOwner(directory, "S-1-5-32-544");
  expect(readWindowsDirectoryDacls([directory])[0].ownerSid).toBe("S-1-5-32-544");
  await claimPrivateOwnership([directory]);
  const [after] = readWindowsDirectoryDacls([directory]);
  expect(after.ownerSid).toBe(after.currentUserSid);
  expect(after.protected).toBe(true);
  expect(after.rules).toEqual([expect.objectContaining({
    sid: after.currentUserSid, accessControlType: 0, fileSystemRights: 2032127,
    inheritanceFlags: 3, propagationFlags: 0, isInherited: false,
  })]);
}, 45_000);

it.runIf(process.platform === "win32")("admits a private runtime directory claimed from Administrators", async (context) => {
  if (!readWindowsDirectoryDacls([tmpdir()])[0].elevated) context.skip("An elevated token is required to create the Administrators-owned private directory fixture");
  const fixture = realHostFixture();
  await fixture.prime();
  const base = tmpdir();
  const parent = realpathSync(mkdtempSync(join(base, "ave-owner-admit-")));
  roots.push(parent); setFixtureOwner(parent);
  const trust = { capSidPath: join(parent, "absent-cap-fixture") };
  const refusal = await assertCodexLocations([{ path: parent, kind: "directory", routeKind: "native" }], trust)
    .then(() => "", (error: unknown) => String(error));
  if (refusal.includes("untrusted owner")) {
    const chain: string[] = [];
    for (let path = parent; dirname(path) !== path; path = dirname(path)) chain.push(path);
    const owners = readWindowsDirectoryDacls(chain).map(({ path, ownerSid }) => `${path}=${ownerSid}`);
    context.skip(`An ancestor of ${base} is not admissible: ${owners.join(", ")}`);
  }
  const directory = realpathSync(mkdtempSync(join(parent, "runtime-"))); setFixtureOwner(directory);
  setOwner(directory, "S-1-5-32-544");
  await claimPrivateOwnership([directory]);
  await expect(assertCodexLocations([{ path: directory, kind: "private-directory", routeKind: "native" }], trust)).resolves.toBeUndefined();
}, 45_000);

it.runIf(process.platform === "win32")("keeps a directory the account already owns without asking for WRITE_OWNER", async () => {
  const fixture = realHostFixture();
  await fixture.prime();
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "ave-owner-kept-")));
  roots.push(parent); setFixtureOwner(parent);
  const directory = await createPrivateDirectory(join(parent, "owned"));
  // The account owns it and holds Modify only: neither TakeOwnership nor ChangePermissions.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl = [System.Security.AccessControl.DirectorySecurity]::new()",
    "$acl.SetAccessRuleProtection($true, $false)",
    "$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))",
    "[System.IO.Directory]::SetAccessControl($env:AVE_OWNED_DIRECTORY, $acl)",
  ].join("; ");
  execFileSync(join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, stdio: "pipe", env: windowsPowerShellEnv({ ...process.env, AVE_OWNED_DIRECTORY: directory }) });
  // Opening it for WRITE_OWNER would be denied, so the claim succeeds only by keeping the owner.
  await claimPrivateOwnership([directory]);
  const reply = JSON.parse(fixture.replies.at(-1)!) as ClaimReply;
  expect(reply.result.claims).toEqual([{ path: directory, previousOwner: reply.result.currentSid, outcome: "kept" }]);
}, 45_000);

it.runIf(process.platform === "win32")("refuses a directory another account owns and changes nothing in its batch", async (context) => {
  requireRestorePrivilege(context);
  const fixture = realHostFixture();
  await fixture.prime();
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "ave-owner-foreign-")));
  roots.push(parent); setFixtureOwner(parent);
  const administrators = realpathSync(mkdtempSync(join(parent, "administrators-"))); setFixtureOwner(administrators);
  setOwner(administrators, "S-1-5-32-544");
  const foreign = realpathSync(mkdtempSync(join(parent, "foreign-"))); setFixtureOwner(foreign);
  setOwner(foreign, "S-1-5-18");
  const refusal = await claimPrivateOwnership([administrators, foreign]).then(() => null, (error: unknown) => error);
  expect(refusal).toBeInstanceOf(CodexExecutableLocationError);
  expect((refusal as Error).message).toMatch(/owned by another account.*owner S-1-5-18/);
  const reply = JSON.parse(fixture.replies.at(-1)!) as ClaimReply;
  expect(reply.result.claims.map(({ outcome }) => outcome)).toEqual(["unclaimed", "refused"]);
  expect(await fixture.owners(320, [administrators, foreign])).toEqual(["S-1-5-32-544", "S-1-5-18"]);
}, 45_000);

it.runIf(process.platform === "win32")("claims a junction itself and leaves its target alone", async (context) => {
  requireRestorePrivilege(context);
  const fixture = realHostFixture();
  await fixture.prime();
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "ave-owner-junction-")));
  roots.push(parent); setFixtureOwner(parent);
  const target = realpathSync(mkdtempSync(join(parent, "target-"))); setFixtureOwner(target);
  setOwner(target, "S-1-5-18");
  const link = join(parent, "link");
  symlinkSync(target, link, "junction"); setFixtureOwner(link);
  try {
    // A followed link would read the target's owner and refuse.
    await claimPrivateOwnership([link]);
    const reply = JSON.parse(fixture.replies.at(-1)!) as ClaimReply;
    expect(await fixture.owners(330, [link, target])).toEqual([reply.result.currentSid, "S-1-5-18"]);
  } finally {
    // Remove the link alone; a recursive removal would follow it.
    rmdirSync(link);
  }
}, 45_000);

it.runIf(process.platform === "win32")("refuses a claim the real host cannot apply", async () => {
  const { prime } = realHostFixture();
  await prime();
  const missing = join(tmpdir(), "ave-owner-claim-absent", "missing");
  await expect(claimPrivateOwnership([missing])).rejects.toBeInstanceOf(WindowsAclHostError);
}, 45_000);

it.runIf(process.platform === "win32")("answers from its own imports when no module directory is searchable", async () => {
  const empty = realpathSync(mkdtempSync(join(tmpdir(), "ave-empty-module-path-")));
  roots.push(empty); setFixtureOwner(empty);
  const replies: string[] = [];
  const host = new WindowsAclHost((command, args, options) =>
    spawn(command, args, { ...options, env: { ...options.env, PSModulePath: empty } }));
  realHosts.push(host);
  _setWindowsAclTransportForTest({
    async request(request, launch, limits) {
      const line = await host.request(request, launch, limits);
      replies.push(line);
      return line;
    },
    discard: () => host.discard(),
  });
  // The full lookup: paths, local account domain, sandbox group and package.
  await expect(assertCodexExecutableLocation(join(process.env.SystemRoot!, "System32", "cmd.exe"), "native",
    { capSidPath: join(tmpdir(), "absent-cap-fixture") })).resolves.toBeUndefined();
  const reply = JSON.parse(replies[0]!) as RawReply;
  expect(reply.result.machineDomainSid).toMatch(/^S-1-5-21-\d+-\d+-\d+$/);
}, 45_000);

it.runIf(process.platform === "win32")("falls back to the directory service when LocalAccounts cannot be imported", async () => {
  const fixture = realHostFixture();
  await fixture.prime();
  // The launch is captured by the first request, so read it only after prime.
  const { request, launch } = fixture;
  const expected = (JSON.parse(await request(400, [])) as RawReply).result.machineDomainSid;
  const script = Buffer.from(launch.args[4]!, "base64").toString("utf16le");
  const absent = script.replaceAll(String.raw`Microsoft.PowerShell.LocalAccounts\Microsoft.PowerShell.LocalAccounts.psd1`,
    String.raw`Microsoft.PowerShell.LocalAccounts\Absent.psd1`);
  expect(absent).not.toBe(script);
  const host = new WindowsAclHost((command, args, options) => spawn(command, args, options));
  realHosts.push(host);
  const reply = JSON.parse(await host.request({ id: 401, paths: [], capSids: [], skipPackage: true, setOwner: false },
    { ...launch, args: [...launch.args.slice(0, 4), Buffer.from(absent, "utf16le").toString("base64")] },
    { timeoutMs: TOOL_TIMEOUT_POLICY.windowsAclRequestMs, maxBytes: 256 * 1024 })) as RawReply;
  expect(expected).toMatch(/^S-1-5-21-\d+-\d+-\d+$/);
  expect(reply.result.machineDomainSid).toBe(expected);
}, 45_000);

it.runIf(process.platform === "win32").each([
  ["a failed claim", () => { throw new WindowsAclHostError("Windows ACL host exited (1)"); }, WindowsAclHostError],
  ["a claim read back with another owner", (request: WindowsAclRequest) => JSON.stringify({ id: request.id, result: {
    currentSid: "S-1-5-21-100-200-300-1001", desktopPackage: { status: "skipped" },
    paths: request.paths.map((path) => ({ path, owner: "S-1-5-32-544", daclPresent: true, entries: [] })),
    claims: request.paths.map((path) => ({ path, previousOwner: "S-1-5-32-544", outcome: "set" })) } }), CodexExecutableLocationError],
  ["a claim refused for another owner", (request: WindowsAclRequest) => JSON.stringify({ id: request.id, result: {
    currentSid: "S-1-5-21-100-200-300-1001", desktopPackage: { status: "skipped" },
    paths: request.paths.map((path) => ({ path, owner: "S-1-5-18", daclPresent: true, entries: [] })),
    claims: request.paths.map((path) => ({ path, previousOwner: "S-1-5-18", outcome: "refused" })) } }), CodexExecutableLocationError],
  ["a claim reply without its outcomes", (request: WindowsAclRequest) => JSON.stringify({ id: request.id, result: {
    currentSid: "S-1-5-21-100-200-300-1001", desktopPackage: { status: "skipped" },
    paths: request.paths.map((path) => ({ path, owner: "S-1-5-21-100-200-300-1001", daclPresent: true, entries: [] })) } }),
  CodexExecutableLocationError],
] as const)("removes a directory it created after %s", async (_label, answer, refusal) => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "ave-owner-refusal-")));
  roots.push(parent); setFixtureOwner(parent);
  const requests: WindowsAclRequest[] = [];
  _setWindowsAclTransportForTest({
    async request(request) { requests.push(request); return answer(request); },
    discard: () => {},
  });
  await expect(createPrivateTempDirectory(join(parent, "claimed-"))).rejects.toBeInstanceOf(refusal);
  // A nested set is claimed once and removed whole.
  const nested = join(parent, "set");
  await expect(createPrivateDirectories([nested, join(nested, "inner")])).rejects.toBeInstanceOf(refusal);
  expect(requests.map(({ setOwner, paths }) => ({ setOwner, count: paths.length })))
    .toEqual([{ setOwner: true, count: 1 }, { setOwner: true, count: 2 }]);
  expect(readdirSync(parent)).toEqual([]);
});
