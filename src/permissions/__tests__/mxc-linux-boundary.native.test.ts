import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer, type Server } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";
import { containerTarget } from "../../shared/container-platform.js";
import { createContainedShellLifecycle } from "../../tools/contained-shell-lifecycle.js";
import { prepareMxcPosixShellLaunch } from "../../tools/mxc-posix-shell-launch.js";
import { openEgressInvocation } from "../egress-invocations.js";
import { startEgressRelayService, stopEgressRelayService } from "../egress-relay/relay.js";
import { launcherPathFor, pinnedLauncherSha256 } from "../mxc-launcher.js";
import { detectHostMxcLinuxShellSupport } from "../mxc-linux.js";
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
  });

  afterEach(async () => {
    const failures = (await Promise.all(leases.map(lease => lease.dispose()))).flat();
    await stopEgressRelayService();
    for (const server of servers) server.close();
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
    const { child, completion } = launch.start("test:linux-shell-boundary");
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

  it("proves the detected launcher and its pin natively", async () => {
    const target = containerTarget(process.platform, process.arch);
    const launcher = launcherPathFor(resources.resourcePath, process.platform, process.arch);
    if (target === undefined || launcher === undefined) throw new Error("Native launcher target is unavailable");
    expect(createHash("sha256").update(readFileSync(launcher)).digest("hex")).toBe(pinnedLauncherSha256(target));
    expect(await detectHostMxcLinuxShellSupport(resources)).toEqual({ state: "available" });
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
for endpoint in (('127.0.0.1', ${hostPort}), ('10.0.2.2', ${hostPort}), ('192.0.2.1', 443)):
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
    const { child, completion } = launch.start("test:linux-shell-boundary");
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
