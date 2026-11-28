import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createUnixServer } from "node:net";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { collectStream as collect } from "../../__tests__/support/collect-stream.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import seccompPins from "../mxc-linux-seccomp-pins.json" with { type: "json" };
import { buildBubblewrapHolderRequest, requireMxcLinuxShellPrograms } from "../mxc-linux.js";
import { posixPolicyLookups } from "../mxc-posix.js";
import { measurePosixExecutableIdentity } from "../holder-admission-darwin.js";
import {
  establishLinuxCaptureFolder, linuxHolderLaunchDigest, linuxHolderReplay, startLinuxHolder, type StartLinuxHolderOptions,
  translateLinuxHolderRequest,
} from "../mxc-linux-holder-launch.js";
import { __resetManagedChildProcessesForTest } from "../../main/managed-child-processes.js";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { spawnMxcConfinedChild, type MxcConfinedChildSpawn, type MxcConfinedChildSpec } from "../confined-child.js";
import { startEgressRelayService, stopEgressRelayService } from "../egress-relay/relay.js";
import { setProvenLinuxHolderRoute } from "../linux-holder-route.js";
import { __resetSandboxRequestedAtBootForTest, setPluginWorkerConfinementRequestedAtBoot } from "../sandbox-capability.js";
import { currentMxcRuntimeHost, establishMxcRuntimeRoot, requireMxcContainerStartRoot, _forgetMxcRuntimeRootForTest } from "../mxc-runtime-root.js";
import { forgetIssuedContainerHome, recordIssuedContainerHome } from "../sandbox-home-registry.js";
import { spawnMxcBundledHolder, type MxcBundledHolder } from "../../sandbox/wrap-bundled-command.js";

vi.mock("../../shared/container-platform.js", async (actual) => {
  const real = await actual<typeof import("../../shared/container-platform.js")>();
  // The route is switched on here, before the product switch: the proof is injected, the chain is real.
  return { ...real, isContainerHolderRouteEnabled: (platform: NodeJS.Platform) => platform === "linux" || real.isContainerHolderRouteEnabled(platform) };
});

const NATIVE = process.env.AVE_RUN_MXC_LINUX_BOUNDARY === "1";
const BWRAP = "/usr/bin/bwrap";


describe.runIf(NATIVE)("native Linux holder translation", () => {
  const resources = { resourcePath: resolve("resources"), isPackaged: false };
  const pin = seccompPins[process.arch === "arm64" ? "arm64" : "x64"];
  let root: string;
  let work: string;
  beforeEach(() => {
    root = realpathSync.native(mkdtempSync("/tmp/ave-linux-holder-"));
    work = join(root, "work");
    mkdirSync(work);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  // A product-shaped holder request: no proxy URL and no timeout, so the launcher uses its isolated network mode.
  function stage(commandLine: string, env: readonly string[] = []) {
    const request = {
      version: "0.9.0-alpha", containment: "bubblewrap",
      process: { commandLine, cwd: work, inheritDefaultEnv: false, env: [...env] },
      filesystem: { readwritePaths: [work], readonlyPaths: ["/usr", "/etc", "/bin", "/lib"], deniedPaths: [join(work, ".ave")] },
      network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
    };
    const requestPath = join(root, `request-${Math.random().toString(16).slice(2)}.json`);
    writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 });
    return { request, requestPath, logPath: `${requestPath}.log` };
  }

  async function translate(commandLine: string, env: readonly string[] = [], launcher?: string) {
    const programs = await requireMxcLinuxShellPrograms(resources);
    const captureFolder = establishLinuxCaptureFolder(root, programs.helper, pin);
    const staged = stage(commandLine, env);
    return translateLinuxHolderRequest({ launcher: launcher ?? programs.launcher, env: programs.env, captureFolder, helperSha256: pin,
      bwrap: BWRAP, ...staged });
  }

  it("records the pinned launcher's call through the helper on an inherited socket, with the measured option sequence", async () => {
    const call = await translate("/bin/echo holder");
    const names = call.options.filter(word => word.startsWith("--"));
    // Golden: a pin update that changes this sequence fails here, where a person reads the new shape.
    expect([...new Set(names)]).toEqual([
      "--new-session", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--unshare-net",
      "--symlink", "--ro-bind-try", "--dev", "--proc", "--tmpfs", "--dir", "--file", "--remount-ro", "--ro-bind", "--bind",
      "--chdir", "--clearenv", "--seccomp",
    ]);
    expect(call.command).toEqual(["sh", "-c", "/bin/echo holder"]);
    expect(call.seccomp.length).toBeGreaterThan(0);
  });

  it("translates the holder request Ave builds, with its proxy socket as a read-only row", async () => {
    const programs = await requireMxcLinuxShellPrograms(resources);
    const socketPath = join(root, "proxy.sock");
    const server = createUnixServer(() => {});
    await new Promise<void>(done => server.listen(socketPath, done));
    try {
      const request = buildBubblewrapHolderRequest({
        grants: { readwrite: [work], readonly: ["/usr", "/etc"], denied: [], chainFolders: [], ungrantedDenies: [] },
        lookups: { ...posixPolicyLookups(root, false) }, argv: ["/usr/bin/true"], cwd: work, env: { TOKEN: "x" },
        proxySocket: socketPath, helper: programs.helper,
      });
      const requestPath = join(root, "holder-request.json");
      writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 });
      const call = await translateLinuxHolderRequest({ launcher: programs.launcher, env: programs.env,
        captureFolder: establishLinuxCaptureFolder(root, programs.helper, pin), helperSha256: pin, bwrap: BWRAP,
        requestPath, logPath: `${requestPath}.log`, request });
      expect(call.options.join(" ")).toContain(`--ro-bind ${socketPath} ${socketPath}`);
      expect(call.command).toEqual(["sh", "-c", request.process.commandLine]);
    } finally {
      await new Promise<void>(done => server.close(() => done()));
    }
  });

  it("replays the call with the options on a descriptor: the holder gets its environment, no command line holds it", async () => {
    const marker = `marker-${Math.random().toString(16).slice(2)}`;
    const call = await translate('printf "%s" "$AVE_HOLDER_MARKER"; sleep 1', [`AVE_HOLDER_MARKER=${marker}`]);
    expect(call.options).toContain(marker);
    const replay = linuxHolderReplay(call);
    const stdio: ("pipe" | "ignore")[] = ["ignore", "pipe", "pipe", "ignore", "ignore", "pipe", "pipe", "pipe"];
    const child = spawn(BWRAP, replay.argv, { stdio });
    for (const [fd, bytes] of replay.descriptors) (child.stdio[fd] as Writable).end(bytes);
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    await new Promise(done => setTimeout(done, 300));
    const cmdline = readFileSync(`/proc/${child.pid}/cmdline`, "utf8");
    const code = await new Promise<number | null>(done => child.once("close", done));
    expect({ code, stdout: await stdout }, await stderr).toEqual({ code: 0, stdout: marker });
    expect(cmdline).not.toContain(marker);
    expect(cmdline.split("\0").slice(1, 3)).toEqual(["--args", "7"]);
  });

  // N21: a launcher whose call differs from the measured shape. The stand-in runs `bwrap` from its PATH, which is
  // the capture, with the words it is given.
  it.each([
    ["an extra option", ["--cap-add", "ALL"], "outside the allowlist: --cap-add"],
    ["an overlay option", ["--overlay-src", "/usr", "--ro-overlay", "/usr"], "outside the allowlist: --overlay-src"],
    ["a third descriptor kind", ["--userns", "3"], "--userns takes a descriptor the capture cannot replay"],
  ] as const)("refuses a launcher call with %s and runs nothing", async (_name, extra, reason) => {
    const ran = join(work, "ran");
    const command = `/usr/bin/touch ${ran}`;
    const real = await translate(command);
    const words = [...real.options.slice(0, 7), ...extra, ...real.options.slice(7)].map(word => word === "5" ? "3" : word);
    const launcher = join(root, "stand-in-launcher");
    const quoted = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
    writeFileSync(launcher, `#!/bin/sh\nbwrap --version > /dev/null || exit 70\nexec 3< /dev/null 6< /dev/null\n`
      + `exec bwrap ${[...words, "--", "sh", "-c", command].map(quoted).join(" ")}\n`, { mode: 0o755 });
    await expect(translate(command, [], launcher)).rejects.toThrow(reason);
    expect(() => readFileSync(ran)).toThrow();
  });
});

// H10: a holder through the real chain: launch gate, system bwrap from the replay, the helper's ready byte.
describe.runIf(NATIVE)("native Linux holder start and stop", () => {
  const resources = { resourcePath: resolve("resources"), isPackaged: false };
  const pin = seccompPins[process.arch === "arm64" ? "arm64" : "x64"];
  let root: string;
  let work: string;
  beforeEach(() => {
    root = realpathSync.native(mkdtempSync("/tmp/ave-linux-holder-run-"));
    work = join(root, "work");
    mkdirSync(work);
  });
  afterEach(() => {
    __resetManagedChildProcessesForTest();
    rmSync(root, { recursive: true, force: true });
  });

  async function prepare(script: string, argv?: readonly string[]) {
    const programs = await requireMxcLinuxShellPrograms(resources);
    const request = buildBubblewrapHolderRequest({
      grants: { readwrite: [work], readonly: ["/usr", "/etc"], denied: [], chainFolders: [], ungrantedDenies: [] },
      lookups: posixPolicyLookups(root, false), argv: argv ?? ["/bin/sh", "-c", script], cwd: work, env: { PATH: "/usr/bin:/bin" },
      proxySocket: "offline", helper: programs.helper,
    });
    const requestPath = join(root, `request-${Math.random().toString(16).slice(2)}.json`);
    const bytes = Buffer.from(JSON.stringify(request));
    writeFileSync(requestPath, bytes, { mode: 0o600 });
    const call = await translateLinuxHolderRequest({ launcher: programs.launcher, env: programs.env,
      captureFolder: establishLinuxCaptureFolder(root, programs.helper, pin), helperSha256: pin, bwrap: BWRAP,
      requestPath, logPath: `${requestPath}.log`, request });
    const digest = () => linuxHolderLaunchDigest({ request: readFileSync(requestPath), call, executable: "/bin/sh" });
    return { call, digest, admitted: digest(), requestPath };
  }

  async function start(script: string, over: Partial<StartLinuxHolderOptions> = {}, argv?: readonly string[]) {
    const prepared = await prepare(script, argv);
    const events: string[] = [];
    const holder = await startLinuxHolder(prepared.call, {
      label: "test:linux-holder", bwrap: { path: BWRAP, identity: measurePosixExecutableIdentity(BWRAP) }, cwd: work, online: false,
      admittedDigest: prepared.admitted, currentDigest: prepared.digest, assertStillValid: () => { events.push("recheck"); },
      beforeRelease: async () => { events.push("before-release"); }, afterVerifiedStop: async () => { events.push("after-verified-stop"); },
      ...over,
    });
    return { holder, events, prepared };
  }

  function line(stream: Readable): Promise<string> {
    return new Promise(done => {
      let text = "";
      const onData = (chunk: Buffer) => {
        text += chunk.toString("utf8");
        if (text.includes("\n")) { stream.off("data", onData); done(text.slice(0, text.indexOf("\n"))); }
      };
      stream.on("data", onData);
    });
  }

  it("starts at the ready byte, gives the holder its own TERM first, and releases only after a verified stop", async () => {
    const { holder, events } = await start(`trap 'echo term; exit 0' TERM; echo started; while :; do sleep 0.1; done`);
    expect(await line(holder.process.stdout)).toBe("started");
    expect(events).toEqual(["before-release", "recheck"]);
    const output: string[] = [];
    holder.process.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    await expect(holder.dispose()).resolves.toBeDefined();
    expect(output.join("")).toContain("term");
    expect(events).toEqual(["before-release", "recheck", "after-verified-stop"]);
    expect(await holder.process.completion).toMatchObject({ code: expect.any(Number) });
  });

  it("releases a holder that exits 1.5 s after its TERM, within its grace", async () => {
    const { holder, events } = await start(`trap 'sleep 1.5; echo late; exit 0' TERM; echo started; while :; do sleep 0.1; done`);
    expect(await line(holder.process.stdout)).toBe("started");
    const started = Date.now();
    await expect(holder.dispose()).resolves.toBeDefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
    expect(Date.now() - started).toBeLessThan(2_000 + 1_000);
    expect(events.at(-1)).toBe("after-verified-stop");
  });

  it("stops a holder that ignores TERM through bwrap's TERM and its group's KILL, and still verifies", async () => {
    const { holder, events } = await start(`trap '' TERM; echo started; while :; do sleep 0.1; done`);
    expect(await line(holder.process.stdout)).toBe("started");
    await expect(holder.dispose()).resolves.toBeDefined();
    expect(events.at(-1)).toBe("after-verified-stop");
  }, 15_000);

  it("keeps a holder's exit status, and a stdin write after it exited does not replace it", async () => {
    const { holder } = await start("echo started; exit 3");
    expect(await line(holder.process.stdout)).toBe("started");
    expect(await holder.process.completion).toEqual({ code: 3, signal: null });
    holder.process.stdin.write("late\n");
    await new Promise(done => setTimeout(done, 50));
    expect(await holder.process.completion).toEqual({ code: 3, signal: null });
    await holder.dispose();
  });

  it("refuses a start that closes before the ready byte as holder-start-failed, with bwrap's bounded stderr", async () => {
    const prepared = await prepare("echo started");
    // bwrap itself fails before the helper runs: the request's working directory is gone.
    rmSync(work, { recursive: true });
    const refused = startLinuxHolder(prepared.call, {
      label: "test:linux-holder", bwrap: { path: BWRAP, identity: measurePosixExecutableIdentity(BWRAP) }, cwd: root, online: false,
      admittedDigest: prepared.admitted, currentDigest: prepared.digest, assertStillValid: () => {},
    });
    await expect(refused).rejects.toMatchObject({ reason: "holder-start-failed" });
    await expect(refused).rejects.toThrow(/before the holder started \(exit \d+\): bwrap: /u);
  });

  it("reports a program the helper cannot execute after the ready byte as the holder's own exit", async () => {
    const { holder } = await start("", {}, ["/nonexistent/holder"]);
    expect(await holder.process.completion).toEqual({ code: 127, signal: null });
    await holder.dispose();
  });

  it("stops and refuses a start whose ready byte does not arrive in time", async () => {
    await expect(start("echo started; sleep 30", { startMs: 1 })).rejects.toMatchObject({ reason: "holder-start-failed" });
  });

  it("refuses in the gate when the system bwrap changed since the canary, or the launch changed after admission", async () => {
    await expect(start("echo started", { bwrap: { path: BWRAP, identity: "0:0:0:0:0" } })).rejects.toMatchObject({ reason: "integrity" });
    await expect(start("echo started", { currentDigest: () => "changed" })).rejects.toThrow("changed after admission");
  });
});

describe.runIf(NATIVE)("native Linux holder row-2 admission", () => {
  const resources = { resourcePath: resolve("resources"), isPackaged: false };
  const pin = seccompPins[process.arch === "arm64" ? "arm64" : "x64"];
  const PATH = "/usr/bin:/bin";
  let root: string;
  let data: string;
  let cache: string;
  const started: MxcConfinedChildSpawn[] = [];
  const homes: string[] = [];
  beforeEach(async () => {
    root = realpathSync.native(mkdtempSync("/tmp/ave-linux-row2-"));
    data = join(root, "data");
    mkdirSync(data);
    vi.stubEnv("AVE_TEST_SANDBOX_BASE", root);
    cache = currentMxcRuntimeHost().cacheHome;
    establishMxcRuntimeRoot();
    // Extension isolation requested, as the adapters' selection requires on every platform.
    setPluginWorkerConfinementRequestedAtBoot(true);
    startEgressRelayService({ ask: async () => false });
    const programs = await requireMxcLinuxShellPrograms(resources);
    setProvenLinuxHolderRoute({
      programs, helperSha256: pin, captureFolder: establishLinuxCaptureFolder(requireMxcContainerStartRoot(), programs.helper, pin),
      bwrap: { path: BWRAP, identity: measurePosixExecutableIdentity(BWRAP) },
    });
  });
  afterEach(async () => {
    await Promise.allSettled(started.splice(0).map(holder => holder.release()));
    for (const home of homes.splice(0)) forgetIssuedContainerHome(home);
    setProvenLinuxHolderRoute(undefined);
    __resetSandboxRequestedAtBootForTest();
    await stopEgressRelayService();
    _forgetMxcRuntimeRootForTest(cache);
    vi.unstubAllEnvs();
    __resetManagedChildProcessesForTest();
    rmSync(root, { recursive: true, force: true });
  });

  /** A holder's own staging tree under the runtime root, issued as the bundled-holder adapter issues it. */
  function staging() {
    const parent = join(requireMxcContainerStartRoot(), "staging");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const folder = join(parent, randomBytes(16).toString("hex"));
    const home = join(folder, "home");
    const temp = join(folder, "temp");
    for (const path of [folder, home, temp]) mkdirSync(path, { mode: 0o700 });
    recordIssuedContainerHome(home, requireMxcContainerStartRoot());
    homes.push(home);
    return { folder, home, temp };
  }

  async function spawnHolder(script: string, over: Partial<MxcConfinedChildSpec> = {}, tree = staging()): Promise<MxcConfinedChildSpawn> {
    const holder = await spawnMxcConfinedChild({
      command: "/bin/sh", args: ["-c", script], cwd: tree.home, home: tree.home, temp: tree.temp, stagingRoot: tree.folder,
      holder: {}, label: "test:linux-row2", baseEnv: { PATH }, allowRead: [], allowWrite: [data, tree.folder],
      filesystemOwnership: { readRoots: [], writeRoots: [data, tree.folder], hostStorageRoots: [] },
      egressOwner: { kind: "worker", role: "mcp-server", pluginId: undefined, instanceId: "row2" } as never,
      ...over,
    });
    started.push(holder);
    return holder;
  }

  function line(stream: Readable): Promise<string> {
    return new Promise((done, fail) => {
      let text = "";
      const timer = setTimeout(() => fail(new Error(`no line; got ${JSON.stringify(text)}`)), 15_000);
      stream.on("data", (chunk: Buffer) => {
        text += chunk.toString();
        if (text.includes("\n")) { clearTimeout(timer); done(text.split("\n")[0] as string); }
      });
    });
  }

  const markers = () => join(requireMxcContainerStartRoot(), "holder-markers");
  const holderFolders = () => readdirSync(requireMxcContainerStartRoot()).filter(name => /^holder-[A-Za-z0-9]{6}$/u.test(name));

  it("starts a holder in the Linux container over its own pipes, writes its marker and releases everything after a verified stop", async () => {
    const holder = await spawnHolder("echo \"$HOME|$(cat /proc/self/status | grep -c '^Seccomp:.*2')\"; exec /bin/cat");
    expect(holder.confinement).toBe("linux-container");
    const [home, filtered] = (await line(holder.process.stdout)).split("|");
    expect(home).toMatch(/\/staging\/[0-9a-f]{32}\/home$/u);
    expect(filtered).toBe("1");
    const echoed = line(holder.process.stdout);
    holder.process.stdin.write("ping\n");
    expect(await echoed).toBe("ping");
    expect(readdirSync(markers())).toHaveLength(1);
    expect(holderFolders()).toHaveLength(1);
    await holder.release();
    started.splice(0);
    expect(readdirSync(markers())).toEqual([]);
    expect(holderFolders()).toEqual([]);
  });

  it("refuses every start while the route is unproven", async () => {
    setProvenLinuxHolderRoute(undefined);
    await expect(spawnHolder("true")).rejects.toThrow("Native extension backend is not ready for this start");
  });

  it("refuses a holder whose executable lies inside a live holder's writable root, and a nested co-holder", async () => {
    const first = await spawnHolder("echo up; exec /bin/cat");
    expect(await line(first.process.stdout)).toBe("up");
    const planted = join(data, "tool");
    writeFileSync(planted, "#!/bin/sh\necho planted\n", { mode: 0o755 });
    await expect(spawnHolder("", { command: planted, args: [] })).rejects.toThrow("Container executable lies inside a holder's writable root");
    const nested = join(data, "nested");
    mkdirSync(nested);
    const tree = staging();
    await expect(spawnHolder("true", {
      allowWrite: [nested, tree.folder], filesystemOwnership: { readRoots: [], writeRoots: [nested, tree.folder], hostStorageRoots: [] },
    }, tree)).rejects.toThrow("Container path lies inside another live holder's writable root");
  });

  it("refuses a write grant outside the captured envelope, and a working directory inside the runtime root", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    const tree = staging();
    await expect(spawnHolder("true", {
      allowWrite: [outside, tree.folder], filesystemOwnership: { readRoots: [], writeRoots: [data, tree.folder], hostStorageRoots: [] },
    }, tree)).rejects.toThrow("Container write grant is outside this holder's captured write roots");
    await expect(spawnHolder("true", { cwd: requireMxcContainerStartRoot() })).rejects.toThrow("Container working directory is inside the sandbox runtime root");
  });

  it("admits a holder identity once, and refuses a child of a released parent", async () => {
    const identity = {};
    const parent = await spawnHolder("echo up; exec /bin/cat", { holder: identity, egressOwner: { kind: "worker", role: "plugin-child", pluginId: "p" } as never });
    expect(await line(parent.process.stdout)).toBe("up");
    await expect(spawnHolder("true", { holder: identity })).rejects.toThrow("Extension holder incarnation is invalid or already admitted");
    await parent.release();
    const workerData = join(root, "worker");
    mkdirSync(workerData);
    const tree = staging();
    await expect(spawnHolder("true", {
      parent, workerTransport: "output-only-v1", egressOwner: { kind: "worker", role: "worker", pluginId: "p", instanceId: "w" } as never,
      allowWrite: [workerData, tree.folder], filesystemOwnership: { readRoots: [], writeRoots: [workerData, tree.folder], hostStorageRoots: [] },
    }, tree)).rejects.toThrow("Extension parent backend is no longer admitted");
    expect(existsSync(markers()) ? readdirSync(markers()) : []).toEqual([]);
  });

  describe("the holder callers' adapter (H14)", () => {
    const bundled: MxcBundledHolder[] = [];
    afterEach(async () => { await Promise.allSettled(bundled.splice(0).map(holder => holder.release())); });
    async function bundledHolder(script: string, over: Partial<Parameters<typeof spawnMxcBundledHolder>[0]> = {}): Promise<MxcBundledHolder> {
      const holder = await spawnMxcBundledHolder({
        label: "test:linux-bundled", command: "/bin/sh", args: ["-c", script], baseEnv: { PATH }, holderEnv: {},
        allowRead: [], allowWrite: [data], ownedReadRoots: [],
        egressOwner: { kind: "worker", role: "mcp-server", pluginId: undefined, instanceId: "h14" } as never, ...over,
      });
      bundled.push(holder);
      return holder;
    }

    it("N1: an MCP-style server starts in the container in its own staging HOME, with fds 0/1/2 only, byte-exact both ways", async () => {
      const holder = await bundledHolder("fds=; for fd in 3 4 5 6 7 8 9; do [ -e /dev/fd/$fd ] && fds=\"$fds$fd\"; done; echo \"$HOME|$TMPDIR|fds=$fds\"; exec /bin/cat");
      expect(holder.confinement).toBe("linux-container");
      const [home, temp, fds] = (await line(holder.process.stdout)).split("|") as [string, string, string];
      expect(home).toMatch(/\/staging\/[0-9a-f]{32}\/home$/u);
      expect(temp).toBe(home.replace(/home$/u, "temp"));
      expect(fds).toBe("fds=");
      const payload = Buffer.alloc(16 * 1024 * 1024, 0x61);
      const echoed = collect(holder.process.stdout);
      holder.process.stdin.end(payload);
      const text = await echoed;
      expect(text.length).toBe(payload.length);
      expect(text === payload.toString()).toBe(true);
    });

    it("N18: a worker under a plugin child is released with it when the parent goes first, and a new one under it is refused", async () => {
      const parentData = join(root, "plugin-data");
      const workerData = join(root, "worker-data");
      mkdirSync(parentData);
      mkdirSync(workerData);
      // The plugin child is started by its own adapter straight through row 2, as in the product.
      const tree = staging();
      const parent = await spawnHolder("echo parent; exec /bin/cat", {
        label: "plugin-child:p18", egressOwner: { kind: "worker", role: "plugin-child", pluginId: "p18" } as never,
        allowWrite: [parentData, tree.folder], filesystemOwnership: { readRoots: [], writeRoots: [parentData, tree.folder], hostStorageRoots: [] },
      }, tree);
      expect(await line(parent.process.stdout)).toBe("parent");
      const worker = await bundledHolder("echo worker; exec /bin/sleep 3318", {
        label: "worker:p18:w", egressOwner: { kind: "worker", role: "worker", pluginId: "p18", instanceId: "w" } as never,
        workerTransport: "output-only-v1", parent, allowWrite: [workerData],
      });
      expect(await line(worker.process.stdout)).toBe("worker");
      const running = (): boolean => execFileSync("/bin/ps", ["-Ao", "args="]).toString().includes("sleep 3318");
      expect(running()).toBe(true);
      await parent.release();
      await vi.waitFor(() => expect(running()).toBe(false), { timeout: 5_000, interval: 50 });
      await expect(bundledHolder("true", {
        label: "worker:p18:w2", egressOwner: { kind: "worker", role: "worker", pluginId: "p18", instanceId: "w2" } as never,
        workerTransport: "output-only-v1", parent, allowWrite: [workerData],
      })).rejects.toThrow("Extension parent backend is no longer admitted");
    });
  });

});
