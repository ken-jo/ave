import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer, type Server } from "node:net";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildNativeShellSupervisor } from "../../__tests__/support/mxc-shell-supervisor-native.js";
import { configureHostResources } from "../../main/host-resources.js";
import { __resetManagedChildProcessesForTest, forceKillAndDrainManagedChildProcesses, forceKillManagedChildProcesses,
  trackManagedChildProcess } from "../../main/managed-child-processes.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { createContainedShellLifecycle } from "../../tools/contained-shell-lifecycle.js";
import { prepareMxcPosixShellLaunch } from "../../tools/mxc-posix-shell-launch.js";
import { quoteSandboxWrappedWord as quote } from "../sandbox-wrapped-command.js";
import { t } from "../../i18n/index.js";
import { reserveTailnetListenerPort } from "../../shared/tailnet-listener-port.js";
import { BashTool } from "../../tools/shell-tools.js";
import { liveEgressInvocationCount, openEgressInvocation } from "../egress-invocations.js";
import { startEgressRelayService, stopEgressRelayService, type EgressRelayServiceOptions } from "../egress-relay/relay.js";
import { currentMxcRuntimeHost, establishMxcRuntimeRoot, _forgetMxcRuntimeRootForTest } from "../mxc-runtime-root.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, setActiveSandboxCapability,
  setContainerShellSubstrate, setShellSandboxRequestedAtBoot } from "../sandbox-capability.js";
import pins from "../mxc-launcher-pins.json" with { type: "json" };
import { _runSeatbeltCanaryForTest, buildSeatbeltShellRequest, detectHostMxcMacShellSupport } from "../mxc-macos.js";
import { rawIpProbeShellLines } from "../mxc-macos-raw-ip.js";
import { posixPolicyLookups } from "../mxc-posix.js";
import { _mxcShellStandbyPidForTest, dropMxcShellStandbys, mxcShellSupervisorLocation, stageMxcShellRequest, startMxcShellSupervisor } from "../mxc-shell-supervisor-client.js";
import { buildPolicyModel, policyFloorRow, policyGrantRow, type PolicyModel } from "../policy-model.js";

const NATIVE = process.platform === "darwin" && process.arch === "arm64";
// Darwin 25 is macOS 26. Its libsandbox compiles a carved profile deeply enough to overrun koffi's default 128 KiB
// asynchronous stack; macOS 15 (Darwin 24) starts the same profiles on it (macos-15 CI runner, 2026-11-27).
const DEFAULT_STACK_OVERRUNS = NATIVE && Number(release().split(".")[0]) >= 25;
// One CLI start of the thirty-grant profile takes about 10 s on an M-series Mac and more than 12 s on the macos-15
// runner, almost all of it libsandbox compiling the profile. The bound leaves room for the slower runner.
const LAUNCHER_START_TIMEOUT_MS = 60_000;
// The macOS permission job requires its cases: a macOS runner this suite cannot use fails here instead of skipping all of them.
if (process.platform === "darwin" && !NATIVE && process.env.AVE_REQUIRE_SANDBOX_CASES === "1") {
  throw new Error(`AVE_REQUIRE_SANDBOX_CASES=1 but this macOS host is ${process.arch}: the container boundary suite runs only on arm64`);
}
let supervisor: Awaited<ReturnType<typeof buildNativeShellSupervisor>>;

if (NATIVE) {
  beforeAll(async () => { supervisor = await buildNativeShellSupervisor(); });
  afterAll(() => supervisor.dispose());
}

// Five process kinds the backend must reap: the shell, a background child, a separate-session writer that keeps the
// inherited stdout open, a double-fork daemon reparented to launchd, and a nohup loop. Each records its pid and ticks.
const DETACH_KINDS = ["shell", "child", "setsid", "daemon", "nohup"] as const;
const DETACH_WORKLOAD = [
  "echo $$ > shell.pid",
  "/bin/sleep 47 & echo $! > child.pid",
  `/usr/bin/perl -MPOSIX -e 'POSIX::setsid(); open(F,">setsid.pid"); print F $$; close F; $|=1; while(1){ open(T,">>tick-setsid"); print T "t\\n"; close T; print "tick\\n"; select(undef,undef,undef,0.1);}' &`,
  `/usr/bin/perl -MPOSIX -e 'exit if fork; POSIX::setsid(); exit if fork; open(F,">daemon.pid"); print F $$; close F; while(1){ open(T,">>tick-daemon"); print T "t\\n"; close T; select(undef,undef,undef,0.1);}'`,
  "/usr/bin/nohup /bin/sh -c 'echo $$ > nohup.pid; while :; do echo t >> tick-nohup; /bin/sleep 0.1; done' >/dev/null 2>&1 &",
  "/bin/sleep 47",
].join("\n");
const DETACH_TICKS = ["tick-setsid", "tick-daemon", "tick-nohup"];
// A respawner that forks, leaves and starts a new session every 5 ms.
const RESPAWN_WORKLOAD = [
  "echo $$ > shell.pid",
  `/usr/bin/perl -MPOSIX -e 'while(1){ my $p=fork; if($p){ exit; } POSIX::setsid(); open(F,">hop.pid"); print F $$; close F; open(T,">>tick-hop"); print T "t\\n"; close T; select(undef,undef,undef,0.005);}' &`,
  "/bin/sleep 47",
].join("\n");

/** The pids among `pids` that `ps` lists as running. */
function livePids(pids: readonly number[]): number[] {
  const listed = spawnSync("/bin/ps", ["-o", "pid=", "-p", pids.join(",")], { encoding: "utf8" });
  return listed.stdout.split("\n").map(line => Number(line.trim())).filter(pid => pids.includes(pid));
}

// A shell start takes about 1.4 s through BashTool on an M-series Mac and about 5 s on the macos-15 runner, which
// missed a 5 s wait once (2026-11-28). The wait only bounds how long a start may take; what it then checks is unchanged.
const PID_FILE_WAIT_MS = 20_000;

/** Waits for every `<name>.pid` in `dir`, filling `pids` as each appears so a caller can reap a partial start. */
async function recordedPids<Name extends string>(
  dir: string, names: readonly Name[], pids = {} as Record<Name, number>,
): Promise<Record<Name, number>> {
  await vi.waitFor(() => {
    for (const name of names) {
      const file = join(dir, `${name}.pid`);
      const pid = existsSync(file) ? Number(readFileSync(file, "utf8").trim()) : NaN;
      expect(pid, name).toBeGreaterThan(1);
      pids[name] = pid;
    }
  }, { interval: 20, timeout: PID_FILE_WAIT_MS });
  return pids;
}

function tickSizes(dir: string, ticks: readonly string[]): number[] {
  return ticks.map(name => statSync(join(dir, name), { throwIfNoEntry: false })?.size ?? 0);
}

/** Every recorded pid is gone and no tick file grows afterwards. */
async function expectReaped(dir: string, pids: Readonly<Record<string, number>>, ticks: readonly string[]): Promise<void> {
  expect(livePids(Object.values(pids)), JSON.stringify(pids)).toEqual([]);
  const before = tickSizes(dir, ticks);
  await new Promise(resolve => setTimeout(resolve, 400));
  expect(tickSizes(dir, ticks)).toEqual(before);
}

/** Test cleanup only: stop pids this test recorded, after its assertions. Ave itself signals none of them. */
function reapRecorded(pids: Readonly<Record<string, number>>): void {
  for (const pid of livePids(Object.values(pids))) {
    try { process.kill(pid, "SIGKILL"); } catch { /* exited between listing and kill */ }
  }
}

async function collectShell(launch: ReturnType<typeof startMxcShellSupervisor>) {
  let stdout = "";
  let stderr = "";
  launch.child.stdout.setEncoding("utf8").on("data", (data: string) => { stdout += data; });
  launch.child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr += data; });
  return { ...await launch.completion, stdout, stderr };
}

describe.runIf(NATIVE)("native macOS shell boundary", () => {
  let root: string;
  let work: string;

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "sb-")));
    work = join(root, "work");
    mkdirSync(work);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function launch(commandLine: string, timeoutMs: number, model: PolicyModel, cwd = work) {
    const { request } = buildSeatbeltShellRequest({
      model, cwd, commandLine, timeoutMs, lookups: posixPolicyLookups(root, true),
      env: { HOME: root, PATH: "/usr/bin:/bin" }, proxyUrl: "http://127.0.0.1:1",
    });
    const staged = await stageMxcShellRequest(join(root, "request.json"), request);
    return collectShell(startMxcShellSupervisor(staged, timeoutMs, undefined, () => {},
      "test:boundary-shell", supervisor.location));
  }

  it("carves around a denied sibling and refuses protected moves and new pattern matches", async () => {
    const vault = join(root, "vault");
    const open = join(vault, "open");
    const secret = join(vault, "secret");
    const protectedParent = join(work, "control");
    const protectedChild = join(protectedParent, "locked");
    mkdirSync(protectedChild, { recursive: true });
    mkdirSync(open, { recursive: true });
    writeFileSync(join(open, "control"), "readable");
    writeFileSync(secret, "private fixture");
    const model = buildPolicyModel({
      userGrants: [], extensionManifests: [],
      floors: [
        policyFloorRow(vault, "denied", "read-boundary", true),
        policyFloorRow(protectedChild, "ro", "protected-name", true),
        policyFloorRow(`${work}/**/*.locked`, "ro", "protected-name", false),
      ],
      launchGrants: [
        policyGrantRow(root, "ro", "launch-grant", true),
        policyGrantRow(work, "rw", "launch-grant", true),
        policyGrantRow(open, "ro", "launch-grant", true),
      ],
    });
    const result = await launch([
      `test "$(cat '${open}/control')" = readable || exit 11`,
      `if cat '${secret}'; then exit 12; fi`,
      `if stat '${secret}'; then exit 16; fi`,
      "mkdir ordinary && echo ok > ordinary/good || exit 13",
      "if (echo denied > ordinary/new.locked); then exit 14; fi",
      "if mv control renamed; then exit 15; fi",
    ].join("\n"), 3_000, model);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).not.toContain("private fixture");
    expect(existsSync(protectedChild)).toBe(true);
    expect(existsSync(join(work, "ordinary", "new.locked"))).toBe(false);
    expect(readFileSync(join(work, "ordinary", "good"), "utf8").trim()).toBe("ok");
  });

  it("keeps both admitted children readable through nested carves and both denied scopes closed", async () => {
    const outer = join(work, "outer");
    const project = join(outer, "project");
    const inner = join(project, "inner");
    const child = join(inner, "child");
    mkdirSync(child, { recursive: true });
    for (const dir of [outer, project, inner, child]) writeFileSync(join(dir, "file"), "fixture");

    const model = buildPolicyModel({
      floors: [outer, inner].map(dir => policyFloorRow(dir, "denied", "read-boundary", true)),
      launchGrants: [work, project, child].map(dir => policyGrantRow(dir, "ro", "launch-grant", true)),
      userGrants: [], extensionManifests: [],
    });
    const result = await launch([
      `cat '${project}/file' || exit 11`,
      `cat '${child}/file' || exit 12`,
      `if cat '${outer}/file'; then exit 13; fi`,
      `if cat '${inner}/file'; then exit 14; fi`,
    ].join("\n"), 3_000, model);
    expect(result.code, result.stdout + result.stderr).toBe(0);
  });

  it("reaps the shell, a background child and a setsid descendant on the backend timeout under an override", async () => {
    const model = buildPolicyModel({
      floors: [], userGrants: [], extensionManifests: [],
      launchGrants: [policyGrantRow(work, "rw", "launch-grant", true)],
    });
    const result = await launch([
      "echo $$ > shell.pid",
      "sleep 8 & echo $! > child.pid",
      `/usr/bin/perl -MPOSIX -e 'POSIX::setsid() >= 0 or die $!; open(my $pid, ">", "detached.pid") or die $!; print $pid $$; close($pid); sleep 8' &`,
      "wait",
    ].join("\n"), 1_200, model);
    expect(result).toMatchObject({ timedOut: true, cleanupUnverified: false });
    for (const name of ["shell", "child", "detached"]) {
      const pid = Number(readFileSync(join(work, `${name}.pid`), "utf8").trim());
      expect(pid).toBeGreaterThan(1);
      expect(() => process.kill(pid, 0), name).toThrow(expect.objectContaining({ code: "ESRCH" }));
    }
  });

  it("proves the boot canary through the installed sandbox library, measures raw IP in it and cleans its staging", async () => {
    const result = await _runSeatbeltCanaryForTest(supervisor.location, root);
    // The control passed with the nonce on both sides and T4 was refused by Seatbelt itself. With no IPv6 route the
    // profile's default deny stands in for T6; the evidence kind records which this host gave.
    expect(result).toMatchObject({ verdict: "available", rawIpProbe: { rawIp: "blocked", reachableTargets: [], udpArrival: "absent" } });
    expect(["measured", "structural"]).toContain((result as { rawIpProbe: { evidenceKind: string } }).rawIpProbe.evidenceKind);
    expect(readdirSync(root)).toEqual(["work"]);
  }, 30_000);

  it("names the host-side targets that saw an open network when the profile lets them through", async () => {
    // Aimed at loopback, the closed TCP port and the UDP listener are the only addresses the edit opens. Every other
    // availability check still holds, the documentation addresses stay denied, and the run is the same on any network.
    const result = await _runSeatbeltCanaryForTest(supervisor.location, root, undefined, {
      hostAddress: "127.0.0.1",
      editProfile: (profile, ports) => {
        if (ports === undefined) throw new Error("Expected the host-side targets to bind on loopback");
        return `${profile}\n(allow network-outbound (remote ip "localhost:${ports.tl}") (remote ip "localhost:${ports.udp}"))`;
      },
    });
    // The closed port answers with ECONNREFUSED, so a packet reached a peer, and the UDP nonce arrives.
    expect(result).toEqual({
      verdict: "available",
      rawIpProbe: { rawIp: "unknown", reason: "raw-ip-reachable", reachableTargets: ["tl", "udp"], udpArrival: "arrived" },
    });
  }, 30_000);

  it.each([
    ["returns", "/usr/bin/true", false],
    ["stalls past the watchdog", "/bin/sleep 30", true],
  ])("leaves no raw-IP watchdog process behind when the prober %s", (_name, prober, cutOff) => {
    // Run on the host, outside any container, so no container teardown can reap what the lines leave behind.
    const watchdogSeconds = cutOff ? `0.${String(randomInt(300_000, 400_000))}` : `13.${String(randomInt(100_000, 1_000_000))}`;
    const marker = join(root, "probe.out");
    const lines = rawIpProbeShellLines({ prober, output: marker, watchdogSeconds });
    const started = Date.now();
    const status = spawnSync("/bin/sh", ["-c", [...lines, 'echo "done $?"'].join("\n")], { encoding: "utf8", timeout: 10_000 });
    expect(status.stdout.trim()).toMatch(/^done \d+$/u);
    expect(Date.now() - started).toBeLessThan(5_000);
    spawnSync("/bin/sleep", ["0.2"]);
    const processes = execFileSync("/bin/ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" });
    expect(processes.split("\n").filter(line => line.includes(watchdogSeconds))).toEqual([]);
  });

  it("leaves no raw-IP watchdog running once the canary has returned", async () => {
    // A delay no other run uses marks this run's watchdog in the host's process table.
    const watchdogSeconds = `13.${String(randomInt(100_000, 1_000_000))}`;
    const result = await _runSeatbeltCanaryForTest(supervisor.location, root, undefined, { watchdogSeconds });
    expect(result.verdict).toBe("available");
    const processes = execFileSync("/bin/ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" });
    expect(processes.split("\n").filter(line => line.includes(watchdogSeconds))).toEqual([]);
  }, 30_000);

  it("keeps the shell container available and the raw-IP verdict unknown when the host-side targets cannot bind", async () => {
    // 192.0.2.1 is no address of this host, so both the closed TCP port and the UDP listener fail to bind there
    // (EADDRNOTAVAIL). That is missing evidence about raw IP, never a reason the shell container is unavailable.
    const result = await _runSeatbeltCanaryForTest(supervisor.location, root, undefined, { hostAddress: "192.0.2.1" });
    expect(result).toEqual({
      verdict: "available", rawIpProbe: { rawIp: "unknown", reason: "no-evidence", reachableTargets: [], udpArrival: "unmeasured" },
    });
    expect(readdirSync(root)).toEqual(["work"]);
  }, 30_000);

  it.each([
    ["prints nothing", "exit 0;"],
    ["dies before any line", "die 'prober unavailable';"],
    ["stalls past its budget", "select(undef, undef, undef, 30);"],
  ])("keeps the shell container available with an unknown raw-IP verdict when the prober %s", async (_name, prober) => {
    const result = await _runSeatbeltCanaryForTest(supervisor.location, root, undefined, { prober });
    expect(result).toEqual({ verdict: "available", rawIpProbe: { rawIp: "unknown", reason: "no-evidence", reachableTargets: [], udpArrival: "unmeasured" } });
    expect(readdirSync(root)).toEqual(["work"]);
  }, 30_000);

  it("cleans the canary staging when boot is cancelled", async () => {
    const controller = new AbortController();
    const reason = new Error("Canary cancelled");
    const outcome = _runSeatbeltCanaryForTest(supervisor.location, root, controller.signal);
    const observed = expect(outcome).rejects.toBe(reason);
    await vi.waitFor(() => {
      const directory = readdirSync(root).find(name => name.startsWith("p-"));
      expect(directory && existsSync(join(root, directory, "canary.json"))).toBe(true);
    }, { interval: 1, timeout: 2_000 });
    controller.abort(reason);
    await observed;
    expect(readdirSync(root)).toEqual(["work"]);
  });
});

// Change this receipt only after verifying the native boundary against the new library.
const VERIFIED_LIBRARY = "b99eba8c95bde9a104c025a17e077f71ad420c4ac58f873af41170e8ac848e3f";
it("requires new macOS boundary evidence when the sandbox library pin changes", () => {
  expect(pins.targets["darwin-arm64"].library.sha256).toBe(VERIFIED_LIBRARY);
});

describe.runIf(NATIVE)("native product shell launch", () => {
  let root: string;
  let project: string;
  let home: string;
  let runtime: string;
  let cache: string;
  let leases: ReturnType<typeof createContainedShellLifecycle>[];
  let listeners: Server[];

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "sb-")));
    project = join(root, "work");
    home = join(root, "home");
    mkdirSync(project);
    mkdirSync(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("AVE_TEST_SANDBOX_BASE", root);
    cache = currentMxcRuntimeHost().cacheHome;
    runtime = establishMxcRuntimeRoot();
    configureHostResources(supervisor.resources);
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({
      kind: "asrt", platform: "darwin", confidence: "verified", reason: "Test relay",
      confines: { filesystem: true, network: true, process: true },
    });
    setContainerShellSubstrate({ state: "available" });
    leases = [];
    listeners = [];
  });

  afterEach(async () => {
    await Promise.all(leases.map(lease => lease.dispose()));
    await stopEgressRelayService();
    for (const listener of listeners) listener.close();
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
    _forgetMxcRuntimeRootForTest(cache);
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  async function prepare(commandLine: string, options: {
    allowRead?: string[];
    allowWrite?: string[];
    denyRead?: string[];
    env?: Record<string, string>;
    cwd?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {}) {
    const lease = createContainedShellLifecycle();
    leases.push(lease);
    const egress = openEgressInvocation({
      kind: "shell", toolName: "bash", toolUseId: undefined, requiresListener: true,
      context: { approvalSurface: "unavailable", sessionId: undefined, workspaceRoot: project },
    }, options.signal ? { abortSignal: options.signal } : {});
    lease.onRevoke(egress.release);
    return prepareMxcPosixShellLaunch({
      egressToken: egress.token, commandLine, timeoutMs: options.timeoutMs ?? 10_000,
      cwd: options.cwd ?? project, allowRead: options.allowRead ?? [], allowWrite: options.allowWrite ?? [project],
      denyRead: options.denyRead ?? [], floorPierces: [],
      env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", ...options.env },
    }, lease);
  }

  function run(launch: Awaited<ReturnType<typeof prepare>>) {
    return collectShell(launch.start("test:native-posix-shell"));
  }

  function latestLease() {
    const lease = leases.at(-1);
    if (lease === undefined) throw new Error("Expected a prepared invocation");
    return lease;
  }

  /** The live standby's pid; throws until one exists, for `vi.waitFor`. */
  function standbyPid(): number {
    const pid = _mxcShellStandbyPidForTest(supervisor.location);
    if (pid === undefined) throw new Error("No live standby");
    return pid;
  }

  async function compareLauncher(command: string, sealed: string, allowed: string[]) {
    const sdkRoot = resolve("node_modules", pins.sdk.packages["@microsoft/mxc-sdk"]);
    const pin = pins.targets["darwin-arm64"].launcher;
    const cli = join(sdkRoot, pin.member);
    expect(createHash("sha256").update(readFileSync(cli)).digest("hex")).toBe(pin.sha256);

    const previous = new Set(readdirSync(runtime));
    const admitted = await prepare(command, { denyRead: [sealed], allowRead: allowed, timeoutMs: LAUNCHER_START_TIMEOUT_MS });
    const staged = readdirSync(runtime).filter(name => name.startsWith("shell-") && !previous.has(name));
    expect(staged).toHaveLength(1);
    const requestPath = join(runtime, ...staged, "request.json");
    const cliStarted = performance.now();
    const baseline = spawnSync(cli, ["--config", requestPath], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: LAUNCHER_START_TIMEOUT_MS,
    });
    console.info("Launcher CLI start with %d explicit read grants: %s ms", allowed.length, (performance.now() - cliStarted).toFixed(0));
    expect(baseline.error).toBeUndefined();
    expect(baseline).toMatchObject({ status: 0, stdout: "new access", stderr: "" });

    // Regression check: the same staged bytes through the supervisor without its call stack setting die before exec
    // where libsandbox overruns the default stack. Where it does not, they run exactly as the CLI did, so the
    // configured stack changes nothing there.
    const requestSha256 = createHash("sha256").update(readFileSync(requestPath)).digest("hex");
    const unconfigured = await collectShell(startMxcShellSupervisor({ type: "shell-start", requestPath, requestSha256 },
      LAUNCHER_START_TIMEOUT_MS, undefined, () => {}, "test:default-stack-shell", supervisor.defaultStackLocation));
    expect(unconfigured).toMatchObject(DEFAULT_STACK_OVERRUNS
      ? { code: -1, stdout: "", cleanupUnverified: false }
      : { code: baseline.status, stdout: baseline.stdout, stderr: baseline.stderr, cleanupUnverified: false });

    const supervised = await run(admitted);
    expect(supervised).toMatchObject({ code: baseline.status, stdout: baseline.stdout, stderr: baseline.stderr });
  }

  async function listen(server: Server, socket?: string): Promise<number> {
    listeners.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      if (socket === undefined) server.listen(0, "127.0.0.1", resolve);
      else server.listen(socket, resolve);
    });
    const address = server.address();
    return typeof address === "object" && address !== null ? address.port : 0;
  }

  it("holds the parent, socket, late name and stat boundaries beside admitted operations", async () => {
    startEgressRelayService({ ask: async () => false });
    const socket = join(project, "host.sock");
    let connected = false;
    await listen(createServer(connection => { connected = true; connection.destroy(); }), socket);
    const protectedParent = join(project, ".ave", "commands");
    const laterHooks = join(project, "later", ".git", "hooks");
    const linkTarget = join(project, "target");
    const vault = join(home, "vault");
    const grant = join(vault, "open");
    const library = join(home, "Library");
    const libraryDeny = join(library, "keys");
    mkdirSync(protectedParent, { recursive: true });
    mkdirSync(linkTarget);
    symlinkSync(linkTarget, join(project, ".agents"));
    mkdirSync(grant, { recursive: true });
    mkdirSync(libraryDeny, { recursive: true });
    writeFileSync(join(protectedParent, "keep"), "original");
    writeFileSync(join(linkTarget, "keep"), "original");
    writeFileSync(join(vault, "sealed"), "not admitted");
    writeFileSync(join(grant, "readable"), "granted");
    writeFileSync(join(library, "readable"), "library");
    writeFileSync(join(libraryDeny, "secret"), "not admitted");
    const launch = await prepare([
      "set -eu",
      "mkdir later normal && echo control > normal/file",
      "mv normal renamed && test \"$(cat renamed/file)\" = control",
      "if mv .ave moved; then exit 31; fi",
      `if /usr/bin/nc -z -U ${quote(socket)}; then exit 32; fi`,
      `if /usr/bin/nc -l -U ${quote(join(project, "new.sock"))} </dev/null; then exit 33; fi`,
      "while [ ! -f late-ready ]; do /bin/sleep 0.02; done",
      "test -d later/.git/hooks || exit 42",
      "if (echo deny > later/.git/hooks/new); then exit 34; fi",
      `if stat ${quote(join(vault, "sealed"))}; then exit 35; fi`,
      `if cat ${quote(join(vault, "sealed"))}; then exit 36; fi`,
      `if (echo deny > ${quote(join(vault, "write"))}); then exit 37; fi`,
      "if (echo deny > .agents/keep); then exit 38; fi",
      `if cat ${quote(join(libraryDeny, "secret"))}; then exit 39; fi`,
      `if stat ${quote(join(libraryDeny, "secret"))}; then exit 40; fi`,
      `test "$(cat ${quote(join(grant, "readable"))})" = granted`,
      `test "$(cat ${quote(join(library, "readable"))})" = library`,
      "printf '%s' boundary-control",
    ].join("\n"), { allowRead: [grant], denyRead: [vault, libraryDeny, "/private/etc/hosts"] });
    const runDir = readdirSync(runtime).find(name => name.startsWith("shell-"));
    if (runDir === undefined) throw new Error("Expected a private shell request directory");
    const config = join(runtime, runDir, "request.json");
    expect(statSync(config).mode & 0o777).toBe(0o600);
    const request = JSON.parse(readFileSync(config, "utf8"));
    expect(request.seatbelt.profileOverride).toContain('(subpath "/private/etc/hosts")');
    expect(request.filesystem.deniedPaths).toContain(libraryDeny);
    const completion = run(launch);
    await Promise.race([
      vi.waitFor(() => expect(existsSync(join(project, "later"))).toBe(true), { timeout: 4_000 }),
      completion.then(exit => { throw new Error(`Shell left before the fixture was released: ${exit.code} ${exit.stderr}`); }),
    ]);
    mkdirSync(laterHooks, { recursive: true });
    writeFileSync(join(project, "late-ready"), "ready");
    const result = await completion;
    expect(result, result.stderr).toMatchObject({ code: 0, rejected: false, stdout: "boundary-control" });
    expect(connected).toBe(false);
    expect(existsSync(join(project, "new.sock"))).toBe(false);
    expect(existsSync(join(project, "later", ".git", "hooks", "new"))).toBe(false);
    expect(existsSync(join(vault, "write"))).toBe(false);
    expect(readFileSync(join(protectedParent, "keep"), "utf8")).toBe("original");
    expect(readFileSync(join(linkTarget, "keep"), "utf8")).toBe("original");
    expect(await leases[0]?.dispose()).toEqual([]);
    expect(existsSync(config)).toBe(false);
  });

  it("refuses an absent or invalid sandbox library through the boot check", async () => {
    const resources = { resourcePath: join(root, "resources"), isPackaged: false };
    await expect(detectHostMxcMacShellSupport(resources)).resolves.toEqual({ state: "unavailable", reason: "binary-missing" });
    const nodeModules = join(root, "node_modules");
    for (const relative of [...Object.keys(pins.sdk.files), ...Object.keys(pins.sdk.darwinFiles)]) {
      const destination = join(nodeModules, relative);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(supervisor.location.nodeModules, relative), destination);
    }
    const library = join(nodeModules, pins.sdk.packages["@microsoft/mxc-sdk"], pins.targets["darwin-arm64"].library.member);
    mkdirSync(dirname(library), { recursive: true });
    writeFileSync(library, "changed");
    const entry = mxcShellSupervisorLocation(resources).entry;
    mkdirSync(dirname(entry), { recursive: true });
    symlinkSync(supervisor.location.entry, entry);
    await expect(detectHostMxcMacShellSupport(resources)).resolves.toEqual({ state: "unavailable", reason: "launcher-mismatch" });
  });

  it("reads a new command grant without restarting the relay, matching the launcher only with the configured call stack", async () => {
    startEgressRelayService({ ask: async () => false });
    const sealed = join(home, "seal");
    const offered = join(sealed, "file");
    mkdirSync(sealed);
    writeFileSync(offered, "new access");
    const check = `cat ${quote(offered)}`;
    const denied = await run(await prepare(check, { denyRead: [sealed] }));
    expect(denied.code).not.toBe(0);
    await compareLauncher(check, sealed, [offered]);
  });

  it("matches the launcher with thirty deeply nested explicit read grants only with the configured call stack", async () => {
    startEgressRelayService({ ask: async () => false });
    const sealed = join(home, "seal");
    const allowed = Array.from({ length: 30 }, (_, index) => {
      const branch = join(sealed, `d${index}`);
      const nested = join(branch, "inner", "deeper");
      mkdirSync(nested, { recursive: true });
      for (let sibling = 0; sibling < 8; sibling += 1) {
        writeFileSync(join(nested, `sibling${sibling}`), "private fixture");
        mkdirSync(join(branch, `side${sibling}`));
      }
      const offered = join(nested, "file");
      writeFileSync(offered, "new access");
      return offered;
    });
    await compareLauncher(`cat ${quote(allowed.at(-1) ?? "")}`, sealed, allowed);
  }, 4 * LAUNCHER_START_TIMEOUT_MS);

  it("tunnels verified TLS from curl, git, node and python through its own live proxy only", async () => {
    const hostname = "shell-boundary.example";
    const keyPath = join(root, "server.key");
    const serverCert = join(root, "server.pem");
    const certificate = join(project, "ca.pem");
    const caKey = join(root, "ca.key");
    const csr = join(root, "server.csr");
    const extensions = join(root, "certificate.cnf");
    writeFileSync(extensions, [
      "[req]", "distinguished_name = name", "[name]", "[ca]",
      "basicConstraints = critical,CA:true", "keyUsage = critical,keyCertSign,cRLSign",
      "subjectKeyIdentifier = hash", "[server]", "basicConstraints = critical,CA:false",
      "keyUsage = critical,digitalSignature,keyEncipherment", "extendedKeyUsage = serverAuth",
      "subjectKeyIdentifier = hash", "authorityKeyIdentifier = keyid,issuer", `subjectAltName = DNS:${hostname}`,
    ].join("\n"));
    const openssl = (...args: string[]) => execFileSync("/usr/bin/openssl", args, { stdio: "ignore" });
    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Boundary test CA",
      "-config", extensions, "-extensions", "ca", "-keyout", caKey, "-out", certificate);
    openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=${hostname}`, "-keyout", keyPath, "-out", csr);
    openssl("x509", "-req", "-in", csr, "-CA", certificate, "-CAkey", caKey, "-set_serial", "1", "-days", "1",
      "-extfile", extensions, "-extensions", "server", "-out", serverCert);
    const ref = "a".repeat(40);
    const tlsServer = createHttpsServer({ key: readFileSync(keyPath), cert: readFileSync(serverCert) }, (req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.end(req.url?.includes("/info/refs") ? `${ref}\trefs/heads/main\n` : "tls-control");
    });
    const tlsPort = await listen(tlsServer);
    let tunnels = 0;
    const proxy = createHttpServer((_req, res) => { res.writeHead(404).end(); });
    proxy.on("connect", (req, client, head) => {
      if (req.url !== `${hostname}:443` && req.url !== "93.184.215.14:443") { client.destroy(); return; }
      tunnels++;
      const upstream = connect(tlsPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      client.once("close", () => upstream.destroy());
    });
    const upstreamPort = await listen(proxy);
    const relay: EgressRelayServiceOptions = {
      ask: async () => true,
      resolve: async () => [{ address: "93.184.215.14" }],
      router: async ({ scheme }) => ({ routes: [{ kind: "http", host: "127.0.0.1", port: upstreamPort, resolvesNames: scheme === "https" }] }),
    };
    startEgressRelayService(relay);
    const other = await prepare("sleep 10");
    const otherRun = other.start("test:second-proxy");
    otherRun.child.stdout.resume();
    otherRun.child.stderr.resume();
    const nodeScript = join(project, "tls-client.cjs");
    writeFileSync(nodeScript, `
const { request } = require("node:http");
const { connect } = require("node:tls");
const { readFileSync } = require("node:fs");
const endpoint = new URL(process.env.HTTPS_PROXY || process.env.https_proxy);
const host = process.argv[2];
const req = request({ hostname: endpoint.hostname, port: endpoint.port, method: "CONNECT", path: host + ":443" });
req.on("connect", (response, socket, head) => {
  if (response.statusCode !== 200) throw new Error("CONNECT refused");
  if (head.length) socket.unshift(head);
  const tls = connect({ socket, servername: host, ca: readFileSync(process.env.SSL_CERT_FILE) }, () => {
    tls.write("GET / HTTP/1.1\\r\\nHost: " + host + "\\r\\nConnection: close\\r\\n\\r\\n");
  });
  let body = "";
  tls.setEncoding("utf8").on("data", data => { body += data; });
  tls.on("end", () => { if (!body.includes("tls-control")) process.exitCode = 1; });
});
req.end();
`);
    const url = `https://${hostname}`;
    const python = "import ssl,sys,urllib.request; r=urllib.request.urlopen(sys.argv[1],context=ssl.create_default_context()); assert r.read() == b'tls-control'";
    const result = await run(await prepare([
      "set -eu",
      `test "$(curl -fsS --max-time 3 --cacert ${quote(certificate)} ${url}/)" = tls-control`,
      `git -c http.sslCAInfo=${quote(certificate)} ls-remote ${url}/repo | grep ${ref}`,
      `node ${quote(nodeScript)} ${hostname}`,
      `python3 -c ${quote(python)} ${url}`,
      `if curl --noproxy '*' -fsS --max-time 1 http://${hostname}/; then exit 31; fi`,
      `if /usr/bin/nc -z -w 1 127.0.0.1 ${other.proxyPort}; then exit 32; fi`,
      `if /usr/bin/nc -z -w 1 127.0.0.1 ${tlsPort}; then exit 33; fi`,
      `if /usr/bin/nc -z -w 1 127.0.0.1 ${upstreamPort}; then exit 34; fi`,
      "printf '%s' proxy-control",
    ].join("\n"), { env: { SSL_CERT_FILE: certificate } }));
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("proxy-control");
    expect(tunnels).toBe(4);
    await leases[0]?.dispose();
    expect((await otherRun.completion).cancelled).toBe(true);
  }, 20_000);

  it("refuses a reserved Tailnet listener port directly, by loopback name and by any name, while another port still relays", async () => {
    const hits: string[] = [];
    let tailnetConnections = 0;
    const tailnet = await listen(createServer(socket => { tailnetConnections++; socket.destroy(); }));
    const release = reserveTailnetListenerPort(tailnet);
    try {
      const upstream = createHttpServer((req, res) => { hits.push(req.url ?? ""); res.end("relay-control"); });
      const upstreamPort = await listen(upstream);
      const asked: number[] = [];
      startEgressRelayService({
        ask: async (request) => { asked.push(request.port); return true; },
        resolve: async () => [{ address: "93.184.215.14" }],
        router: async () => ({ routes: [{ kind: "http", host: "127.0.0.1", port: upstreamPort, resolvesNames: true }] }),
      });
      const result = await run(await prepare([
        "set -u",
        `if /usr/bin/nc -z -w 1 127.0.0.1 ${tailnet}; then exit 41; fi`,
        `if curl -fsS --max-time 3 http://127.0.0.1:${tailnet}/; then exit 42; fi`,
        `if curl -fsS --max-time 3 http://tailnet-check.example:${tailnet}/; then exit 43; fi`,
        `test "$(curl -fsS --max-time 3 http://tailnet-check.example:${upstreamPort + 1}/)" = relay-control || exit 44`,
        "printf '%s' tailnet-control",
      ].join("\n")));
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("tailnet-control");
      // The control went through the relay; the reserved port reached nothing and was never asked about.
      expect(hits).toEqual([`http://tailnet-check.example:${upstreamPort + 1}/`]);
      expect(tailnetConnections).toBe(0);
      expect(asked).not.toContain(tailnet);
    } finally {
      release();
    }
  }, 20_000);

  it("holds protected and ordinary controls when workspace and deny names carry quotes, parentheses, backslashes and regex metacharacters", async () => {
    startEgressRelayService({ ask: async () => false });
    // Glob characters (`*?[]{}`) in a granted name are refused as a pattern grant before any profile is written, and the
    // SDK refuses a double quote in any path; both are asserted at the end. The rest must reach the profile and hold.
    const odd = `it's (a) \\ dir .+^$|`;
    const workspace = join(project, odd);
    const denied = join(home, `${odd} vault`);
    const deniedPrefixSibling = join(home, `${odd} vault-open`);
    mkdirSync(join(workspace, ".git", "hooks"), { recursive: true });
    mkdirSync(denied, { recursive: true });
    mkdirSync(deniedPrefixSibling, { recursive: true });
    writeFileSync(join(denied, "secret"), "private fixture");
    writeFileSync(join(deniedPrefixSibling, "open"), "open-control");
    const result = await run(await prepare([
      `cd ${quote(workspace)} || exit 50`,
      "printf ordinary > ordinary.txt || exit 51",
      "if (printf x > .git/hooks/pre-commit); then exit 52; fi",
      `if /bin/cat ${quote(join(denied, "secret"))}; then exit 53; fi`,
      `test "$(/bin/cat ${quote(join(deniedPrefixSibling, "open"))})" = open-control || exit 54`,
      "printf '%s' escape-control",
    ].join("\n"), { cwd: workspace, allowWrite: [workspace], denyRead: [denied], allowRead: [home] }));
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("escape-control");
    expect(readFileSync(join(workspace, "ordinary.txt"), "utf8")).toBe("ordinary");
    expect(existsSync(join(workspace, ".git", "hooks", "pre-commit"))).toBe(false);

    const globbed = join(project, "glob [x]{1}*?");
    mkdirSync(globbed);
    await expect(prepare("printf never", { cwd: globbed, allowWrite: [globbed] }))
      .rejects.toMatchObject({ code: "pattern-row" });
    const quoted = join(project, 'say "hi"');
    mkdirSync(quoted);
    expect(await run(await prepare(`printf never > ${quote(join(quoted, "ran"))}`, { cwd: quoted, allowWrite: [quoted] })))
      .toMatchObject({ rejected: true, failure: { code: "start-refused", sdkCode: "malformed_request" } });
    expect(existsSync(join(quoted, "ran"))).toBe(false);
  });

  it("cancels a real BashTool call on the container route: its invocation is revoked and nothing survives", async () => {
    startEgressRelayService({ ask: async () => false });
    const invocationsBefore = liveEgressInvocationCount();
    const controller = new AbortController();
    // The same five kinds by bare program name: the tool's own path gate refuses absolute paths outside the workspace.
    const workload = DETACH_WORKLOAD.replaceAll("/usr/bin/perl", "perl").replaceAll("/usr/bin/nohup", "nohup")
      .replaceAll("/bin/sleep", "sleep").replaceAll("/bin/sh", "sh");
    const pending = new BashTool().execute({ command: workload, timeoutSeconds: 60 }, {
      cwd: project, extraAllowedDirectories: [], metadata: { toolUseId: "native-bash-cancel" }, abortSignal: controller.signal,
    });
    const pids = {} as Record<(typeof DETACH_KINDS)[number], number>;
    try {
      // A call that ends before its shell wrote every pid file says why, instead of the wait running out.
      await Promise.race([recordedPids(project, DETACH_KINDS, pids), pending.then((early) => {
        throw new Error(`BashTool returned before its shell started: ${JSON.stringify(early).slice(0, 800)}`);
      })]);
      await vi.waitFor(() => expect(tickSizes(project, DETACH_TICKS).every(size => size > 0)).toBe(true));
      expect(liveEgressInvocationCount()).toBe(invocationsBefore + 1);
      controller.abort();
      const result = await pending;
      expect(result).toMatchObject({ isError: true, metadata: { sandboxed: true, aborted: true } });
      expect(result.output).toContain(t("sandboxPolicy.containerShellCancelled"));
      await expectReaped(project, pids, DETACH_TICKS);
      expect(liveEgressInvocationCount()).toBe(invocationsBefore);
    } finally {
      // On any failure above the call is still running: cancel it before reaping what it recorded.
      controller.abort();
      await pending;
      reapRecorded(pids);
    }
  }, 60_000);

  /** A staged request outside the product launch, for supervisor-level cases; the profile admits `project` only. */
  async function stageDirect(
    commandLine: string, timeoutMs: number,
    edit?: (request: ReturnType<typeof buildSeatbeltShellRequest>["request"]) => void,
    model = buildPolicyModel({
      floors: [], userGrants: [], extensionManifests: [], launchGrants: [policyGrantRow(project, "rw", "launch-grant", true)],
    }),
  ) {
    const { request } = buildSeatbeltShellRequest({
      model, cwd: project, commandLine, timeoutMs, lookups: posixPolicyLookups(root, true),
      env: { HOME: home, PATH: "/usr/bin:/bin" }, proxyUrl: "http://127.0.0.1:1",
    });
    edit?.(request);
    const staging = mkdtempSync(join(root, "direct-"));
    return { staging, staged: await stageMxcShellRequest(join(staging, "request.json"), request) };
  }

  it("cancels every process kind at once, including a separate-session writer on inherited stdout", async () => {
    startEgressRelayService({ ask: async () => false });
    const launch = await prepare(DETACH_WORKLOAD, { timeoutMs: 60_000 });
    const lease = latestLease();
    const pending = run(launch);
    const pids = await recordedPids(project, DETACH_KINDS);
    try {
      await vi.waitFor(() => expect(tickSizes(project, DETACH_TICKS).every(size => size > 0)).toBe(true));
      expect(livePids(Object.values(pids)).sort()).toEqual(Object.values(pids).sort());
      const stoppedAt = performance.now();
      lease.revoke();
      const result = await pending;
      expect(performance.now() - stoppedAt).toBeLessThan(2_000);
      expect(result).toMatchObject({ cancelled: true, timedOut: false, cleanupUnverified: false });
      expect(result.stdout).toContain("tick");
      await expectReaped(project, pids, DETACH_TICKS);
      expect(await lease.dispose()).toEqual([]);
    } finally {
      reapRecorded(pids);
    }
  });

  it("reaps every process kind on the request timeout", async () => {
    startEgressRelayService({ ask: async () => false });
    const pending = run(await prepare(DETACH_WORKLOAD, { timeoutMs: 2_500 }));
    const pids = await recordedPids(project, DETACH_KINDS);
    try {
      expect(livePids(Object.values(pids)).sort()).toEqual(Object.values(pids).sort());
      expect(await pending).toMatchObject({ timedOut: true, cancelled: false, cleanupUnverified: false });
      await expectReaped(project, pids, DETACH_TICKS);
    } finally {
      reapRecorded(pids);
    }
  });

  it("leaves nothing writing after cancelling a session-hopping respawner", async () => {
    startEgressRelayService({ ask: async () => false });
    const launch = await prepare(RESPAWN_WORKLOAD, { timeoutMs: 60_000 });
    const lease = latestLease();
    const pending = run(launch);
    const pids = await recordedPids(project, ["shell", "hop"]);
    try {
      await new Promise(resolve => setTimeout(resolve, 500));
      lease.revoke();
      expect(await pending).toMatchObject({ cancelled: true, cleanupUnverified: false });
      // The respawner rewrites its pid file every 5 ms; a stop between the truncate and the write leaves it empty.
      // That last hop is then covered by its tick file alone.
      const last = Number(readFileSync(join(project, "hop.pid"), "utf8").trim());
      await expectReaped(project, { ...pids, ...(last > 1 ? { last } : {}) }, ["tick-hop"]);
    } finally {
      reapRecorded(pids);
    }
  });

  it("cancels a command whose stop arrives before the shell is ready", async () => {
    startEgressRelayService({ ask: async () => false });
    const launch = await prepare(DETACH_WORKLOAD, { timeoutMs: 60_000 });
    const lease = latestLease();
    const pending = run(launch);
    lease.revoke();
    const result = await pending;
    expect(result).toMatchObject({ cancelled: true, cleanupUnverified: false });
    const started = DETACH_KINDS.filter(name => existsSync(join(project, `${name}.pid`)));
    const pids = Object.fromEntries(started.map(name => [name, Number(readFileSync(join(project, `${name}.pid`), "utf8").trim())]));
    try {
      await expectReaped(project, pids, DETACH_TICKS);
      expect(await lease.dispose()).toEqual([]);
    } finally {
      reapRecorded(pids);
    }
  });

  it("reports cleanup unverified when the supervisor ignores the watchdog's stop, without waiting on its output", async () => {
    const { staging, staged } = await stageDirect("/usr/bin/true", 100);
    const revoke = vi.fn();
    const launch = startMxcShellSupervisor(staged, 100, undefined, revoke, "test:ignore-stop", supervisor.ignoreStopLocation);
    const pending = collectShell(launch);
    const holder = await recordedPids(staging, ["holder"]);
    try {
      const result = await pending;
      const settledAt = Date.now();
      const stopAt = Number(readFileSync(join(staging, "stop-received"), "utf8"));
      expect(result).toMatchObject({ code: null, cancelled: false, timedOut: false, rejected: false, cleanupUnverified: true });
      expect(stopAt - Number(statSync(staged.requestPath).mtimeMs)).toBeGreaterThanOrEqual(TOOL_TIMEOUT_POLICY.mxcMacShellStopMs);
      // The stop deadline, then the one-second output allowance (the holder keeps both pipes open), then scheduling.
      expect(settledAt - stopAt).toBeLessThan(TOOL_TIMEOUT_POLICY.mxcMacShellStopMs + TOOL_TIMEOUT_POLICY.mxcMacShellOutputDrainMs + 500);
      expect(revoke).toHaveBeenCalled();
      expect(launch.child.signalCode).toBe("SIGKILL");
      expect(launch.child.stdout.destroyed && launch.child.stderr.destroyed).toBe(true);
      // The output holder is still alive: settlement did not wait for its pipe.
      expect(livePids([holder.holder])).toEqual([holder.holder]);
    } finally {
      reapRecorded(holder);
    }
  }, 40_000);

  it("reports cleanup unverified when the supervisor is killed mid-run and signals nothing else", async () => {
    startEgressRelayService({ ask: async () => false });
    const started = (await prepare(DETACH_WORKLOAD, { timeoutMs: 60_000 })).start("test:supervisor-killed");
    const pending = collectShell(started);
    const pids = await recordedPids(project, DETACH_KINDS);
    const signals = vi.spyOn(process, "kill");
    try {
      started.child.kill("SIGKILL");
      const result = await pending;
      expect(result).toMatchObject({ code: null, cancelled: false, timedOut: false, cleanupUnverified: true });
      expect(signals).not.toHaveBeenCalled();
      // The disclosed fault limit: the workload outlives a killed supervisor, still confined.
      expect(livePids([pids.daemon, pids.nohup])).toHaveLength(2);
    } finally {
      signals.mockRestore();
      reapRecorded(pids);
    }
  });

  it("reaps everything and exits cleanly when its owner pipe closes", async () => {
    startEgressRelayService({ ask: async () => false });
    const started = (await prepare(DETACH_WORKLOAD, { timeoutMs: 60_000 })).start("test:owner-lost");
    const pending = collectShell(started);
    const pids = await recordedPids(project, DETACH_KINDS);
    try {
      (started.child.stdio[3] as Writable).destroy();
      await pending;
      expect(started.child.exitCode).toBe(0);
      await expectReaped(project, pids, DETACH_TICKS);
    } finally {
      reapRecorded(pids);
    }
  });

  it("reaps everything and exits when the supervisor receives SIGTERM", async () => {
    startEgressRelayService({ ask: async () => false });
    const started = (await prepare(DETACH_WORKLOAD, { timeoutMs: 60_000 })).start("test:supervisor-term");
    const pending = collectShell(started);
    const pids = await recordedPids(project, DETACH_KINDS);
    try {
      started.child.kill("SIGTERM");
      expect(await pending).toMatchObject({ cancelled: true, cleanupUnverified: false });
      expect(started.child.exitCode).toBe(0);
      await expectReaped(project, pids, DETACH_TICKS);
    } finally {
      reapRecorded(pids);
    }
  });

  it("refuses a kernel-rejected profile and an unreadable request before anything runs", async () => {
    const marker = join(project, "marker");
    const rejected = await stageDirect(`/usr/bin/touch ${quote(marker)}`, 5_000, request => {
      request.seatbelt.profileOverride = "(version 1)(bogus-operation)";
    });
    const kernel = await collectShell(startMxcShellSupervisor(rejected.staged, 5_000, undefined, () => {}, "test:kernel-reject", supervisor.location));
    expect(kernel).toMatchObject({ rejected: true, cleanupUnverified: false, failure: { code: "start-refused", sdkCode: "backend_error" } });
    const malformed = join(mkdtempSync(join(root, "direct-")), "request.json");
    writeFileSync(malformed, "{", { mode: 0o600 });
    const requestSha256 = createHash("sha256").update("{").digest("hex");
    const unreadable = await collectShell(startMxcShellSupervisor({ type: "shell-start", requestPath: malformed, requestSha256 },
      5_000, undefined, () => {}, "test:malformed", supervisor.location));
    expect(unreadable).toMatchObject({ rejected: true, failure: { code: "start-refused", sdkCode: "malformed_request" } });
    expect(existsSync(marker)).toBe(false);
  });

  it("reports literal and signal exits, passes large output byte-exact and ends the workload's stdin", async () => {
    startEgressRelayService({ ask: async () => false });
    expect(await run(await prepare("exit 255"))).toMatchObject({ code: 255, cancelled: false, cleanupUnverified: false });
    expect(await run(await prepare("kill -KILL $$"))).toMatchObject({ code: -1, cancelled: false, cleanupUnverified: false });
    const large = await run(await prepare("/usr/bin/head -c 1048576 /dev/zero | /usr/bin/tr '\\0' a"));
    expect(large.code).toBe(0);
    expect(large.stdout).toBe("a".repeat(1_048_576));
    const startedAt = performance.now();
    expect(await run(await prepare("/bin/cat"))).toMatchObject({ code: 0, stdout: "" });
    expect(performance.now() - startedAt).toBeLessThan(5_000);
  });

  it("runs a row-cap request above one frame and refuses a staged file altered after its digest", async () => {
    // About 400 generated rows: an admitted folder with a denied child, 199 times, beside the project grant.
    const folders = Array.from({ length: 199 }, (_, index) => join(root, "rows", `r${index}`));
    for (const folder of folders) mkdirSync(join(folder, "secret"), { recursive: true });
    const capped = await stageDirect("printf cap-ok", 10_000, undefined, buildPolicyModel({
      userGrants: [], extensionManifests: [],
      floors: folders.map(folder => policyFloorRow(join(folder, "secret"), "denied", "read-boundary", true)),
      launchGrants: [policyGrantRow(project, "rw", "launch-grant", true),
        ...folders.map(folder => policyGrantRow(folder, "ro", "launch-grant", true))],
    }));
    expect(statSync(capped.staged.requestPath).size).toBeGreaterThan(65_536);
    expect(await collectShell(startMxcShellSupervisor(capped.staged, 10_000, undefined, () => {}, "test:row-cap", supervisor.location)))
      .toMatchObject({ code: 0, stdout: "cap-ok", cleanupUnverified: false });

    const marker = join(project, "altered");
    const altered = await stageDirect(`/usr/bin/touch ${quote(marker)}`, 5_000);
    writeFileSync(altered.staged.requestPath, `${readFileSync(altered.staged.requestPath, "utf8")} `);
    expect(await collectShell(startMxcShellSupervisor(altered.staged, 5_000, undefined, () => {}, "test:altered", supervisor.location)))
      .toMatchObject({ rejected: true, failure: { code: "start-refused" } });
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    ["immediate", () => { forceKillManagedChildProcesses("test quit"); }],
    ["draining", () => forceKillAndDrainManagedChildProcesses("test quit", TOOL_TIMEOUT_POLICY.mxcMacShellStopMs)],
  ] as const)("stops a live command cooperatively in the %s quit sweep and still force-kills other children", async (_name, sweep) => {
    startEgressRelayService({ ask: async () => false });
    const started = (await prepare(DETACH_WORKLOAD, { timeoutMs: 60_000 })).start("test:quit-sweep");
    const pending = collectShell(started);
    const pids = await recordedPids(project, DETACH_KINDS);
    const other = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    trackManagedChildProcess(other, { label: "test:other-child" });
    const otherExit = new Promise(resolve => other.once("exit", (_code, signal) => resolve(signal)));
    try {
      await sweep();
      await pending;
      expect(started.child.signalCode).toBeNull();
      expect(started.child.exitCode).toBe(0);
      expect(await otherExit).toBe("SIGKILL");
      await expectReaped(project, pids, DETACH_TICKS);
    } finally {
      reapRecorded(pids);
      other.kill("SIGKILL");
      __resetManagedChildProcessesForTest();
    }
  });

  it("hands the next command an idle verified standby and drops it on a sandbox status change or quit", async () => {
    startEgressRelayService({ ask: async () => false });
    expect((await run(await prepare("/usr/bin/true"))).code).toBe(0);
    const standby = await vi.waitFor(standbyPid);
    const warm = (await prepare("printf warm")).start("test:warm-standby");
    expect(warm.child.pid).toBe(standby);
    expect(await collectShell(warm)).toMatchObject({ code: 0, stdout: "warm" });

    const replacement = await vi.waitFor(() => {
      const pid = standbyPid();
      expect(pid).not.toBe(standby);
      return pid;
    });
    setActiveSandboxCapability({
      kind: "asrt", platform: "darwin", confidence: "verified", reason: "Status change",
      confines: { filesystem: true, network: true, process: true },
    });
    expect(_mxcShellStandbyPidForTest(supervisor.location)).toBeUndefined();
    await vi.waitFor(() => expect(livePids([replacement])).toEqual([]), { timeout: 5_000 });

    expect((await run(await prepare("/usr/bin/true"))).code).toBe(0);
    const idle = await vi.waitFor(standbyPid);
    try {
      await forceKillAndDrainManagedChildProcesses("test quit", 5_000);
      await vi.waitFor(() => expect(livePids([idle])).toEqual([]), { timeout: 5_000 });
      await new Promise(resolve => setImmediate(resolve));
      expect(_mxcShellStandbyPidForTest(supervisor.location)).toBeUndefined();
    } finally {
      __resetManagedChildProcessesForTest();
    }
  });

  it("refuses with integrity, and runs nothing, when a warm standby's verified library was removed or replaced", async () => {
    // A private copy of the installation: the real node modules by link, the SDK package as an APFS clone.
    const modules = join(root, "copy", "node_modules");
    mkdirSync(modules, { recursive: true });
    // The pinned packages must be real directories; the verifier refuses a linked package.
    const pinned = new Set(["@microsoft", "@koromix", "koffi", "node-pty"]);
    for (const name of readdirSync(resolve("node_modules"))) {
      if (pinned.has(name)) execFileSync("/bin/cp", ["-cR", resolve("node_modules", name), join(modules, name)]);
      else symlinkSync(resolve("node_modules", name), join(modules, name));
    }
    const location = { ...supervisor.location, nodeModules: modules };
    const library = join(modules, pins.sdk.packages["@microsoft/mxc-sdk"], pins.targets["darwin-arm64"].library.member);
    const pristine = readFileSync(library);
    const marker = join(project, "ran");
    const start = async (commandLine: string) => {
      const { staged } = await stageDirect(commandLine, 5_000);
      return collectShell(startMxcShellSupervisor(staged, 5_000, undefined, () => {}, "test:library-swap", location));
    };
    const warmStandby = async () => {
      const warmed = await start("/usr/bin/true");
      expect(warmed.code, JSON.stringify(warmed)).toBe(0);
      return vi.waitFor(() => {
        const pid = _mxcShellStandbyPidForTest(location);
        if (pid === undefined) throw new Error("No live standby");
        return pid;
      }, { timeout: 10_000 });
    };
    try {
      await warmStandby();
      rmSync(library);
      expect(await start(`printf ran > ${quote(marker)}`)).toMatchObject({ rejected: true, failure: { code: "integrity" } });
      expect(existsSync(marker)).toBe(false);

      writeFileSync(library, pristine);
      await warmStandby();
      writeFileSync(library, Buffer.concat([pristine, Buffer.from("replaced")]));
      expect(await start(`printf ran > ${quote(marker)}`)).toMatchObject({ rejected: true, failure: { code: "integrity" } });
      expect(existsSync(marker)).toBe(false);

      // Control: the same installation with its pinned bytes back runs the command.
      writeFileSync(library, pristine);
      await warmStandby();
      expect(await start(`printf ran > ${quote(marker)}`)).toMatchObject({ code: 0 });
      expect(readFileSync(marker, "utf8")).toBe("ran");
    } finally {
      dropMxcShellStandbys();
    }
  }, 60_000);

  it("records one-start latency across twenty-one product shell commands", async () => {
    startEgressRelayService({ ask: async () => false });
    const elapsed: number[] = [];
    for (let index = 0; index < 21; index++) {
      const start = performance.now();
      const exit = await run(await prepare("/usr/bin/true"));
      expect(exit.code, exit.stderr).toBe(0);
      elapsed.push(performance.now() - start);
    }
    elapsed.sort((left, right) => left - right);
    console.info("Native shell launch, 21 commands, median %s ms", elapsed.at(10)?.toFixed(1));
    // About 0.45 s a start on an M-series Mac; the macos-15 runner needs more than 1.2 s (25 s did not cover 21).
  }, 120_000);
});
