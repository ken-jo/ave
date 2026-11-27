import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer, type Server } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";
import { createContainedShellLifecycle } from "../../tools/contained-shell-lifecycle.js";
import { prepareMxcPosixShellLaunch } from "../../tools/mxc-posix-shell-launch.js";
import { quoteSandboxWrappedWord as quote } from "../sandbox-wrapped-command.js";
import { openEgressInvocation } from "../egress-invocations.js";
import { startEgressRelayService, stopEgressRelayService, type EgressRelayServiceOptions } from "../egress-relay/relay.js";
import { currentMxcRuntimeHost, establishMxcRuntimeRoot, _forgetMxcRuntimeRootForTest } from "../mxc-runtime-root.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, setActiveSandboxCapability,
  setContainerShellSubstrate, setShellSandboxRequestedAtBoot } from "../sandbox-capability.js";
import { buildSafeChildEnv } from "../../tools/safe-env.js";
import { launcherPathFor, pinnedLauncherSha256, resolveHostLauncherPath } from "../mxc-launcher.js";
import { _runSeatbeltCanaryForTest, buildSeatbeltShellRequest } from "../mxc-macos.js";
import { posixPolicyLookups } from "../mxc-posix.js";
import { buildPolicyModel, policyFloorRow, policyGrantRow, type PolicyModel } from "../policy-model.js";

describe.runIf(process.platform === "darwin" && process.arch === "arm64")("native macOS shell boundary", () => {
  let root: string;
  let work: string;

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "sb-")));
    work = join(root, "work");
    mkdirSync(work);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function launch(commandLine: string, timeoutMs: number, model: PolicyModel, cwd = work) {
    const launcher = launcherPathFor(resolve("resources"), "darwin", "arm64");
    if (launcher === undefined) throw new Error("macOS launcher path is missing");
    const config = join(root, "launcher.json");
    const { request } = buildSeatbeltShellRequest({
      model, cwd, commandLine, timeoutMs, lookups: posixPolicyLookups(root, true),
      env: { HOME: root, PATH: "/usr/bin:/bin" }, proxyUrl: "http://127.0.0.1:1",
    });
    writeFileSync(config, JSON.stringify(request), { mode: 0o600 });
    return spawnSync(launcher, ["--config", config], {
      stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env: buildSafeChildEnv(), timeout: 8_000,
    });
  }

  it("carves around a denied sibling and refuses protected moves and new pattern matches", () => {
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
    const result = launch([
      `test "$(cat '${open}/control')" = readable || exit 11`,
      `if cat '${secret}'; then exit 12; fi`,
      `if stat '${secret}'; then exit 16; fi`,
      "mkdir ordinary && echo ok > ordinary/good || exit 13",
      "if (echo denied > ordinary/new.locked); then exit 14; fi",
      "if mv control renamed; then exit 15; fi",
    ].join("\n"), 3_000, model);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).not.toContain("private fixture");
    expect(existsSync(protectedChild)).toBe(true);
    expect(existsSync(join(work, "ordinary", "new.locked"))).toBe(false);
    expect(readFileSync(join(work, "ordinary", "good"), "utf8").trim()).toBe("ok");
  });

  it("keeps both admitted children readable through nested carves and both denied scopes closed", () => {
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
    const result = launch([
      `cat '${project}/file' || exit 11`,
      `cat '${child}/file' || exit 12`,
      `if cat '${outer}/file'; then exit 13; fi`,
      `if cat '${inner}/file'; then exit 14; fi`,
    ].join("\n"), 3_000, model);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("reaps the shell, a background child and a setsid descendant on the backend timeout under an override", () => {
    const model = buildPolicyModel({
      floors: [], userGrants: [], extensionManifests: [],
      launchGrants: [policyGrantRow(work, "rw", "launch-grant", true)],
    });
    const result = launch([
      "echo $$ > shell.pid",
      "sleep 8 & echo $! > child.pid",
      `/usr/bin/perl -MPOSIX -e 'POSIX::setsid() >= 0 or die $!; open(my $pid, ">", "detached.pid") or die $!; print $pid $$; close($pid); sleep 8' &`,
      "wait",
    ].join("\n"), 1_200, model);
    expect(result.signal).toBeNull();
    expect(result.status, result.stdout + result.stderr).toBe(255);
    for (const name of ["shell", "child", "detached"]) {
      const pid = Number(readFileSync(join(work, `${name}.pid`), "utf8").trim());
      expect(pid).toBeGreaterThan(1);
      expect(() => process.kill(pid, 0), name).toThrow(expect.objectContaining({ code: "ESRCH" }));
    }
  });

  it("proves the boot canary against the installed launcher and cleans its staging", async () => {
    const launcher = launcherPathFor(resolve("resources"), "darwin", "arm64");
    if (launcher === undefined) throw new Error("macOS launcher path is missing");
    await expect(_runSeatbeltCanaryForTest(launcher, root)).resolves.toBe("available");
    expect(readdirSync(root)).toEqual(["work"]);
  });

  it("waits for the canary child to exit before tearing down on abort", async () => {
    const launcher = launcherPathFor(resolve("resources"), "darwin", "arm64");
    if (launcher === undefined) throw new Error("macOS launcher path is missing");
    const wrapper = join(work, "abort-probe");
    writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = "--debug" ]; then exit 91; fi
if [ "$1" = "--config" ]; then
  /usr/bin/perl -MJSON::PP -0777 -i -pe 'my $request=decode_json($_); $request->{process}{commandLine}=q{echo $$ > child.pid; /bin/sleep 1; exit 0}; $_=encode_json($request)' "$2" || exit 1
fi
exec "${launcher}" "$@"
`, { mode: 0o700 });

    const controller = new AbortController();
    const reason = new Error("Canary cancelled");
    const outcome = _runSeatbeltCanaryForTest(wrapper, root, controller.signal).catch((error: unknown) => error);
    const childPid = await vi.waitFor(() => {
      const staging = readdirSync(root).find(name => name.startsWith("p-"));
      if (staging === undefined) throw new Error("Canary staging has not started");
      const pid = Number(readFileSync(join(root, staging, "w", "child.pid"), "utf8"));
      expect(pid).toBeGreaterThan(1);
      return pid;
    }, { interval: 10, timeout: 3_000 });
    controller.abort(reason);
    const result = await outcome;
    expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    expect(readdirSync(root)).toEqual(["work"]);
    expect(result).toBe(reason);
  });
});

// Change this receipt only after running the native boundary suite against the new launcher.
const VERIFIED_LAUNCHER = "4c68a4ff34ed14134a94a4312a8ec172bd2099dd26453e4a7893d91515f42687";
it("requires new macOS boundary evidence when the launcher pin changes", () => {
  expect(pinnedLauncherSha256("darwin-arm64")).toBe(VERIFIED_LAUNCHER);
});

describe.runIf(process.platform === "darwin" && process.arch === "arm64")("native product shell launch", () => {
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
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
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
  } = {}) {
    const lease = createContainedShellLifecycle();
    leases.push(lease);
    const egress = openEgressInvocation({
      kind: "shell", toolName: "bash", toolUseId: undefined, requiresListener: true,
      context: { approvalSurface: "unavailable", sessionId: undefined, workspaceRoot: project },
    }, options.signal ? { abortSignal: options.signal } : {});
    lease.onRevoke(egress.release);
    return prepareMxcPosixShellLaunch({
      egressToken: egress.token, commandLine, timeoutMs: 10_000,
      cwd: options.cwd ?? project, allowRead: options.allowRead ?? [], allowWrite: options.allowWrite ?? [project],
      denyRead: options.denyRead ?? [], floorPierces: [],
      env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", ...options.env },
    }, lease);
  }

  async function run(launch: Awaited<ReturnType<typeof prepare>>) {
    const { child, completion } = launch.start("test:native-posix-shell");
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", data => { stdout += data; });
    child.stderr.setEncoding("utf8").on("data", data => { stderr += data; });
    return { ...await completion, stdout, stderr };
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

  it("cancels a live launch after a setsid descendant starts and waits for all its children", async () => {
    startEgressRelayService({ ask: async () => false });
    const controller = new AbortController();
    const launch = await prepare([
      "echo $$ > shell.pid",
      `/bin/sh -c ${quote(`echo denied > ${quote(join(root, "outside"))}`)} && exit 40`,
      "sleep 20 & echo $! > child.pid",
      "exec 3>&-",
      '/usr/bin/perl -MPOSIX -e \'POSIX::setsid() >= 0 or die $!; open(my $pid, ">", "detached.pid") or die $!; print $pid $$; close($pid); sleep 20\' &',
      "wait",
    ].join("\n"), { signal: controller.signal });
    const completion = run(launch);
    const pids = await vi.waitFor(() => ["shell", "child", "detached"].map(name => {
      const pid = Number(readFileSync(join(project, `${name}.pid`), "utf8").trim());
      expect(pid).toBeGreaterThan(1);
      expect(() => process.kill(pid, 0)).not.toThrow();
      return pid;
    }), { interval: 15, timeout: 3_000 });
    const session = execFileSync("/bin/ps", ["-o", "pid=,pgid=", "-p", String(pids[2])], { encoding: "utf8" }).trim().split(/\s+/u);
    expect(session.map(Number)).toEqual([pids[2], pids[2]]);
    controller.abort();
    const outcome = await completion;
    expect(outcome).toMatchObject({ code: 255, cancelled: true, timedOut: false });
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    expect(existsSync(join(root, "outside"))).toBe(false);
    expect(await leases[0]?.dispose()).toEqual([]);
  });

  it("checks the installed launcher bytes and refuses a changed or missing launcher", async () => {
    startEgressRelayService({ ask: async () => false });
    const installed = (await resolveHostLauncherPath("darwin-arm64")).path;
    expect(createHash("sha256").update(readFileSync(installed)).digest("hex")).toBe(VERIFIED_LAUNCHER);
    const resourcePath = join(root, "resources");
    const copied = launcherPathFor(resourcePath, "darwin", "arm64");
    if (copied === undefined) throw new Error("No launcher path for the verification fixture");
    mkdirSync(dirname(copied), { recursive: true });
    writeFileSync(copied, readFileSync(installed), { mode: 0o700 });
    await resolveHostLauncherPath("darwin-arm64", resourcePath);
    configureHostResources({ resourcePath, isPackaged: false });
    const launch = await prepare("echo unexpected");
    writeFileSync(copied, "changed");
    expect(() => launch.start("test:changed-launcher")).toThrow("Verified container launcher changed");
    rmSync(copied);
    await expect(prepare("echo unexpected")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads a new command grant without restarting the relay", async () => {
    startEgressRelayService({ ask: async () => false });
    const sealed = join(home, "seal");
    const offered = join(sealed, "file");
    mkdirSync(sealed);
    writeFileSync(offered, "new access");
    const check = `cat ${quote(offered)}`;
    const denied = await run(await prepare(check, { denyRead: [sealed] }));
    expect(denied.code).not.toBe(0);
    const admitted = await run(await prepare(check, { denyRead: [sealed], allowRead: [offered] }));
    expect(admitted.stdout).toBe("new access");
    expect(admitted.code).toBe(0);
  });

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

  it("records one-start latency across twenty product shell commands", async () => {
    startEgressRelayService({ ask: async () => false });
    const elapsed: number[] = [];
    for (let index = 0; index < 20; index++) {
      const start = performance.now();
      const exit = await run(await prepare("/usr/bin/true"));
      expect(exit.code, exit.stderr).toBe(0);
      elapsed.push(performance.now() - start);
    }
    elapsed.sort((left, right) => left - right);
    const median = elapsed.slice(9, 11).reduce((sum, sample) => sum + sample, 0) / 2;
    console.info("Native shell launch, 20 commands, median %s ms", median.toFixed(1));
  }, 25_000);
});
