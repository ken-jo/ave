// The macOS holder boundary, natively: row 2 and the bundled-holder adapter driving the real chain (launch gate,
// /usr/bin/sandbox-exec, ready shim) and the real label helper (built by test:prepare). Every case has a control.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/container-platform.js", async (actual) => {
  const real = await actual<typeof import("../../shared/container-platform.js")>();
  // The route is switched on here, before the product switch: the plan is injected, the chain is real.
  return { ...real, isContainerHolderRouteEnabled: (platform: NodeJS.Platform) => platform === "darwin" || real.isContainerHolderRouteEnabled(platform) };
});

import { __resetManagedChildProcessesForTest } from "../../main/managed-child-processes.js";
import { __resetOfflineHolderQuarantineForTest, prepareMxcHolderStart, spawnMxcBundledHolder, spawnSeatbeltOfflineHolder, type MxcBundledHolder } from "../../sandbox/wrap-bundled-command.js";
import { spawnMxcConfinedChild } from "../confined-child.js";
import { startEgressRelayService, stopEgressRelayService } from "../egress-relay/relay.js";
import { verifyHolderSweepHelper } from "../holder-label-sweep.js";
import { MxcProcessContractError } from "../mxc-extension-errors.js";
import { currentMxcRuntimeHost, establishMxcRuntimeRoot, _forgetMxcRuntimeRootForTest } from "../mxc-runtime-root.js";
import { __resetMacExtensionPlanForTest, setMacExtensionPlan, setMacHolderCapability } from "../sandbox-capability.js";
import { __setProvenSeatbeltHolderRouteForTest } from "../seatbelt-holder-boot.js";
import { closeHeldHolderLeases, measureSeatbeltHolderLaunchers } from "../seatbelt-holder-launch.js";

const NATIVE = process.platform === "darwin" && process.arch === "arm64";
// The macOS permission job requires its cases: a macOS runner this suite cannot use fails here instead of skipping all of them.
if (process.platform === "darwin" && !NATIVE && process.env.AVE_REQUIRE_SANDBOX_CASES === "1") {
  throw new Error(`AVE_REQUIRE_SANDBOX_CASES=1 but this macOS host is ${process.arch}: the holder boundary suite runs only on arm64`);
}
const RESOURCES = resolve("resources");
const READY = { platform: "darwin", requestedBackend: "mxc", selectedBackend: "mxc", readiness: "ready", reason: "ready", egressIdentity: "shared" } as const;
const PATH = "/usr/bin:/bin";

let root: string;
let cache: string;
let data: string;
const holders: MxcBundledHolder[] = [];

async function line(stream: Readable): Promise<string> {
  return new Promise((done, fail) => {
    let text = "";
    const timer = setTimeout(() => fail(new Error(`no line; got ${JSON.stringify(text)}`)), 15_000);
    stream.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes("\n")) { clearTimeout(timer); done(text.split("\n")[0] as string); }
    });
  });
}

async function holder(script: string, over: Partial<Parameters<typeof spawnMxcBundledHolder>[0]> = {}): Promise<MxcBundledHolder> {
  const started = await spawnMxcBundledHolder({
    label: "test:holder", command: "/bin/sh", args: ["-c", script], baseEnv: { PATH }, holderEnv: {},
    allowRead: [], allowWrite: [data], ownedReadRoots: [],
    egressOwner: { kind: "worker", role: "mcp-server", pluginId: undefined, instanceId: "native-test" }, ...over,
  });
  holders.push(started);
  return started;
}

describe.runIf(NATIVE)("macOS holder boundary (native)", () => {
  beforeAll(() => {
    if (!existsSync(join(RESOURCES, "macos-holder-sweep", "arm64", "ave-holder-sweep"))) throw new Error("Run test:prepare: the holder helper is not built");
  });

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "sbhb-")));
    data = join(root, "data");
    mkdirSync(data);
    vi.stubEnv("AVE_TEST_SANDBOX_BASE", root);
    cache = currentMxcRuntimeHost().cacheHome;
    establishMxcRuntimeRoot();
    startEgressRelayService({ ask: async () => false });
    __setProvenSeatbeltHolderRouteForTest({ helper: verifyHolderSweepHelper(RESOURCES), launchers: measureSeatbeltHolderLaunchers() });
    setMacHolderCapability({ state: "ready" });
    setMacExtensionPlan(READY);
  });

  afterEach(async () => {
    await Promise.allSettled(holders.splice(0).map(started => started.release()));
    await closeHeldHolderLeases();
    __resetOfflineHolderQuarantineForTest();
    await stopEgressRelayService();
    __setProvenSeatbeltHolderRouteForTest(undefined);
    __resetMacExtensionPlanForTest();
    _forgetMxcRuntimeRootForTest(cache);
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  afterAll(() => { __resetManagedChildProcessesForTest(); });

  it("N1: starts a holder over its own pipes, in its own staging HOME, with fds 0/1/2 only", async () => {
    const started = await holder("fds=; for fd in 3 4 5 6 7 8 9; do [ -e /dev/fd/$fd ] && fds=\"$fds$fd\"; done; echo \"$HOME|$TMPDIR|fds=$fds\"; exec /bin/cat");
    expect(started.confinement).toBe("macos-seatbelt");
    const [home, temp, fds] = (await line(started.process.stdout)).split("|") as [string, string, string];
    expect(home).toMatch(/\/staging\/[0-9a-f]{32}\/home$/u);
    expect(temp).toBe(home.replace(/home$/u, "temp"));
    expect(fds).toBe("fds=");
    const echoed = line(started.process.stdout);
    started.process.stdin.write("round-trip\n");
    expect(await echoed).toBe("round-trip");
    await started.release();
    // The staging tree goes with a verified release.
    expect(existsSync(home)).toBe(false);
  });

  it("N1: 1,000 JSON-RPC round trips and one 11 MiB message arrive byte-exact", async () => {
    const started = await holder("exec /bin/cat");
    let received = Buffer.alloc(0);
    started.process.stdout.on("data", (chunk: Buffer) => { received = Buffer.concat([received, chunk]); });
    const messages = Array.from({ length: 1_000 }, (_, id) => `${JSON.stringify({ jsonrpc: "2.0", id, method: "ping" })}\n`);
    const big = `${JSON.stringify({ jsonrpc: "2.0", id: "big", params: "x".repeat(11 * 1024 * 1024) })}\n`;
    const sent = Buffer.from(messages.join("") + big);
    started.process.stdin.end(sent);
    await started.process.completion;
    expect(received.equals(sent)).toBe(true);
  });

  it("T12: refuses an executable inside a writable root, before anything starts", async () => {
    const tool = join(data, "tool.sh");
    writeFileSync(tool, "#!/bin/sh\necho ran > \"$0.ran\"\n");
    chmodSync(tool, 0o755);
    await expect(holder("", { command: tool, args: [] })).rejects.toMatchObject({ code: "executable-not-admissible" });
    expect(existsSync(`${tool}.ran`)).toBe(false);
    // Control: the same script outside every writable root starts.
    const outside = join(root, "tool.sh");
    writeFileSync(outside, "#!/bin/sh\necho ran\n");
    chmodSync(outside, 0o755);
    const started = await holder("", { command: outside, args: [] });
    expect(await line(started.process.stdout)).toBe("ran");
  });

  it("P2-2: a #!/usr/bin/env script runs the interpreter admission resolved, never one a writable PATH entry supplies", async () => {
    const good = join(root, "good");
    mkdirSync(good);
    // A copied platform binary is killed at exec; a link resolves to the system program.
    symlinkSync("/bin/echo", join(good, "interp"));
    // The impostor sits in the holder's own writable root, first on the PATH the holder receives.
    writeFileSync(join(data, "interp"), "#!/bin/sh\necho impostor\n");
    chmodSync(join(data, "interp"), 0o755);
    const script = join(root, "server.js");
    writeFileSync(script, "#!/usr/bin/env interp\n");
    chmodSync(script, 0o755);
    const started = await holder("", { command: script, args: ["--flag"], baseEnv: { PATH: good }, holderEnv: { PATH: `${data}:${good}` } });
    expect(await line(started.process.stdout)).toBe(`${script} --flag`);
  });

  it("T12: refuses a second holder nested inside a live holder's writable root, and admits a sibling", async () => {
    const first = await holder("exec /bin/cat");
    const inner = join(data, "inner");
    mkdirSync(inner);
    await expect(holder("exec /bin/cat", { allowWrite: [inner] })).rejects.toBeInstanceOf(MxcProcessContractError);
    const sibling = join(root, "sibling");
    mkdirSync(sibling);
    const second = await holder("echo up; exec /bin/cat", { allowWrite: [sibling] });
    expect(await line(second.process.stdout)).toBe("up");
    await first.release();
  });

  it("T12: refuses a start when the plan is not ready, and when the route was never proven", async () => {
    setMacExtensionPlan({ ...READY, selectedBackend: "none", readiness: "unavailable", reason: "sweep-unproven" });
    await expect(holder("true")).rejects.toThrow(/not selected|not ready/u);
    setMacExtensionPlan(READY);
    __setProvenSeatbeltHolderRouteForTest(undefined);
    await expect(holder("true")).rejects.toThrow("Extension container backend is not ready");
  });

  it("T12: a user hook runs as a holder on the proven route with extensions off; a plugin hook does not", async () => {
    setMacExtensionPlan({ ...READY, requestedBackend: "none", selectedBackend: "none", readiness: "off", reason: "not-requested" });
    const hook = await holder("echo hook; exec /bin/cat", { egressOwner: { kind: "worker", role: "hook", pluginId: undefined, instanceId: "h1" } as never });
    expect(await line(hook.process.stdout)).toBe("hook");
    await expect(holder("true", { egressOwner: { kind: "worker", role: "hook", pluginId: "p1" } as never })).rejects.toThrow(/not selected/u);
  });

  it("N2: the holder cannot read the Ave home or write outside its roots; its own data root works", async () => {
    const secret = join(root, "outside.txt");
    writeFileSync(secret, "x");
    const started = await holder(`echo ok > ${data}/own && echo own=ok; echo y > ${secret} 2>/dev/null && echo outside=written || echo outside=denied; mkdir -p ${data}/.git 2>/dev/null && echo git=made || echo git=denied; exit 0`);
    let out = "";
    started.process.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    await started.process.completion;
    expect(out).toContain("own=ok");
    expect(out).toContain("outside=denied");
    expect(out).toContain("git=denied");
    expect(readFileSync(secret, "utf8")).toBe("x");
  });

  it("N3: release ends a setsid writer, a setpgid escape, a nohup loop and a double fork; a live control holder keeps its own", async () => {
    const shapes = (base: number) => [
      `/usr/bin/perl -e 'use POSIX; POSIX::setsid(); sleep ${base}' &`,
      `set -m; /bin/sleep ${base + 1} & set +m`,
      `nohup /bin/sh -c 'while :; do /bin/sleep ${base + 2}; done' >/dev/null 2>&1 &`,
      `/bin/sh -c '/bin/sleep ${base + 3} & exit 0' &`,
      "sleep 0.3; echo up",
      "exec /bin/cat",
    ].join("\n");
    const survivors = (base: number): string[] => execFileSync("/bin/ps", ["-Ao", "command="]).toString().split("\n")
      .filter(row => [0, 1, 2, 3].some(offset => row.includes(`sleep ${base + offset}`)));
    const controlRoot = join(root, "control");
    mkdirSync(controlRoot);
    const target = await holder(shapes(3310));
    const control = await holder(shapes(3320), { allowWrite: [controlRoot] });
    expect(await line(target.process.stdout)).toBe("up");
    expect(await line(control.process.stdout)).toBe("up");
    expect(survivors(3310).length).toBeGreaterThanOrEqual(4);
    await target.release();
    await vi.waitFor(() => expect(survivors(3310)).toEqual([]), { timeout: 5_000, interval: 50 });
    expect(survivors(3320).length).toBeGreaterThanOrEqual(4);
    await control.release();
    await vi.waitFor(() => expect(survivors(3320)).toEqual([]), { timeout: 5_000, interval: 50 });
    expect(() => process.kill(target.process.id, 0)).toThrow();
  });

  it("N15: a worker under a plugin child is released with it when the parent goes first; a sibling worker's control is a fresh start", async () => {
    const parentData = join(root, "plugin-data");
    const workerData = join(root, "worker-data");
    mkdirSync(parentData);
    mkdirSync(workerData);
    const staging = prepareMxcHolderStart({ label: "plugin-child:p15", executable: "/bin/sh", baseEnv: { PATH }, allowWrite: [parentData] });
    const parent = await spawnMxcConfinedChild({
      command: "/bin/sh", args: ["-c", "echo parent; exec /bin/cat"], cwd: staging.home, home: staging.home, temp: staging.temp,
      stagingRoot: staging.root, holder: {}, label: "plugin-child:p15",
      filesystemOwnership: { readRoots: [], writeRoots: [parentData, staging.root], hostStorageRoots: [] },
      egressOwner: { kind: "worker", role: "plugin-child", pluginId: "p15" }, allowRead: [], allowWrite: [parentData, staging.root], baseEnv: { PATH },
    });
    expect(parent.confinement).toBe("macos-seatbelt");
    expect(await line(parent.process.stdout)).toBe("parent");
    const worker = await holder("echo worker; exec /bin/sleep 3315", {
      label: "worker:p15:w", egressOwner: { kind: "worker", role: "worker", pluginId: "p15", instanceId: "w" } as never,
      workerTransport: "output-only-v1", parent, allowWrite: [workerData],
    });
    expect(await line(worker.process.stdout)).toBe("worker");
    const running = (): boolean => execFileSync("/bin/ps", ["-Ao", "command="]).toString().includes("sleep 3315");
    expect(running()).toBe(true);
    await parent.release();
    await staging.release();
    // Release returns after the verified stop; poll only for the process table to catch up, bounded.
    await vi.waitFor(() => expect(running()).toBe(false), { timeout: 5_000, interval: 50 });
    await expect(worker.process.completion).resolves.toBeDefined();
    // Control: with its parent gone, a new worker under it is refused, never started unparented.
    await expect(holder("true", { label: "worker:p15:w2", egressOwner: { kind: "worker", role: "worker", pluginId: "p15", instanceId: "w2" } as never,
      workerTransport: "output-only-v1", parent, allowWrite: [workerData] })).rejects.toThrow("Extension parent backend is no longer admitted");
  });

  it("N15: the plugin child runtime, Electron as Node, starts and speaks over its pipes inside a holder", async () => {
    // The checkout is an authorized workspace, and no holder runs an executable from a workspace: run a clone of the
    // runtime's app bundle from outside it, as the packaged app runs its own.
    const bundle = process.execPath.slice(0, process.execPath.indexOf(".app/") + ".app".length);
    const clone = join(root, "runtime", bundle.slice(bundle.lastIndexOf("/") + 1));
    mkdirSync(join(root, "runtime"));
    execFileSync("/bin/cp", ["-cR", bundle, clone]);
    const started = await holder("", { command: clone + process.execPath.slice(bundle.length), args: ["-e", "process.stdin.on('data', d => process.stdout.write('node:' + d))"],
      baseEnv: { PATH, ELECTRON_RUN_AS_NODE: "1" }, holderEnv: {} });
    const echoed = line(started.process.stdout);
    started.process.stdin.write("hello\n");
    expect(await echoed).toBe("node:hello");
  });

  it("T12: refuses a start whose declared read root was retargeted after admission; the unchanged control starts", async () => {
    const [a, b] = [join(root, "read-a"), join(root, "read-b")];
    mkdirSync(a);
    mkdirSync(b);
    const start = async (swap: boolean) => {
      const link = join(root, swap ? "read-link-swapped" : "read-link");
      symlinkSync(a, link);
      const staging = prepareMxcHolderStart({ label: "test:retarget", executable: "/bin/sh", baseEnv: { PATH }, allowWrite: [data] });
      let calls = 0;
      try {
        const started = await spawnMxcConfinedChild({
          command: "/bin/sh", args: ["-c", "echo up; exec /bin/cat"], cwd: staging.home, home: staging.home, temp: staging.temp,
          stagingRoot: staging.root, holder: {}, label: "test:retarget",
          filesystemOwnership: { readRoots: [link], writeRoots: [data, staging.root], hostStorageRoots: [] },
          egressOwner: { kind: "worker", role: "plugin-child", pluginId: "retarget" }, allowRead: [link], allowWrite: [data, staging.root], baseEnv: { PATH },
          // The first call is admission's own; the second is the recheck after it.
          assertStillValid: () => {
            if (swap && ++calls === 2) { rmSync(link); symlinkSync(b, link); }
          },
        });
        await started.release();
      } finally {
        await staging.release();
      }
    };
    await expect(start(false)).resolves.toBeUndefined();
    await expect(start(true)).rejects.toThrow("Container filesystem changed after admission");
  });

  it("N12: an offline holder reaches no TCP listener and no Unix socket, writes only its staging; the host controls connect", async () => {
    const { createServer } = await import("node:net");
    const tcp = createServer(socket => socket.end()).listen(0, "127.0.0.1");
    await new Promise(r => tcp.once("listening", r));
    const port = (tcp.address() as { port: number }).port;
    const socketPath = join(root, "s.sock");
    const unix = createServer(socket => socket.end()).listen(socketPath);
    await new Promise(r => unix.once("listening", r));
    try {
      // Controls: the same probes from the host connect.
      execFileSync("/usr/bin/nc", ["-z", "-w", "2", "127.0.0.1", String(port)], { timeout: 5000 });
      execFileSync("/usr/bin/perl", ["-MIO::Socket::UNIX", "-e", "IO::Socket::UNIX->new(Peer => $ARGV[0]) or exit 1", socketPath], { timeout: 5000 });
      const probe = [
        `/usr/bin/nc -z -w 2 127.0.0.1 ${port} 2>/dev/null && echo tcp-open || echo tcp-refused`,
        `/usr/bin/perl -MIO::Socket::UNIX -e 'IO::Socket::UNIX->new(Peer => $ARGV[0]) or exit 1' '${socketPath}' 2>/dev/null && echo unix-open || echo unix-refused`,
        `(echo x > "$HOME/ok" && echo home-written) || echo home-refused`,
        `(echo x > '${join(data, "offline")}' 2>/dev/null && echo data-written) || echo data-refused`,
      ].join("; ");
      const started = await spawnSeatbeltOfflineHolder({ label: "test:offline", command: "/bin/sh", args: ["-c", probe], baseEnv: { PATH } });
      try {
        const out: string[] = [];
        started.process.stdout.on("data", (chunk: Buffer) => out.push(chunk.toString()));
        await started.process.completion;
        // Completion waits for the output tail; poll bounded rather than assume a fixed delay.
        await vi.waitFor(() => expect(out.join("").trim().split("\n")).toEqual(["tcp-refused", "unix-refused", "home-written", "data-refused"]),
          { timeout: 5_000, interval: 25 });
      } finally {
        await started.release();
      }
    } finally {
      tcp.close();
      unix.close();
    }
  });

  it("L-O1: a session holder binds and connects only in its one 0700 socket directory, and writes only its root", async () => {
    const { createServer } = await import("node:net");
    const session = join(root, "session");
    const output = join(session, "output");
    const ipc = join(output, "ipc");
    const input = join(session, "input");
    mkdirSync(ipc, { recursive: true, mode: 0o700 });
    chmodSync(ipc, 0o700);
    mkdirSync(input);
    // A host socket in the same write root but outside the socket directory, and one elsewhere: both stay unreachable.
    const beside = join(output, "beside.sock");
    const elsewhere = join(root, "elsewhere.sock");
    const servers = [createServer(socket => socket.end()).listen(beside), createServer(socket => socket.end()).listen(elsewhere)];
    await Promise.all(servers.map(server => new Promise(r => server.once("listening", r))));
    const perlConnect = (path: string) => `/usr/bin/perl -MIO::Socket::UNIX -e 'IO::Socket::UNIX->new(Peer => $ARGV[0]) or exit 1' '${path}' 2>/dev/null`;
    const pipe = join(ipc, "OSL_PIPE_test");
    const serve = `/usr/bin/perl -MIO::Socket::UNIX -e 'my $s = IO::Socket::UNIX->new(Local => $ARGV[0], Listen => 1) or exit 3; print "bound\\n"; $| = 1; my $c = $s->accept; print scalar <$c>' '${pipe}'`;
    const sessionOf = { writeRoot: output, runtimeReads: [], socketDirectory: ipc };
    try {
      for (const path of [beside, elsewhere]) execFileSync("/usr/bin/perl", ["-MIO::Socket::UNIX", "-e", "IO::Socket::UNIX->new(Peer => $ARGV[0]) or exit 1", path], { timeout: 5000 });
      const server = await spawnSeatbeltOfflineHolder({ label: "test:engine-a", command: "/bin/sh", args: ["-c", serve], baseEnv: { PATH }, session: sessionOf });
      const client = [
        `${perlConnect(beside)} && echo beside-open || echo beside-refused`,
        `${perlConnect(elsewhere)} && echo elsewhere-open || echo elsewhere-refused`,
        `/usr/bin/perl -MIO::Socket::UNIX -e 'my $c = IO::Socket::UNIX->new(Peer => $ARGV[0]) or exit 1; print $c "hello\\n"' '${pipe}' && echo pipe-open || echo pipe-refused`,
        `(echo x > "$HOME/ok" && echo home-written) || echo home-refused`,
        `(echo x > '${join(input, "x")}' 2>/dev/null && echo input-written) || echo input-refused`,
      ].join("; ");
      try {
        expect(await line(server.process.stdout)).toBe("bound");
        const received = line(server.process.stdout);
        const started = await spawnSeatbeltOfflineHolder({ label: "test:engine-b", command: "/bin/sh", args: ["-c", client], baseEnv: { PATH }, session: sessionOf });
        try {
          const out: string[] = [];
          started.process.stdout.on("data", (chunk: Buffer) => out.push(chunk.toString()));
          await started.process.completion;
          await vi.waitFor(() => expect(out.join("").trim().split("\n")).toEqual(["beside-refused", "elsewhere-refused", "pipe-open", "home-written", "input-refused"]),
            { timeout: 5_000, interval: 25 });
          expect(await received).toBe("hello");
          expect(readFileSync(join(output, "ok"), "utf8")).toBe("x\n");
        } finally {
          await started.release();
        }
      } finally {
        await server.release();
      }
    } finally {
      for (const server of servers) server.close();
    }
  });

  it("L-O1: a session's socket directory must be a private 0700 directory inside its write root", async () => {
    const output = join(root, "out2");
    const open = join(output, "ipc");
    mkdirSync(open, { recursive: true });
    chmodSync(open, 0o755);
    await expect(spawnSeatbeltOfflineHolder({ label: "test:engine-c", command: "/usr/bin/true", args: [], baseEnv: { PATH },
      session: { writeRoot: output, runtimeReads: [], socketDirectory: open } })).rejects.toThrow("private 0700 directory");
    const outside = join(root, "ipc-outside");
    mkdirSync(outside, { mode: 0o700 });
    await expect(spawnSeatbeltOfflineHolder({ label: "test:engine-c", command: "/usr/bin/true", args: [], baseEnv: { PATH },
      session: { writeRoot: output, runtimeReads: [], socketDirectory: outside } })).rejects.toThrow("private 0700 directory");
    // Control: the same directory made private starts.
    chmodSync(open, 0o700);
    const started = await spawnSeatbeltOfflineHolder({ label: "test:engine-c", command: "/usr/bin/true", args: [], baseEnv: { PATH },
      session: { writeRoot: output, runtimeReads: [], socketDirectory: open } });
    await started.process.completion;
    await started.release();
  });

  /** A write root of its own: two live holders may not share one. */
  function own(name: string): { allowWrite: string[] } {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    return { allowWrite: [dir] };
  }

  async function output(started: MxcBundledHolder): Promise<string> {
    const out: string[] = [];
    started.process.stdout.on("data", (chunk: Buffer) => out.push(chunk.toString()));
    started.process.stderr.on("data", (chunk: Buffer) => out.push(chunk.toString()));
    await started.process.completion;
    // Completion waits for the output tail; poll bounded rather than assume a fixed delay.
    let last = "";
    await vi.waitFor(() => { const now = out.join(""); expect(now.includes("done") || now === last).toBe(true); last = now; }, { timeout: 5_000, interval: 50 });
    return out.join("");
  }

  it("N8/N9: through its lease a holder reaches an allowed host; a direct connect, another holder's proxy and a reserved Tailnet port are refused", async () => {
    const { createServer } = await import("node:net");
    const { createServer: createHttpServer } = await import("node:http");
    const { reserveTailnetListenerPort } = await import("../../shared/tailnet-listener-port.js");
    const listen = (server: { listen(port: number, host: string, cb: () => void): unknown; address(): unknown }) =>
      new Promise<number>(done => server.listen(0, "127.0.0.1", () => done((server.address() as { port: number }).port)));
    const hits: string[] = [];
    const upstream = createHttpServer((req, res) => { hits.push(req.url ?? ""); res.end("relay-control"); });
    const upstreamPort = await listen(upstream);
    let direct = 0;
    const plain = createServer(socket => { direct++; socket.destroy(); });
    const plainPort = await listen(plain);
    let tailnetHits = 0;
    const tailnet = createServer(socket => { tailnetHits++; socket.destroy(); });
    const tailnetPort = await listen(tailnet);
    const releaseTailnet = reserveTailnetListenerPort(tailnetPort);
    const asked: string[] = [];
    await stopEgressRelayService();
    startEgressRelayService({
      ask: async (destination) => { asked.push(`${destination.host}:${destination.port}`); return destination.host === "allowed.example"; },
      resolve: async () => [{ address: "93.184.215.14" }],
      router: async () => ({ routes: [{ kind: "http", host: "127.0.0.1", port: upstreamPort, resolvesNames: true }] }),
    });
    try {
      // Holder A only keeps its lease (and so its proxy port) open.
      const a = await holder('printf "%s\\n" "$HTTP_PROXY"; exec /bin/sleep 30', { ...own("a"), egressOwner: { kind: "worker", role: "mcp-server", pluginId: undefined, instanceId: "native-a" } });
      const aProxy = (await line(a.process.stdout)).replace(/^http:\/\/[^@/]*@/u, "http://");
      expect(aProxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      const probe = [
        "set -u",
        `/usr/bin/curl -fsS --max-time 5 http://allowed.example:${upstreamPort + 1}/ok && echo " allowed-ok" || echo allowed-refused`,
        `/usr/bin/curl -fsS --max-time 5 http://denied.example:${upstreamPort + 1}/no >/dev/null 2>&1 && echo denied-open || echo denied-refused`,
        `/usr/bin/nc -z -w 2 127.0.0.1 ${plainPort} 2>/dev/null && echo direct-open || echo direct-refused`,
        `/usr/bin/curl -fsS --noproxy '' -x ${aProxy} --max-time 5 http://allowed.example:${upstreamPort + 1}/borrowed >/dev/null 2>&1 && echo borrowed-open || echo borrowed-refused`,
        `/usr/bin/nc -z -w 2 127.0.0.1 ${tailnetPort} 2>/dev/null && echo tailnet-open || echo tailnet-refused`,
        `/usr/bin/curl -fsS --max-time 5 http://tailnet-check.example:${tailnetPort}/ >/dev/null 2>&1 && echo tailnet-name-open || echo tailnet-name-refused`,
        "echo done",
      ].join("\n");
      const b = await holder(probe, { ...own("b"), egressOwner: { kind: "worker", role: "mcp-server", pluginId: undefined, instanceId: "native-b" } });
      const text = await output(b);
      expect(text, text).toContain("relay-control allowed-ok");
      for (const refused of ["denied-refused", "direct-refused", "borrowed-refused", "tailnet-refused", "tailnet-name-refused"]) expect(text, text).toContain(refused);
      // Controls: the host reaches the same listeners.
      execFileSync("/usr/bin/nc", ["-z", "-w", "2", "127.0.0.1", String(plainPort)], { timeout: 5000 });
      expect(hits).toEqual([`http://allowed.example:${upstreamPort + 1}/ok`]);
      await vi.waitFor(() => expect(direct).toBe(1), { timeout: 5_000, interval: 25 });
      expect(tailnetHits).toBe(0);
      expect(asked.some(entry => entry.endsWith(`:${tailnetPort}`))).toBe(false);
    } finally {
      releaseTailnet();
      for (const server of [upstream, plain, tailnet]) server.close();
    }
  }, 60_000);

  it("N17: a holder cannot have launchd or Launch Services start a program; the host can", async () => {
    const marker = join(root, "n17-launchd");
    const label = `dev.ave.test.n17.${process.pid}`;
    const probe = [
      `/bin/launchctl submit -l ${label} -- /usr/bin/touch '${marker}' 2>/dev/null && echo submit-ok || echo submit-refused`,
      `/usr/bin/open -g -j -a /System/Applications/Calculator.app 2>/dev/null && echo open-ok || echo open-refused`,
      "echo done",
    ].join("\n");
    try {
      const text = await output(await holder(probe));
      expect(text, text).toContain("submit-refused");
      expect(text, text).toContain("open-refused");
      await new Promise(resolve => setTimeout(resolve, 1_000));
      expect(existsSync(marker)).toBe(false);
      // Control: the same submit from the host runs the job.
      execFileSync("/bin/launchctl", ["submit", "-l", label, "--", "/usr/bin/touch", marker]);
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 10_000, interval: 100 });
    } finally {
      try { execFileSync("/bin/launchctl", ["remove", label]); } catch { /* not loaded */ }
    }
  }, 30_000);

  it("N19: a holder cannot exec setuid programs; the host can", async () => {
    const probe = [
      "for p in /usr/bin/su /bin/ps /usr/bin/top; do",
      '  err=$("$p" -h 2>&1 </dev/null >/dev/null); code=$?',
      '  case "$err" in *"Operation not permitted"*) echo "$p refused";; *) echo "$p ran $code";; esac',
      "done",
      "echo done",
    ].join("\n");
    const text = await output(await holder(probe));
    expect(text, text).toContain("/usr/bin/su refused");
    expect(text, text).toContain("/bin/ps refused");
    expect(text, text).toContain("/usr/bin/top refused");
    // Control: the host runs ps.
    expect(execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "pid="], { encoding: "utf8" }).trim()).toBe(String(process.pid));
  }, 30_000);

  it("N21: a holder cannot signal another holder; it can signal its own child", async () => {
    const victim = await holder("exec /bin/sleep 30", own("victim"));
    const probe = [
      `kill -9 ${victim.process.id} 2>/dev/null && echo other-killed || echo other-refused`,
      "/bin/sleep 30 & child=$!",
      'kill -9 "$child" 2>/dev/null && echo own-killed || echo own-refused',
      "echo done",
    ].join("\n");
    const text = await output(await holder(probe, own("attacker")));
    expect(text, text).toContain("other-refused");
    expect(text, text).toContain("own-killed");
    // The victim still runs.
    expect(() => process.kill(victim.process.id, 0)).not.toThrow();
  }, 30_000);

  it("N6: a plugin hook runs as a holder through the hook runner: stdin JSON in, its verdict out, a timeout that leaves nothing", async () => {
    const { runOneHookScript } = await import("../../hooks/script-hook-runner.js");
    const generationRoot = join(root, "generation");
    const dataDir = join(root, "hookdata");
    mkdirSync(generationRoot); mkdirSync(dataDir);
    const verdict = join(generationRoot, "verdict.sh");
    writeFileSync(verdict, '#!/bin/sh\nread -r line\ncase "$line" in *read_file*) printf \'{"action":"deny","reason":"saw read_file"}\';; *) printf \'{"action":"allow"}\';; esac\n');
    const pidFile = join(dataDir, "escaped.pid");
    const stuck = join(generationRoot, "stuck.sh");
    writeFileSync(stuck, `#!/bin/sh\n/usr/bin/perl -e 'use POSIX; POSIX::setsid(); exec "/bin/sleep", "59"' & echo $! > '${pidFile}'\nexec /bin/sleep 59\n`);
    chmodSync(verdict, 0o755); chmodSync(stuck, 0o755);
    const payload = { hookType: "pre", event: "pre", toolName: "read_file", source: "builtin", category: "read", input: {},
      sessionId: "native-hook", trustOrigin: "user-keyboard" } as const;
    const hook = (script: string, timeoutMs?: number) => ({ id: `hook-${script.length}`, hookType: "pre" as const, source: "config" as const,
      hookPath: script, command: ["/bin/sh", script], configDir: generationRoot, fileDependencies: [script],
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      confinement: { kind: "bundled" as const, pluginId: "native-hook-plugin", dataDir, generationRoot } });
    const decided = await runOneHookScript(hook(verdict), payload as never, { cwd: dataDir });
    expect(decided.decision, decided.reason).toBe("deny");
    expect(decided.reason).toContain("saw read_file");
    const timedOut = await runOneHookScript(hook(stuck, 1_500), payload as never, { cwd: dataDir });
    expect(timedOut.decision).toBe("deny");
    expect(timedOut.reason).toMatch(/time/iu);
    const escaped = Number(readFileSync(pidFile, "utf8").trim());
    expect(Number.isInteger(escaped) && escaped > 0).toBe(true);
    // The holder's stop swept its label: the setsid escape is gone.
    await vi.waitFor(() => expect(() => process.kill(escaped, 0)).toThrow(), { timeout: 5_000, interval: 50 });
  }, 60_000);

  it("N5b: the watcher killed while two holders run: it comes back, both still stop verified, a new start works", async () => {
    const { startHolderWatcher } = await import("../seatbelt-holder-boot.js");
    const watcher = startHolderWatcher(verifyHolderSweepHelper(RESOURCES), { respawnMinMs: 200 });
    try {
      const write = (name: string) => { const dir = join(root, name); mkdirSync(dir); return { allowWrite: [dir] }; };
      const a = await holder("exec /bin/cat", write("a"));
      const b = await holder("exec /bin/cat", write("b"));
      await vi.waitFor(() => expect(watcher.pid()).toBeGreaterThan(0), { timeout: 5_000, interval: 25 });
      const first = watcher.pid() ?? 0;
      process.kill(first, "SIGKILL");
      await vi.waitFor(() => expect(watcher.pid() ?? first).not.toBe(first), { timeout: 5_000, interval: 25 });
      expect(watcher.available()).toBe(true);
      for (const started of [a, b]) {
        const echoed = line(started.process.stdout);
        started.process.stdin.write("alive\n");
        expect(await echoed).toBe("alive");
      }
      // A verified stop removes the staging tree; a quarantined one would refuse the next start.
      await a.release();
      await b.release();
      const next = await holder("echo next; exec /bin/cat", write("c"));
      expect(await line(next.process.stdout)).toBe("next");
      await next.release();
    } finally {
      expect(await watcher.stop()).toBe(true);
    }
  }, 30_000);

  it("N13: a kernel-refused start runs nothing and leaves no staging tree", async () => {
    const staging = join(cache, "ai.agent-connector.ave", "mxc-runtime", "staging");
    const before = existsSync(staging) ? readdirSync(staging).length : 0;
    // A NUL in an argument is refused by the builder before any spawn.
    await expect(holder("true", { args: ["-c", "true\0"] })).rejects.toThrow();
    expect(existsSync(staging) ? readdirSync(staging).length : 0).toBe(before);
  });
});
