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

  it("T12: a #! script replaced after admission refuses the start, as its interpreter would (rv13 P3-2)", async () => {
    const scripts = join(root, "scripts");
    mkdirSync(scripts);
    // The last two calls of the adapter check are the recheck before native creation and the one after the start; the
    // control run counts them, and the swap run replaces the script at that recheck, after the launch was measured.
    let controlCalls = 0;
    const start = async (swapAt: number | undefined) => {
      const name = swapAt === undefined ? "kept" : "swapped";
      const script = join(scripts, `${name}.sh`);
      writeFileSync(script, "#!/bin/sh\necho up\nexec /bin/cat\n");
      chmodSync(script, 0o755);
      const write = join(root, `write-${name}`);
      mkdirSync(write);
      let calls = 0;
      const started = await holder("", { command: script, args: [], allowWrite: [write],
        assertStillValid: () => {
          calls += 1;
          if (swapAt === undefined) controlCalls = calls;
          else if (calls === swapAt) { rmSync(script); writeFileSync(script, "#!/bin/sh\necho swapped\nexec /bin/cat\n"); chmodSync(script, 0o755); }
        } });
      return line(started.process.stdout);
    };
    await expect(start(undefined)).resolves.toBe("up");
    expect(controlCalls).toBeGreaterThan(2);
    await expect(start(controlCalls - 1)).rejects.toThrow("Container executable changed after admission");
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
      // The relay did ask (for the denied host), so its silence about the Tailnet port is a refusal, not a relay that never asks.
      expect(asked.some(entry => entry.startsWith("denied.example:")), JSON.stringify(asked)).toBe(true);
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

  // Fable P3-5 on #761: the two cross-principal properties the wrapped-route suite proves on Linux, named here for the
  // holder route. Each holder's staging HOME and temp are its own; the floor rows keep every other one out of reach.
  it("N22: a holder cannot read another holder's temp files or its sandbox HOME; it reads its own, and the host reads both", async () => {
    const victim = await holder("echo victim-temp > \"$TMPDIR/secret\" && echo victim-home > \"$HOME/secret\" && echo \"$HOME|$TMPDIR\"; exec /bin/cat", own("victim"));
    const [victimHome, victimTemp] = (await line(victim.process.stdout)).split("|") as [string, string];
    // Control: the files exist and are readable to a process outside every holder.
    expect(readFileSync(join(victimTemp, "secret"), "utf8")).toBe("victim-temp\n");
    expect(readFileSync(join(victimHome, "secret"), "utf8")).toBe("victim-home\n");
    const probe = [
      `cat ${join(victimTemp, "secret")} 2>/dev/null && echo other-temp=read || echo other-temp=denied`,
      `cat ${join(victimHome, "secret")} 2>/dev/null && echo other-home=read || echo other-home=denied`,
      `ls ${victimHome} >/dev/null 2>&1 && echo other-home-list=read || echo other-home-list=denied`,
      // Control: the same reads of its own staging work.
      'echo mine > "$TMPDIR/secret" && cat "$TMPDIR/secret" >/dev/null && echo own-temp=read || echo own-temp=denied',
      'echo mine > "$HOME/secret" && cat "$HOME/secret" >/dev/null && echo own-home=read || echo own-home=denied',
      "echo done",
    ].join("\n");
    const text = await output(await holder(probe, own("attacker")));
    expect(text, text).toContain("other-temp=denied");
    expect(text, text).toContain("other-home=denied");
    expect(text, text).toContain("other-home-list=denied");
    expect(text, text).toContain("own-temp=read");
    expect(text, text).toContain("own-home=read");
    expect(text, text).not.toContain("victim-");
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
    writeFileSync(stuck, `#!/bin/sh\n/usr/bin/perl -e 'use POSIX; POSIX::setsid(); exec "/bin/sleep", "57"' & echo $! > '${pidFile}'\nexec /bin/sleep 57\n`);
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

  // N5: a stand-in host proves the route (the real boot check, boot sweep and watcher), starts two holders, one with a
  // setsid escape, and is killed with SIGKILL. The watcher's sweep ends the escape. Control: without the watcher it lives.
  it.each([["the watcher", true, false], ["no watcher (control)", false, false], ["the watcher killed once first (N5c)", true, true]] as const)("N5: a host killed with SIGKILL, %s", async (_name, watcher, killWatcherFirst) => {
    const { spawnSacrificialHost } = await import("../../__tests__/support/sacrificial-host.js");
    const report = join(root, `n5-${String(watcher)}.json`);
    // The stand-in host's own Ave home (its instance lock and boot sweep scope) and its own runtime base.
    const hostHome = join(root, "n5-home");
    const hostBase = join(root, "n5-base");
    mkdirSync(hostHome, { mode: 0o700 }); mkdirSync(hostBase, { mode: 0o700 });
    const source = `
      const [wrap, boot, launch, capability, runtime, relay, sweep, lock, resources, report, watcher] = process.argv.slice(1);
      const { writeFileSync } = await import("node:fs");
      const { establishMxcRuntimeRoot } = await import(runtime);
      const { startEgressRelayService } = await import(relay);
      const { setMacExtensionPlan, setMacHolderCapability } = await import(capability);
      const { spawnMxcBundledHolder } = await import(wrap);
      establishMxcRuntimeRoot();
      startEgressRelayService({ ask: async () => false });
      if (watcher === "true") {
        await (await import(lock)).acquireHostInstanceLock();
        const { startSeatbeltHolderBootServices } = await import(boot);
        await startSeatbeltHolderBootServices({ resourcePath: resources, home: process.env.AVE_HOME, publish: () => {} });
      } else {
        const { __setProvenSeatbeltHolderRouteForTest } = await import(boot);
        const { verifyHolderSweepHelper } = await import(sweep);
        const { measureSeatbeltHolderLaunchers } = await import(launch);
        __setProvenSeatbeltHolderRouteForTest({ helper: verifyHolderSweepHelper(resources), launchers: measureSeatbeltHolderLaunchers() });
      }
      setMacHolderCapability({ state: "ready" });
      setMacExtensionPlan({ platform: "darwin", requestedBackend: "mxc", selectedBackend: "mxc", readiness: "ready", reason: "ready", egressIdentity: "shared" });
      const pids = [];
      for (const [name, script] of [["plain", "exec /bin/sleep 57"], ["escape", "/usr/bin/perl -e 'use POSIX; POSIX::setsid(); exec \\"/bin/sleep\\", \\"57\\"' & echo $!; exec /bin/sleep 57"]]) {
        const write = report + "-" + name;
        (await import("node:fs")).mkdirSync(write);
        const started = await spawnMxcBundledHolder({ label: "test:n5-" + name, command: "/bin/sh", args: ["-c", script], baseEnv: { PATH: "/usr/bin:/bin" },
          holderEnv: {}, allowRead: [], allowWrite: [write], ownedReadRoots: [], egressOwner: { kind: "worker", role: "mcp-server", pluginId: undefined, instanceId: "n5-" + name } });
        pids.push(started.process.id);
        if (name === "escape") pids.push(await new Promise(done => started.process.stdout.once("data", chunk => done(Number(String(chunk).trim())))));
      }
      writeFileSync(report, JSON.stringify(pids));
      setInterval(() => {}, 1000);
    `;
    const mod = (path: string) => resolve(path);
    const host = spawnSacrificialHost(source, [mod("src/sandbox/wrap-bundled-command.ts"), mod("src/permissions/seatbelt-holder-boot.ts"),
      mod("src/permissions/seatbelt-holder-launch.ts"), mod("src/permissions/sandbox-capability.ts"), mod("src/permissions/mxc-runtime-root.ts"),
      mod("src/permissions/egress-relay/relay.ts"), mod("src/permissions/holder-label-sweep.ts"), mod("src/main/host-instance-lock.ts"),
      RESOURCES, report, String(watcher)],
      // A spawned process has no test seam: its own HOME keeps its runtime root (under HOME's cache) out of the account's.
      { HOME: hostBase, AVE_HOME: hostHome, AVE_TEST_MXC_RUNTIME_ROOT: "null" });
    let pids: number[] = [];
    try {
      await vi.waitFor(() => { pids = JSON.parse(readFileSync(report, "utf8")) as number[]; }, { timeout: 30_000, interval: 100 });
      const escaped = pids[2];
      if (escaped === undefined) throw new Error("the escape's pid was not reported");
      expect(() => process.kill(escaped, 0)).not.toThrow();
      if (killWatcherFirst) {
        // The host's watcher is its helper in watch mode; kill it, and the host keeps one running again within 2 s.
        const watchers = () => execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n")
          .map(row => row.trim().split(/\s+/u)).filter(([, ppid, command, mode]) => Number(ppid) === host.pid && command?.endsWith("ave-holder-sweep") && mode === "watch")
          .map(([pid]) => Number(pid));
        const [first] = watchers();
        if (first === undefined) throw new Error("the host's watcher is not running");
        process.kill(first, "SIGKILL");
        await vi.waitFor(() => expect(watchers().filter(pid => pid !== first)).toHaveLength(1), { timeout: 2_000, interval: 50 });
        // Both holders kept running.
        for (const pid of pids) expect(() => process.kill(pid, 0)).not.toThrow();
      }
      host.kill("SIGKILL");
      if (watcher) {
        await vi.waitFor(() => expect(() => process.kill(escaped, 0)).toThrow(), { timeout: 5_000, interval: 50 });
        for (const pid of pids) await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5_000, interval: 50 });
      } else {
        await new Promise(done => setTimeout(done, 2_000));
        expect(() => process.kill(escaped, 0)).not.toThrow();
      }
    } finally {
      host.kill("SIGKILL");
      for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
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

  // N18: the boot sweep is scoped to the instance's own Ave home. Stand-in hosts, each with its own home and HOME.
  it("N18: one host's boot sweep leaves another home's holder alone; the same home cannot get the lock; a later run of the same home sweeps its leftover", async () => {
    const { spawnSacrificialHost } = await import("../../__tests__/support/sacrificial-host.js");
    const source = `
      const [lock, wrap, boot, launch, capability, runtime, relay, sweep, resources, report, mode] = process.argv.slice(1);
      const { writeFileSync, mkdirSync } = await import("node:fs");
      try { await (await import(lock)).acquireHostInstanceLock(); }
      catch (error) { writeFileSync(report, JSON.stringify({ lock: "refused", code: error.code ?? error.name })); process.exit(0); }
      const { verifyHolderSweepHelper } = await import(sweep);
      if (mode === "sweep") {
        const { runHolderBootSweep } = await import(boot);
        writeFileSync(report, JSON.stringify({ swept: await runHolderBootSweep(verifyHolderSweepHelper(resources), process.env.AVE_HOME) }));
        process.exit(0);
      }
      (await import(runtime)).establishMxcRuntimeRoot();
      (await import(relay)).startEgressRelayService({ ask: async () => false });
      (await import(boot)).__setProvenSeatbeltHolderRouteForTest({ helper: verifyHolderSweepHelper(resources), launchers: (await import(launch)).measureSeatbeltHolderLaunchers() });
      const { setMacExtensionPlan, setMacHolderCapability } = await import(capability);
      setMacHolderCapability({ state: "ready" });
      setMacExtensionPlan({ platform: "darwin", requestedBackend: "mxc", selectedBackend: "mxc", readiness: "ready", reason: "ready", egressIdentity: "shared" });
      const write = report + "-write"; mkdirSync(write);
      const started = await (await import(wrap)).spawnMxcBundledHolder({ label: "test:n18", command: "/bin/sleep", args: ["57"], baseEnv: { PATH: "/usr/bin:/bin" },
        holderEnv: {}, allowRead: [], allowWrite: [write], ownedReadRoots: [], egressOwner: { kind: "worker", role: "mcp-server", pluginId: undefined, instanceId: "n18" } });
      writeFileSync(report, JSON.stringify({ pid: started.process.id }));
      setInterval(() => {}, 1000);
    `;
    const mod = (path: string) => resolve(path);
    const modules = [mod("src/main/host-instance-lock.ts"), mod("src/sandbox/wrap-bundled-command.ts"), mod("src/permissions/seatbelt-holder-boot.ts"),
      mod("src/permissions/seatbelt-holder-launch.ts"), mod("src/permissions/sandbox-capability.ts"), mod("src/permissions/mxc-runtime-root.ts"),
      mod("src/permissions/egress-relay/relay.ts"), mod("src/permissions/holder-label-sweep.ts"), RESOURCES];
    const homes = { a: join(root, "home-a"), b: join(root, "home-b") };
    for (const dir of Object.values(homes)) mkdirSync(dir, { mode: 0o700 });
    let run = 0;
    const host = (home: string, mode: "holder" | "sweep") => {
      const name = `n18-${++run}`;
      const base = join(root, `${name}-base`);
      mkdirSync(base, { mode: 0o700 });
      const report = join(root, `${name}.json`);
      const child = spawnSacrificialHost(source, [...modules, report, mode], { HOME: base, AVE_HOME: home, AVE_TEST_MXC_RUNTIME_ROOT: "null" });
      const result = async () => { let value: Record<string, unknown> = {}; await vi.waitFor(() => { value = JSON.parse(readFileSync(report, "utf8")); }, { timeout: 30_000, interval: 100 }); return value; };
      return { child, result };
    };
    const hosts: ReturnType<typeof host>[] = [];
    const pids: number[] = [];
    try {
      const a = host(homes.a, "holder"); hosts.push(a);
      const aPid = (await a.result()).pid as number;
      pids.push(aPid);
      // Another home's boot sweep: A's holder is untouched.
      const b = host(homes.b, "sweep"); hosts.push(b);
      expect(await b.result()).toEqual({ swept: true });
      expect(() => process.kill(aPid, 0)).not.toThrow();
      // Same home while A runs: no lock, so no sweep; A's holder is untouched.
      const same = host(homes.a, "sweep"); hosts.push(same);
      expect(await same.result()).toMatchObject({ lock: "refused" });
      expect(() => process.kill(aPid, 0)).not.toThrow();
      // Control: once A is gone, the next run of home A sweeps what A left.
      a.child.kill("SIGKILL");
      await new Promise(done => a.child.once("exit", done));
      expect(() => process.kill(aPid, 0)).not.toThrow();
      const later = host(homes.a, "sweep"); hosts.push(later);
      expect(await later.result()).toEqual({ swept: true });
      await vi.waitFor(() => expect(() => process.kill(aPid, 0)).toThrow(), { timeout: 5_000, interval: 50 });
    } finally {
      for (const started of hosts) started.child.kill("SIGKILL");
      for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
  }, 90_000);

  it("N13: a kernel-refused start runs nothing and leaves no staging tree", async () => {
    const staging = join(cache, "ai.agent-connector.ave", "mxc-runtime", "staging");
    const before = existsSync(staging) ? readdirSync(staging).length : 0;
    // A NUL in an argument is refused by the builder before any spawn.
    await expect(holder("true", { args: ["-c", "true\0"] })).rejects.toThrow();
    expect(existsSync(staging) ? readdirSync(staging).length : 0).toBe(before);
  });
});
