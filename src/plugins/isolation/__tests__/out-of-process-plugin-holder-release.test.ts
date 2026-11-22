/** Stop-path holder ordering: a stopped child's grant holders are released only after its process has really exited.
 * The child process, its loopback channel and the grant holder are in-memory stand-ins; no socket, process or wall-clock wait. */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

/** One ordered log: holder acquire/release, signals sent, the exit, and how stop settled. */
const events = vi.hoisted(() => [] as string[]);

const spawnConfinedChild = vi.hoisted(() => vi.fn());
const spawnNativeChild = vi.hoisted(() => vi.fn());
vi.mock("../../../permissions/confined-child.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../permissions/confined-child.js")>()),
  spawnConfinedChild,
  spawnMxcConfinedChild: spawnNativeChild,
}));

const sandbox = vi.hoisted(() => ({ active: false }));
vi.mock("../../../permissions/asrt-sandbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../permissions/asrt-sandbox.js")>()),
  isPluginWorkerConfinementActive: () => sandbox.active,
}));

/** Counts effective releases: production calls `release` on both `exit` and `close`. */
const grant = vi.hoisted(() => ({ acquired: 0, released: 0 }));
vi.mock("../../../permissions/windows-acl-grant-holder.js", () => ({
  holdWindowsFilesystemGrant: async () => {
    grant.acquired += 1;
    events.push("grant acquired");
    let held = true;
    return {
      assertAlive: () => undefined,
      onLost: () => undefined,
      release: () => {
        if (!held) return;
        held = false;
        grant.released += 1;
        events.push("grant released");
      },
    };
  },
}));

const sandboxHome = vi.hoisted(() => ({ path: "" }));
vi.mock("../../../permissions/sandbox-process-home.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../permissions/sandbox-process-home.js")>()),
  createSandboxProcessHome: () => ({ path: sandboxHome.path, env: { HOME: sandboxHome.path }, cleanup: () => undefined }),
}));

const loopback = vi.hoisted(() => ({ channel: undefined as unknown }));
vi.mock("../child-loopback-link.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../child-loopback-link.js")>()),
  connectToAnnouncedChild: async () => loopback.channel,
}));

import { afterQueuedCallbacks, deferred } from "../../../__tests__/support/deferred.js";
import { admittedMxcChild, nativePluginLaunch } from "../../../__tests__/support/mxc-plugin-launch.js";
import { frameMessage, StdioFrameDecoder } from "../../../mcp/stdio-framing.js";
import { MxcProcessCleanupError } from "../../../permissions/mxc-extension-errors.js";
import { TOOL_TIMEOUT_POLICY } from "../../../shared/tool-timeout-policy.js";
import type { PluginHostApi, PluginManifest, PluginRuntimeContext, RuntimePlugin } from "../../types.js";
import { FRAME_BYTES_MAX, HOST_PROTOCOL_VERSION } from "../host-api-wire.js";
import { createOutOfProcessPluginFactory, type OutOfProcessPluginSpec } from "../out-of-process-plugin.js";
import { PluginChildTerminationUnverifiedError } from "../plugin-child-transport.js";
import { PLUGIN_INSTANCE_METHODS } from "../plugin-instance-wire.js";

const PLUGIN_ID = "holderprobe";
const MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Holder Probe",
  version: "1.0.0",
  entry: "dist/plugin.js",
  requires: { hostProtocol: HOST_PROTOCOL_VERSION },
  description: "a plugin whose child only constructs",
  tools: [],
};

/** The child end of the protocol: answers `construct` and ignores EOF, so only termination or its own exit ends it. */
function childPipes(): { hostToChild: PassThrough; childToHost: PassThrough } {
  const hostToChild = new PassThrough();
  const childToHost = new PassThrough();
  const decoder = new StdioFrameDecoder(FRAME_BYTES_MAX);
  hostToChild.on("data", (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) {
      if (message.method !== PLUGIN_INSTANCE_METHODS.construct) continue;
      childToHost.write(frameMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: { implementedToolNames: [], servesUiResources: false, lifecycleHooks: [], pluginProtocol: { requires: [] } },
      }));
    }
  });
  return { hostToChild, childToHost };
}

/** The host end of the loopback channel. Half-open like a socket: ending the host's writes does not close it. */
function hostChannel(pipes: ReturnType<typeof childPipes>): Duplex {
  const channel = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      pipes.hostToChild.write(chunk, callback);
    },
    final(callback) {
      pipes.hostToChild.end();
      callback();
    },
  });
  pipes.childToHost.on("data", (chunk: Buffer) => channel.push(chunk));
  return channel;
}

type FakeChild = EventEmitter & {
  readonly pid: number;
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  readonly kill: Mock<(signal: NodeJS.Signals) => boolean>;
};

/** Records every signal and never exits on one: only {@link exit} ends it. */
function fakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    pid: 4242,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((signal: NodeJS.Signals) => {
      events.push(signal);
      return true;
    }),
  });
}

function exit(child: FakeChild, code: number | null, signal: NodeJS.Signals | null): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.exitCode = code;
  child.signalCode = signal;
  events.push("exit");
  child.emit("exit", code, signal);
}

function registration() {
  const holder = {
    assertCurrent: vi.fn(),
    terminating: vi.fn(() => void events.push("terminating")),
    dispose: vi.fn(() => void events.push("registration released")),
    quarantine: vi.fn((_reason: string) => void events.push("registration quarantined")),
  };
  const register = vi.fn(() => {
    events.push("registration acquired");
    return holder;
  });
  return { holder, register };
}

/** Observe how stop settles without leaving its rejection unhandled; `outcome` is the rejection, or undefined. */
function track(stopping: unknown): { readonly settled: () => boolean; readonly outcome: Promise<unknown> } {
  let settled = false;
  const outcome = Promise.resolve(stopping).then(
    () => void events.push("stop resolved"),
    (error: unknown) => {
      events.push("stop rejected");
      return error;
    },
  ).finally(() => {
    settled = true;
  });
  return { settled: () => settled, outcome };
}

async function finishChild(child: FakeChild, stop: ReturnType<typeof track> | undefined): Promise<void> {
  exit(child, null, "SIGKILL");
  child.emit("close", child.exitCode, child.signalCode);
  await stop?.outcome;
  await afterQueuedCallbacks();
}

/** Let stop arm its EOF grace, run it out, and let the teardown it starts settle as far as it can. */
async function runOutStopGrace(): Promise<void> {
  await afterQueuedCallbacks();
  await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.pluginShutdownKillGraceMs);
  await afterQueuedCallbacks();
}

let root = "";
let previousAveHome: string | undefined;

function runtimeContext(layout: { pluginRoot: string; pluginDataDir: string; pluginSocketDir: string }): PluginRuntimeContext {
  const hostApi = {
    config: { get: () => undefined, set: async () => undefined, onChange: () => () => undefined },
  } as unknown as PluginHostApi;
  return {
    pluginId: PLUGIN_ID,
    ...layout,
    hostRoot: join(root, "app"),
    userHome: join(root, "example"),
    aveHome: join(root, "ave"),
    config: {},
    hostApi,
  };
}

function spec(overrides: Partial<OutOfProcessPluginSpec>): OutOfProcessPluginSpec {
  return {
    manifest: MANIFEST,
    launch: { kind: "entry", entryPath: join(root, "never-imported.mjs") },
    childEntryPath: join(root, "child-entry.js"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  root = mkdtempSync(join(tmpdir(), "oop-holder-release-"));
  previousAveHome = process.env.AVE_HOME;
});

afterEach(() => {
  events.length = 0;
  grant.acquired = 0;
  grant.released = 0;
  sandbox.active = false;
  loopback.channel = undefined;
  spawnConfinedChild.mockReset();
  spawnNativeChild.mockReset();
  if (previousAveHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = previousAveHome;
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

/** The sandboxed Windows launch holds a filesystem grant for the child's lifetime; only Windows takes that path. */
describe.runIf(process.platform === "win32")("a stopped Windows child keeps its grant holders until it has exited", () => {
  async function confinedInstance(child: FakeChild, register: ReturnType<typeof registration>["register"]): Promise<RuntimePlugin> {
    const home = join(root, "ave");
    mkdirSync(home);
    process.env.AVE_HOME = home;
    sandboxHome.path = join(root, "sandbox-home");
    sandbox.active = true;
    loopback.channel = hostChannel(childPipes());
    spawnConfinedChild.mockResolvedValue({ child, confinement: "windows-srt" });
    const pluginsRoot = join(home, "plugins");
    const factory = createOutOfProcessPluginFactory(spec({ registerSandboxEnvelope: register }));
    return await factory(runtimeContext({
      pluginRoot: join(pluginsRoot, ".cache", PLUGIN_ID, "g1"),
      pluginDataDir: join(pluginsRoot, PLUGIN_ID, "data"),
      pluginSocketDir: join(pluginsRoot, PLUGIN_ID, "sockets"),
    }));
  }

  it("releases each holder once, only after the terminated child exits, and only then resolves stop", async () => {
    const child = fakeChild();
    const { holder, register } = registration();
    let stop: ReturnType<typeof track> | undefined;
    try {
      const instance = await confinedInstance(child, register);
      expect(events).toEqual(["registration acquired", "grant acquired"]);

      stop = track(instance.stop?.());
      await runOutStopGrace();
      expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
      expect(stop.settled()).toBe(false);
      expect(grant.released).toBe(0);
      expect(holder.dispose).not.toHaveBeenCalled();

      await vi.advanceTimersToNextTimerAsync();
      await afterQueuedCallbacks();
      expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      expect(stop.settled()).toBe(false);
      expect(grant.released).toBe(0);
      expect(holder.dispose).not.toHaveBeenCalled();

      exit(child, null, "SIGKILL");
      await afterQueuedCallbacks();
      expect(stop.settled()).toBe(true);
      expect(await stop.outcome).toBeUndefined();
      expect(events).toEqual([
        "registration acquired", "grant acquired", "SIGTERM", "SIGKILL",
        "exit", "grant released", "registration released", "stop resolved",
      ]);
    } finally {
      await finishChild(child, stop);
    }
    expect(grant).toEqual({ acquired: 1, released: 1 });
    expect(holder.dispose).toHaveBeenCalledOnce();
    expect(holder.quarantine).not.toHaveBeenCalled();
  });

  it("releases once when the child exits on its own, and a stop that follows signals and releases nothing", async () => {
    const child = fakeChild();
    const { holder, register } = registration();
    let stop: ReturnType<typeof track> | undefined;
    try {
      const instance = await confinedInstance(child, register);
      exit(child, 0, null);
      await afterQueuedCallbacks();
      expect(events).toEqual(["registration acquired", "grant acquired", "exit", "grant released", "registration released"]);

      stop = track(instance.stop?.());
      expect(await stop.outcome).toBeUndefined();
    } finally {
      await finishChild(child, stop);
    }
    expect(child.kill).not.toHaveBeenCalled();
    expect(events.slice(-2)).toEqual(["registration released", "stop resolved"]);
    expect(grant).toEqual({ acquired: 1, released: 1 });
    expect(holder.dispose).toHaveBeenCalledOnce();
    expect(holder.quarantine).not.toHaveBeenCalled();
  });
});

describe("a stopped native child whose exit cannot be verified", () => {
  it("quarantines its registration instead of releasing it, and the failure reaches stop rather than going unhandled", async () => {
    const pipes = childPipes();
    let rejectDisposal!: (error: unknown) => void;
    const disposal = new Promise<void>((_resolve, reject) => {
      rejectDisposal = reject;
    });
    // Teardown may reject disposal before the native child has requested it.
    void disposal.catch(() => {});
    const disposalFailure = new MxcProcessCleanupError("Termination unverified");
    const completion = deferred<{ exitCode: number; timedOut: boolean }>();
    const dispose = vi.fn(() => {
      events.push("dispose requested");
      return disposal;
    });
    const admittedRelease = vi.fn(async () => {});
    spawnNativeChild.mockResolvedValue(admittedMxcChild({
      id: 42, stdin: pipes.hostToChild, stdout: pipes.childToHost, stderr: new PassThrough(),
      completion: completion.promise, dispose,
    } as never, admittedRelease));
    const launchRelease = vi.fn();
    const { holder, register } = registration();
    const factory = createOutOfProcessPluginFactory(spec({
      prepareMxcChild: async () => nativePluginLaunch({ release: launchRelease }),
      registerSandboxEnvelope: register,
    }));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    let stop: ReturnType<typeof track> | undefined;
    try {
      const instance = await factory(runtimeContext({
        pluginRoot: join(root, "plugin"),
        pluginDataDir: join(root, "data"),
        pluginSocketDir: join(root, "sockets"),
      }));
      stop = track(instance.stop?.());
      await runOutStopGrace();
      expect(events).toEqual(["registration acquired", "terminating", "dispose requested"]);
      expect(stop.settled()).toBe(false);

      rejectDisposal(disposalFailure);
      const failure = await stop.outcome;
      await afterQueuedCallbacks();
      expect(failure).toBeInstanceOf(PluginChildTerminationUnverifiedError);
      expect(holder.dispose).not.toHaveBeenCalled();
      expect(holder.quarantine).toHaveBeenCalledWith((failure as Error).message);
      // The factory's own exit watcher quarantines as well, in either order with the stop path's.
      expect(events.filter((event) => event !== "registration quarantined"))
        .toEqual(["registration acquired", "terminating", "dispose requested", "stop rejected"]);
      expect(events.indexOf("registration quarantined")).toBeGreaterThan(events.indexOf("dispose requested"));
      expect(launchRelease).not.toHaveBeenCalled();
      expect(admittedRelease).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    } finally {
      rejectDisposal(disposalFailure);
      completion.resolve({ exitCode: 1, timedOut: false });
      await stop?.outcome;
      await afterQueuedCallbacks();
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
