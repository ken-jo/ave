import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer, type Server } from "node:net";
import { networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";
import { containerTarget } from "../../shared/container-platform.js";
import { createContainedShellLifecycle } from "../../tools/contained-shell-lifecycle.js";
import { hostShellGrantAuthorizer } from "../../tools/host-shell-control-channel.js";
import { prepareMxcPosixShellLaunch } from "../../tools/mxc-posix-shell-launch.js";
import { openEgressInvocation } from "../egress-invocations.js";
import { startEgressRelayService, stopEgressRelayService } from "../egress-relay/relay.js";
import { launcherPathFor, pinnedLauncherSha256 } from "../mxc-launcher.js";
import { _runLinuxCanaryForTest as runCanary, buildBubblewrapShellRequest, detectHostMxcLinuxShellSupport, requireMxcLinuxShellPrograms } from "../mxc-linux.js";
import { LINUX_RAW_IP_PROBER, primaryIpv4 } from "../mxc-linux-raw-ip.js";
import { startMxcLinuxShell } from "../../sandbox/linux-container-shell.js";
import { openInvocationProxyListener } from "../egress-invocation-listener.js";
import { posixPolicyLookups, rankPosixContainerRows } from "../mxc-posix.js";
import { buildPolicyModel, policyGrantRow } from "../policy-model.js";
import { _forgetMxcRuntimeRootForTest, currentMxcRuntimeHost, establishMxcRuntimeRoot, requireMxcContainerStartRoot } from "../mxc-runtime-root.js";
import { __resetActiveSandboxCapabilityForTest, __resetContainerShellSubstrateForTest, __resetSandboxRequestedAtBootForTest,
  setActiveSandboxCapability, setContainerShellSubstrate, setShellSandboxRequestedAtBoot } from "../sandbox-capability.js";
import { quoteSandboxWrappedWord as quote } from "../sandbox-wrapped-command.js";

const NATIVE = process.env.AVE_RUN_MXC_LINUX_BOUNDARY === "1";

describe.runIf(NATIVE)("native Linux shell container boundary", () => {
  let root: string;
  let work: string;
  let home: string;
  let cache: string;
  let leases: ReturnType<typeof createContainedShellLifecycle>[];
  let servers: Server[];
  let sockets: UdpSocket[];
  const resources = { resourcePath: resolve("resources"), isPackaged: false };

  beforeEach(() => {
    expect(process.platform).toBe("linux");
    root = mkdtempSync("/tmp/ave-linux-boundary-");
    work = join(root, "work");
    home = join(root, "home");
    mkdirSync(work);
    mkdirSync(home);
    vi.stubEnv("AVE_TEST_SANDBOX_BASE", root);
    cache = currentMxcRuntimeHost().cacheHome;
    establishMxcRuntimeRoot();
    configureHostResources(resources);
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({ kind: "asrt", platform: "linux", confidence: "verified", reason: "Test relay",
      confines: { filesystem: true, process: true, network: true } });
    setContainerShellSubstrate("linux", { state: "available" });
    leases = [];
    servers = [];
    sockets = [];
  });

  afterEach(async () => {
    const failures = (await Promise.all(leases.map(lease => lease.dispose()))).flat();
    await stopEgressRelayService();
    for (const server of servers) server.close();
    for (const socket of sockets) socket.close();
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
    __resetContainerShellSubstrateForTest();
    _forgetMxcRuntimeRootForTest(cache);
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
    expect(failures).toEqual([]);
  });

  async function prepare(commandLine: string, options: {
    readonly allowRead?: readonly string[]; readonly allowWrite?: readonly string[]; readonly denyRead?: readonly string[];
    readonly env?: Readonly<Record<string, string>>; readonly timeoutMs?: number;
  } = {}) {
    const lease = createContainedShellLifecycle();
    leases.push(lease);
    const invocation = openEgressInvocation({ kind: "shell", toolName: "bash", toolUseId: undefined, requiresListener: true,
      context: { approvalSurface: "unavailable", sessionId: undefined, workspaceRoot: work } });
    lease.onRevoke(invocation.release);
    const launch = await prepareMxcPosixShellLaunch({
      commandLine, egressToken: invocation.token, cwd: work,
      allowRead: options.allowRead ?? [], allowWrite: options.allowWrite ?? [work, home],
      denyRead: options.denyRead ?? [], floorPierces: [], timeoutMs: options.timeoutMs ?? 12_000,
      env: { HOME: home, TMPDIR: home, PATH: "/usr/local/bin:/usr/bin:/bin", ...options.env },
    }, lease);
    return { launch, lease };
  }

  function run(launch: Awaited<ReturnType<typeof prepare>>["launch"]) {
    const { child, completion } = launch.start("test:linux-shell-boundary", hostShellGrantAuthorizer(undefined));
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
    child.stderr.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
    return completion.then(exit => ({ ...exit, stdout, stderr }));
  }

  async function listen(server: Server, path?: string): Promise<number> {
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      if (path === undefined) server.listen(0, "127.0.0.1", resolve);
      else server.listen(path, resolve);
    });
    const address = server.address();
    return address === null || typeof address === "string" ? 0 : address.port;
  }

  async function listenOn(server: Server, host: string): Promise<number> {
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Invalid native listener");
    return address.port;
  }

  async function bindUdp(host: string, onMessage: (data: Buffer) => void): Promise<{ readonly port: number }> {
    const socket: UdpSocket = createSocket("udp4");
    sockets.push(socket);
    socket.on("message", onMessage);
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, host, resolve);
    });
    return { port: socket.address().port };
  }

  async function sendTcp(host: string, port: number, line: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = connect(port, host, () => socket.end(`${line}\n`, resolve));
      socket.once("error", reject);
    });
  }

  it("proves the detected launcher and its pin natively", async () => {
    const target = containerTarget(process.platform, process.arch);
    const launcher = launcherPathFor(resources.resourcePath, process.platform, process.arch);
    if (target === undefined || launcher === undefined) throw new Error("Native launcher target is unavailable");
    expect(createHash("sha256").update(readFileSync(launcher)).digest("hex")).toBe(pinnedLauncherSha256(target));
    expect(await detectHostMxcLinuxShellSupport(resources)).toMatchObject({
      state: "available", rawIpProbe: { rawIp: "blocked", evidenceKind: "arrival", reachableTargets: [] },
    });
  });

  it("ranks nested scopes, protects existing and absent names and keeps ordinary writes", async () => {
    startEgressRelayService({ ask: async () => false });
    const sealed = join(work, "sealed");
    const open = join(sealed, "open");
    const deep = join(open, "locked");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(sealed, "secret"), "hidden");
    writeFileSync(join(deep, "secret"), "hidden again");
    mkdirSync(join(work, ".git", "hooks"), { recursive: true });
    writeFileSync(join(work, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(work, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
    const { launch } = await prepare([
      "set -eu", "test -d /sys", "test ! -d /run/user", "test -w \"$HOME\"", "test -w \"$TMPDIR\"",
      "if touch /tmp/should-stay-readonly; then exit 31; fi",
      "if cat sealed/secret; then exit 32; fi", "printf open > sealed/open/control",
      "if cat sealed/open/locked/secret; then exit 33; fi", "if touch sealed/open/locked/new; then exit 34; fi",
      "if mv -T .git renamed; then exit 35; fi", "if touch .git/hooks/new; then exit 36; fi",
      "if touch .vscode/tasks.json; then exit 37; fi", "if mv -T .ave moved; then exit 38; fi",
      "printf sibling > .ave/ordinary", "mkdir folder && mv folder ordinary", "printf ordinary > ordinary/control",
      "python3 -c 'import json; print(json.dumps(open(\"/proc/1/cmdline\", \"rb\").read().decode().split(\"\\0\")))'",
    ].join("\n"), { allowWrite: [work, home, open], denyRead: [sealed, deep] });
    const result = await run(launch);
    expect(result.code, result.stderr).toBe(0);
    const argv = JSON.parse(result.stdout) as string[];
    expect(argv).toEqual(expect.arrayContaining(["--unshare-net", "--unshare-pid", "--seccomp", "--die-with-parent", "--remount-ro"]));
    expect(argv.indexOf(work)).toBeLessThan(argv.indexOf(join(work, ".ave")));
    expect(readFileSync(join(open, "control"), "utf8")).toBe("open");
    expect(readFileSync(join(work, ".ave", "ordinary"), "utf8")).toBe("sibling");
    expect(readFileSync(join(work, "ordinary", "control"), "utf8")).toBe("ordinary");
    expect(existsSync(join(work, ".vscode"))).toBe(false);
    expect(existsSync(join(work, ".ave", "commands"))).toBe(false);
  });

  it("keeps overlapping placeholder owners until the final shell exits", async () => {
    startEgressRelayService({ ask: async () => false });
    const first = await prepare("touch a-ready; while test ! -e release-a; do sleep 0.02; done");
    const firstRun = run(first.launch);
    await vi.waitFor(() => expect(existsSync(join(work, "a-ready"))).toBe(true));
    const second = await prepare("touch b-ready; while test ! -e release-b; do sleep 0.02; done; ! touch .vscode/tasks.json");
    const secondRun = run(second.launch);
    await vi.waitFor(() => expect(existsSync(join(work, "b-ready"))).toBe(true));
    writeFileSync(join(work, "release-a"), "");
    expect(await firstRun).toMatchObject({ code: 0 });
    expect(existsSync(join(work, ".vscode"))).toBe(true);
    writeFileSync(join(work, "release-b"), "");
    const result = await secondRun;
    expect(result.code, result.stderr).toBe(0);
    expect(existsSync(join(work, ".vscode"))).toBe(false);
    expect(existsSync(join(work, ".ave"))).toBe(false);
  });

  it("blocks host sockets and nested namespaces and retains Unix socket pairs and own loopback", async () => {
    startEgressRelayService({ ask: async () => false });
    let connections = 0;
    const socket = join(work, "u");
    await listen(createServer(connection => { connections++; connection.destroy(); }), socket);
    const hostPort = await listen(createServer(connection => { connections++; connection.destroy(); }));
    const program = `
import errno, os, socket
assert os.environ['NO_PROXY'] == 'localhost,127.0.0.1,::1'
assert os.environ['no_proxy'] == os.environ['NO_PROXY']
for family in (socket.AF_UNIX, socket.AF_VSOCK):
    try: socket.socket(family)
    except OSError as e: assert e.errno == errno.EPERM
    else: raise AssertionError('restricted socket family')
a, b = socket.socketpair(); a.send(b'own'); assert b.recv(3) == b'own'
listener = socket.socket(); listener.bind(('127.0.0.1', 0)); listener.listen()
client = socket.create_connection(listener.getsockname(), .5); peer, _ = listener.accept()
client.send(b'local'); assert peer.recv(5) == b'local'
for endpoint in (('127.0.0.1', ${hostPort}), ('10.0.2.2', ${hostPort})):
    try: socket.create_connection(endpoint, .25)
    except OSError: pass
    else: raise AssertionError('direct TCP connection')
print('socket-controls')
`;
    const { launch } = await prepare(`set -e\npython3 -c ${quote(program)}\n! unshare -Ur /bin/true`);
    const result = await run(launch);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe("socket-controls\n");
    expect(connections).toBe(0);
  });

  it("refuses raw IP that an unconfined process delivers to the host's own addresses, over TCP, UDP and IPv6", async () => {
    startEgressRelayService({ ask: async () => false });
    const address4 = primaryIpv4();
    if (address4 === undefined) throw new Error("The native raw-IP control needs a non-loopback IPv4 address");
    const address6 = Object.values(networkInterfaces()).flat()
      .find(entry => entry?.family === "IPv6" && !entry.internal && !entry.address.startsWith("fe80"))?.address;
    const arrived = new Set<string>();
    const record = (data: Buffer) => { for (const line of data.toString("utf8").split("\n")) if (line) arrived.add(line); };
    const tcp4 = await listenOn(createServer(socket => socket.on("data", record)), address4);
    const tcp6 = address6 === undefined ? undefined : await listenOn(createServer(socket => socket.on("data", record)), address6);
    const udp = await bindUdp(address4, record);
    const nonce = randomBytes(8).toString("hex");
    // Positive control: the same endpoints accept an unconfined process.
    await sendTcp(address4, tcp4, `unconfined-tcp4-${nonce}`);
    if (tcp6 !== undefined && address6 !== undefined) await sendTcp(address6, tcp6, `unconfined-tcp6-${nonce}`);
    await new Promise<void>((resolve, reject) => {
      const sender = createSocket("udp4");
      sender.send(`unconfined-udp-${nonce}`, udp.port, address4, error => { sender.close(); if (error) reject(error); else resolve(); });
    });
    await vi.waitFor(() => expect(arrived).toEqual(new Set([`unconfined-tcp4-${nonce}`, `unconfined-udp-${nonce}`,
      ...(tcp6 === undefined ? [] : [`unconfined-tcp6-${nonce}`])])));
    const program = `
import socket
def tcp(family, address, message):
    try: s = socket.create_connection(address, 1.5)
    except OSError: return 'refused'
    s.sendall(message.encode() + b'\\n'); return 'connected'
def udp(address, message):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try: s.sendto(message.encode(), address)
    except OSError: return 'refused'
    return 'sent'
print(tcp(socket.AF_INET, ('${address4}', ${tcp4}), 'confined-tcp4-${nonce}'))
print(udp(('${address4}', ${udp.port}), 'confined-udp-${nonce}'))
print(tcp(socket.AF_INET6, ('2001:db8::1', 443), 'confined-doc6-${nonce}'))
${address6 === undefined ? "print('refused')" : `print(tcp(socket.AF_INET6, ('${address6}', ${tcp6}), 'confined-tcp6-${nonce}'))`}
`;
    const { launch } = await prepare(`python3 -c ${quote(program)}`);
    const result = await run(launch);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe("refused\nrefused\nrefused\nrefused\n");
    await new Promise(resolve => setTimeout(resolve, 500));
    expect([...arrived].filter(line => line.startsWith("confined-"))).toEqual([]);
  });

  it("measures raw IP at the boot canary as blocked by arrival evidence on this dropping backend", async () => {
    const programs = await requireMxcLinuxShellPrograms(resources);
    // This backend drops a direct connect rather than refusing it. The arrival listener took the unconfined control and
    // nothing from the container, the netns holds lo and tap0, and the launcher's firewall drops egress.
    expect(await runCanary(requireMxcContainerStartRoot(), programs)).toMatchObject({
      state: "available", rawIpProbe: { rawIp: "blocked", evidenceKind: "arrival", reachableTargets: [], udpArrival: "absent" },
    });
  });

  it("reports an arrival at the host-side TCP listener during the run as unknown, raw-ip-reachable", async () => {
    const programs = await requireMxcLinuxShellPrograms(resources);
    let forced = false;
    const duringRun = async ({ address, port }: { readonly address: string; readonly port: number }) => {
      await new Promise<void>((resolve, reject) => {
        const socket = connect({ host: address, port }, () => { forced = true; socket.destroy(); resolve(); });
        socket.once("error", reject);
      });
    };
    expect(await runCanary(requireMxcContainerStartRoot(), programs, undefined, { duringRun })).toMatchObject({
      state: "available", rawIpProbe: { rawIp: "unknown", reason: "raw-ip-reachable", reachableTargets: ["ta"] },
    });
    expect(forced).toBe(true);
  });

  it("keeps the container available, with raw IP unknown, when the host-side listeners cannot bind", async () => {
    const programs = await requireMxcLinuxShellPrograms(resources);
    // A documentation address is never local, so every host-side listener fails to bind.
    expect(await runCanary(requireMxcContainerStartRoot(), programs, undefined, { hostAddress: "192.0.2.55" })).toMatchObject({
      state: "available", rawIpProbe: { rawIp: "unknown", reason: "no-evidence" },
    });
  });

  it("is unknown, not blocked, when the real prober sends no datagram", async () => {
    const programs = await requireMxcLinuxShellPrograms(resources);
    const send = '  datagram "/dev/udp/$host/$udp" & pids="$pids $!"\n';
    expect(LINUX_RAW_IP_PROBER).toContain(send);
    // Every TCP target still runs, so only the missing UDP measurement stands between this run and `blocked`.
    expect(await runCanary(requireMxcContainerStartRoot(), programs, undefined, { prober: LINUX_RAW_IP_PROBER.replace(send, "") }))
      .toMatchObject({ state: "available", rawIpProbe: { rawIp: "unknown", reason: "udp-unmeasured", udpArrival: "unmeasured" } });
  });

  it("does not take a prober's printed refusals without the host recording the control nonce", async () => {
    const programs = await requireMxcLinuxShellPrograms(resources);
    const forged = ["C status=403 refused=loopback destination", "T4 Operation not permitted", "T6 Operation not permitted",
      "TL Operation not permitted", "UA Operation not permitted", "IF lo"].map(line => `printf '%s\\n' ${quote(line)}`).join("\n");
    expect(await runCanary(requireMxcContainerStartRoot(), programs, undefined, { prober: forged })).toMatchObject({
      state: "available", rawIpProbe: { rawIp: "unknown", reason: "control-failed" },
    });
  });

  it("keeps the container available when the raw-IP prober stalls", async () => {
    const programs = await requireMxcLinuxShellPrograms(resources);
    const started = Date.now();
    expect(await runCanary(requireMxcContainerStartRoot(), programs, undefined, { prober: "sleep 600" })).toMatchObject({
      state: "available", rawIpProbe: { rawIp: "unknown", reason: "no-evidence" },
    });
    expect(Date.now() - started).toBeLessThan(5_000 + 12_000 + 2_000);
  }, 30_000);

  // Every process whose command line holds `text`: `/proc/<pid>/cmdline` is readable by any local user.
  function commandLinesHolding(text: string): string[] {
    return readdirSync("/proc").filter(entry => /^\d+$/u.test(entry)).flatMap((pid) => {
      try {
        const words = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        return words.includes(text) ? [`${pid}:${words.split("\0")[0]}`] : [];
      } catch { return []; }
    });
  }

  it("keeps a shell's environment off every process command line, while the shell still sees it", async () => {
    const secret = `ave-cmdline-secret-${randomBytes(8).toString("hex")}`;
    // Positive control: the scan sees a value that is on a live process's command line.
    const control = spawn("/bin/sh", ["-c", "sleep 30", `${secret}-control`], { stdio: "ignore" });
    try {
      await vi.waitFor(() => expect(commandLinesHolding(`${secret}-control`)).toHaveLength(1), { timeout: 5_000, interval: 50 });
    } finally {
      control.kill("SIGKILL");
    }
    startEgressRelayService({ ask: async () => false });
    const { launch } = await prepare(`printf '%s' "$AVE_TEST_TOKEN" > seen-token; sleep 3`, { env: { AVE_TEST_TOKEN: secret } });
    const pending = run(launch);
    await vi.waitFor(() => expect(existsSync(join(work, "seen-token"))).toBe(true), { timeout: 10_000, interval: 50 });
    const holders = commandLinesHolding(secret);
    const result = await pending;
    expect(holders).toEqual([]);
    expect(result.code, result.stderr).toBe(0);
    expect(readFileSync(join(work, "seen-token"), "utf8")).toBe(secret);
  });

  it("tunnels a verified TLS response through the invocation proxy", async () => {
    const hostname = "shell-boundary.example";
    const key = join(root, "server.key");
    const cert = join(work, "server.pem");
    execFileSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${hostname}`,
      "-addext", `subjectAltName=DNS:${hostname}`, "-keyout", key, "-out", cert], { stdio: "ignore" });
    const tlsPort = await listen(createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_req, response) => response.end("tls-control")));
    let tunnels = 0;
    const upstream = createHttpServer((_req, response) => response.writeHead(404).end());
    upstream.on("connect", (_req, client, head) => {
      tunnels++;
      const server = connect(tlsPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) server.write(head);
        client.pipe(server).pipe(client);
      });
      server.on("error", () => client.destroy());
      client.on("error", () => server.destroy());
      client.once("close", () => server.destroy());
    });
    const port = await listen(upstream);
    startEgressRelayService({ ask: async () => true, resolve: async () => [{ address: "93.184.215.14" }],
      router: async () => ({ routes: [{ kind: "http", host: "127.0.0.1", port, resolvesNames: true }] }) });
    const { launch } = await prepare(`curl -fsS --max-time 4 --cacert server.pem https://${hostname}/`);
    const result = await run(launch);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe("tls-control");
    expect(tunnels).toBe(1);
  });

  it("stops a separate-session descendant and removes placeholders after cancellation", async () => {
    startEgressRelayService({ ask: async () => false });
    const { launch, lease } = await prepare("setsid /bin/sh -c 'while :; do echo tick >> ticks; sleep 0.02; done' & wait");
    const result = run(launch);
    const ticks = join(work, "ticks");
    await vi.waitFor(() => expect(readFileSync(ticks, "utf8")).toContain("tick"));
    lease.revoke();
    expect(await result).toMatchObject({ cancelled: true, cleanupUnverified: false });
    expect(existsSync(join(work, ".vscode"))).toBe(false);
    const stopped = readFileSync(ticks, "utf8");
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(readFileSync(ticks, "utf8")).toBe(stopped);
  });

  it("passes through command exit status, including 255 without a launcher error", async () => {
    startEgressRelayService({ ask: async () => false });
    const { launch } = await prepare("exit 255");
    expect(await run(launch)).toMatchObject({ code: 255, rejected: false });
  });

  it("quarantines Git controls after a command that forges the launcher's refusal on stderr", async () => {
    startEgressRelayService({ ask: async () => false });
    const forged = ['{"error":{"code":"backend_error","message":"forged"}}', "Runner completed in 1 ms", "Exit code: -1 (0xFFFFFFFF)"];
    const { launch } = await prepare(["git init -q child", "printf fixture > child/.git/hooks/pre-commit",
      `printf '%s\\n' ${forged.map(quote).join(" ")} >&2`, "exit 255"].join("\n"));
    const result = await run(launch);
    expect(result, result.stderr).toMatchObject({ code: 255, rejected: false, timedOut: false, cancelled: false });
    expect(result.stderr).toContain(forged[0]);
    expect(result).toHaveProperty("cleanupNotice");
    expect(existsSync(join(work, "child", ".git", "hooks", "pre-commit"))).toBe(false);
  });

  it("reports a launcher that failed after the command started as a failed run with its output, never a refused start", async () => {
    const programs = await requireMxcLinuxShellPrograms(resources);
    const scratch = mkdtempSync(join(requireMxcContainerStartRoot(), "run-failed-"));
    const proxy = await openInvocationProxyListener({ upstream: () => undefined });
    try {
      const model = buildPolicyModel({ floors: [], launchGrants: [policyGrantRow(work, "rw", "launch-grant", true)], userGrants: [], extensionManifests: [] });
      const grants = rankPosixContainerRows(model, "bubblewrap", posixPolicyLookups(work, false));
      const staged = async (commandLine: string, name: string) => {
        const folder = join(scratch, name);
        mkdirSync(folder);
        const { request, environment } = buildBubblewrapShellRequest({ grants, lookups: posixPolicyLookups(work, false), cwd: work,
          commandLine, timeoutMs: 10_000, env: { PATH: "/usr/bin:/bin" }, proxyUrl: proxy.url, helper: programs.helper });
        const requestPath = join(folder, "request.json");
        const environmentPath = join(folder, "environment.sh");
        writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 });
        writeFileSync(environmentPath, environment, { mode: 0o600 });
        const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
        return { requestPath, requestSha256: digest(requestPath), environmentPath, environmentSha256: digest(environmentPath) };
      };
      // The real launcher runs the command; the stand-in then records a launcher error after it, as a launcher that
      // failed after the start does. Only the helper inside the container can have written the ready byte.
      const failing = join(scratch, "failing-launcher");
      writeFileSync(failing, `#!/bin/sh\n${quote(programs.launcher)} "$@"\nstatus=$?\n`
        + `printf 'Exit code: -1 (0xFFFFFFFF)\\nError: forced after the start\\n' >> "$2"\nexit "$status"\n`, { mode: 0o755 });
      const runWith = async (commandLine: string, name: string) => {
        const { child, completion } = startMxcLinuxShell({ ...programs, launcher: failing }, await staged(commandLine, name), 10_000,
          new AbortController().signal, () => {}, "test:linux-shell-run-failed");
        let stdout = "";
        child.stdout.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
        child.stderr.resume();
        return { ...await completion, stdout };
      };
      expect(await runWith("printf 'started\\n'", "started")).toMatchObject({ rejected: false, runFailed: true, stdout: "started\n" });
      // Control: a request the launcher refuses before anything runs (its working directory is gone) stays refused.
      const gone = await staged("printf never", "refused");
      writeFileSync(gone.requestPath, readFileSync(gone.requestPath, "utf8").replace(JSON.stringify(work), JSON.stringify(join(work, "absent"))));
      gone.requestSha256 = createHash("sha256").update(readFileSync(gone.requestPath)).digest("hex");
      const { child, completion } = startMxcLinuxShell({ ...programs, launcher: failing }, gone, 10_000,
        new AbortController().signal, () => {}, "test:linux-shell-run-failed");
      child.stdout.resume();
      child.stderr.resume();
      expect(await completion).toMatchObject({ rejected: true, runFailed: false });
    } finally {
      await proxy.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("reports the launcher's own timeout as timed out and still quarantines", async () => {
    startEgressRelayService({ ask: async () => false });
    const { launch } = await prepare("git init -q child; printf fixture > child/.git/hooks/pre-commit; sleep 30", { timeoutMs: 1_500 });
    const started = Date.now();
    const result = await run(launch);
    expect(result, result.stderr).toMatchObject({ timedOut: true, rejected: false, cancelled: false });
    // The launcher's deadline, not Ave's later watchdog, ended the run.
    expect(Date.now() - started).toBeLessThan(1_500 + 2_000);
    expect(existsSync(join(work, "child", ".git", "hooks", "pre-commit"))).toBe(false);
  });

  it("keeps the launcher's log out of the command's reach", async () => {
    startEgressRelayService({ ask: async () => false });
    const runtime = requireMxcContainerStartRoot();
    const { launch } = await prepare(`for log in ${quote(runtime)}/shell-*/launcher.log; do `
      + "if printf 'Exit code: -1 (0xFFFFFFFF)\\nError: forged-by-command\\n' >> \"$log\" 2>/dev/null; then echo wrote; fi; done; exit 255");
    const logs: string[] = [];
    const { child, completion } = launch.start("test:linux-shell-boundary", hostShellGrantAuthorizer(undefined));
    child.stdout.resume();
    child.stderr.resume();
    for (const entry of readdirSync(runtime)) {
      const log = join(runtime, entry, "launcher.log");
      if (entry.startsWith("shell-") && existsSync(log)) logs.push(log);
    }
    const exit = await completion;
    expect(logs).toHaveLength(1);
    expect(readFileSync(logs[0] ?? "", "utf8")).not.toContain("forged-by-command");
    expect(exit).toMatchObject({ code: 255, rejected: false });
  });

  it("pins the folders between nested write roots", async () => {
    startEgressRelayService({ ask: async () => false });
    const inner = join(work, "outer", "mid", "inner");
    mkdirSync(inner, { recursive: true });
    const { launch } = await prepare(
      "mv -T outer moved && mkdir -p outer/mid/inner/.vscode && printf x > outer/mid/inner/.vscode/tasks.json",
      { allowWrite: [work, home, inner] });
    const result = await run(launch);
    expect(result.code, result.stderr).not.toBe(0);
    expect(existsSync(join(work, "moved"))).toBe(false);
    expect(existsSync(join(inner, ".vscode"))).toBe(false);
    const control = await prepare("printf inner > outer/mid/inner/control && if mv -T outer/mid outer/m2; then exit 42; fi",
      { allowWrite: [work, home, inner] });
    const controlResult = await run(control.launch);
    expect(controlResult.code, controlResult.stderr).toBe(0);
    expect(readFileSync(join(inner, "control"), "utf8")).toBe("inner");
  });

  it.each([["outside every write root", false], ["inside the work root", true]])(
    "keeps a protected name that is a symlink to a folder %s", async (_label, insideWork) => {
      startEgressRelayService({ ask: async () => false });
      const target = insideWork ? join(work, "editor-settings") : join(root, "editor-settings");
      mkdirSync(target);
      symlinkSync(target, join(work, ".vscode"));
      const { launch } = await prepare("rm .vscode && mkdir .vscode && printf x > .vscode/tasks.json");
      // A bind mount cannot hold a link's own entry, so the write policy withholds the root that could replace it.
      expect(launch.narrowedWriteRoots).toContainEqual({ root: work, reason: "routing-link" });
      const result = await run(launch);
      expect(result.code, result.stderr).not.toBe(0);
      expect(lstatSync(join(work, ".vscode")).isSymbolicLink()).toBe(true);
      expect(existsSync(join(target, "tasks.json"))).toBe(false);
    });

  it("quarantines Git controls created during a command before releasing the work root", async () => {
    startEgressRelayService({ ask: async () => false });
    const { launch } = await prepare("set -e; git init -q child; printf fixture > child/.git/hooks/pre-commit; printf editable > child/control");
    const result = await run(launch);
    expect(result.code, result.stderr).toBe(0);
    expect(result).toHaveProperty("cleanupNotice");
    expect(existsSync(join(work, "child", ".git", "hooks", "pre-commit"))).toBe(false);
    expect(readFileSync(join(work, "child", "control"), "utf8")).toBe("editable");
  });
});
