/** Protocol-session cleanup must own both ledgers and the child from construct through abort or exit. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHostApi, PluginManifest, PluginRuntimeContext } from "../../types.js";
import { StdioFrameDecoder } from "../../../mcp/stdio-framing.js";
import { servePluginChild } from "../plugin-child-main.js";
import { FRAME_BYTES_MAX } from "../host-api-wire.js";
import { hostProtocolCapabilities } from "../host-api-dispatcher.js";
import { PLUGIN_INSTANCE_METHODS } from "../plugin-instance-wire.js";
import type { ChildLink } from "../plugin-child-transport.js";
import { createBoundHostApiDispatchTable } from "../bound-host-api-table.js";
import {
  openPluginProtocolSession,
  type PluginProtocolSession,
  type PluginProtocolSessionSpec,
} from "../plugin-protocol-session.js";
import { observe, settle } from "./stream-turns.js";

type Frame = Record<string, unknown>;

const PLUGIN_ID = "sessionprobe";
const EXIT_REASON = "child exited code=0 signal=null";

const MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Session Probe",
  version: "1.0.0",
  entry: "plugin.mjs",
  requires: { hostProtocol: "4" },
  description: "a plugin the protocol session is measured on",
  tools: [{ name: "speak", description: "speak", inputSchema: { type: "object", properties: {} } }],
};

const ENVELOPE = {
  read: [`/plugins/${PLUGIN_ID}`, `/plugins/${PLUGIN_ID}/data`],
  write: [`/plugins/${PLUGIN_ID}/data`],
};

let moduleDir: string;
let entryPath: string;

beforeAll(() => {
  moduleDir = mkdtempSync(join(tmpdir(), "protocol-session-"));
  entryPath = join(moduleDir, "plugin.mjs");
  writeFileSync(
    entryPath,
    `export const createPlugin = async () => ({
  handlers: { speak: async () => "spoke" },
  stop: async () => undefined,
});
`,
    "utf-8",
  );
});

afterAll(() => {
  rmSync(moduleDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

function watchedHostApi(): {
  hostApi: PluginHostApi;
  liveWatchers: () => number;
  spawnWorker: ReturnType<typeof vi.fn>;
} {
  let live = 0;
  const watch = () => {
    live += 1;
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      live -= 1;
    };
  };
  const spawnWorker = vi.fn(async (spec: { workerId: string }) => ({
    socketPath: `/run/${spec.workerId}.sock`,
    pid: 4242,
    stop: () => undefined,
    onStdout: () => undefined,
    onStderr: () => undefined,
    onExit: () => undefined,
  }));
  const hostApi = {
    getInstalledPluginIds: () => [PLUGIN_ID],
    onPluginsChanged: () => watch(),
    config: {
      get: () => undefined,
      set: async () => undefined,
      onChange: () => watch(),
    },
    spawnWorker,
  } as unknown as PluginHostApi;
  return { hostApi, liveWatchers: () => live, spawnWorker };
}

function contextFor(hostApi: PluginHostApi): PluginRuntimeContext {
  return {
    pluginId: PLUGIN_ID,
    pluginRoot: `/plugins/${PLUGIN_ID}`,
    hostRoot: "/app",
    pluginDataDir: `/plugins/${PLUGIN_ID}/data`,
    pluginSocketDir: `/plugins/${PLUGIN_ID}/data/sockets`,
    userHome: "/Users/example",
    aveHome: "/Users/example/.ave",
    config: {},
    log: () => undefined,
    hostApi,
  };
}

/** Model requested termination separately from observed exit. */
function processLink(answer: "runtime" | ((frame: Frame, reply: (frame: Frame) => void) => void)): {
  link: ChildLink;
  sent: Frame[];
  terminated: string[];
  exit: (reason: string) => void;
  fault: (reason: string) => void;
  reply: (frame: Frame) => void;
} {
  const hostToChild = new PassThrough();
  const childToHost = new PassThrough();
  const sent: Frame[] = [];
  const terminated: string[] = [];
  const gone: Array<(reason: string) => void> = [];
  const faults: Array<(reason: string) => void> = [];
  const decoder = new StdioFrameDecoder(FRAME_BYTES_MAX);
  const reply = (frame: Frame): void => void childToHost.write(`${JSON.stringify(frame)}\n`);
  hostToChild.on("data", (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      sent.push(frame);
      if (answer !== "runtime") answer(frame, reply);
    }
  });
  const service = answer === "runtime" ? servePluginChild(hostToChild, childToHost) : undefined;
  let exited = false;
  const exit = (reason: string): void => {
    if (exited) return;
    exited = true;
    service?.hostGone();
    childToHost.end();
    for (const handler of gone) handler(reason);
  };
  hostToChild.on("end", () => exit(EXIT_REASON));
  return {
    link: {
      input: childToHost,
      output: hostToChild,
      terminate: (reason) => void terminated.push(reason),
      onGone: (handler) => void gone.push(handler),
      onFault: (handler) => void faults.push(handler),
    },
    sent,
    terminated,
    exit,
    fault: (reason) => {
      for (const handler of faults) handler(reason);
    },
    reply,
  };
}

function sessionSpec(
  link: ChildLink,
  hostApi: PluginHostApi,
  onClosed: PluginProtocolSessionSpec["onClosed"],
  signal?: AbortSignal,
): PluginProtocolSessionSpec {
  return {
    pluginId: PLUGIN_ID,
    manifest: MANIFEST,
    hostProtocolVersion: "4",
    link,
    context: contextFor(hostApi),
    entryPath,
    table: createBoundHostApiDispatchTable(hostApi, ENVELOPE),
    onClosed,
    ...(signal ? { signal } : {}),
  };
}

const CONSTRUCTED = {
  implementedToolNames: [],
  servesUiResources: false,
  lifecycleHooks: [],
  pluginProtocol: { requires: [] },
};

describe("the channel is non-destructive", () => {
  it("runs the stop hook without closing or terminating", async () => {
    const child = processLink("runtime");
    const { hostApi } = watchedHostApi();
    const onClosed = vi.fn(async () => undefined);
    const session = await openPluginProtocolSession(sessionSpec(child.link, hostApi, onClosed));
    await session.channel.runStopHook();
    expect(child.sent.filter((frame) => frame.method === PLUGIN_INSTANCE_METHODS.stop)).toHaveLength(1);
    expect(child.terminated).toEqual([]);
    expect(onClosed).not.toHaveBeenCalled();
    // The stop hook must not close the channel.
    await expect(session.instance.handlers.speak!()).resolves.toBe("spoke");
    await session.teardown("case over");
  });

  it("releases a child that exits after its stdin closes, and terminates nothing", async () => {
    const child = processLink("runtime");
    const { hostApi, liveWatchers } = watchedHostApi();
    const onClosed = vi.fn(async () => undefined);
    const session = await openPluginProtocolSession(sessionSpec(child.link, hostApi, onClosed));
    expect(liveWatchers()).toBe(2);
    session.channel.closeInput();
    await expect(session.channel.exited).resolves.toBe(EXIT_REASON);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledWith(EXIT_REASON);
    expect(liveWatchers()).toBe(0);
    expect(child.terminated).toEqual([]);
    await session.teardown("stopped after it left");
    expect(child.terminated).toEqual([]);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});

describe("teardown is the one destructive operation", () => {
  it.each([
    ["a teardown", 1, (session: PluginProtocolSession) => session.teardown("torn down")],
    ["the child's exit", 0, (session: PluginProtocolSession) => {
      session.channel.closeInput();
      return session.channel.exited;
    }],
  ] as const)("runs onClosed once when it re-enters teardown, after %s", async (_name, terminations, end) => {
    const child = processLink("runtime");
    const { hostApi } = watchedHostApi();
    let session: PluginProtocolSession | undefined;
    let reentered: Promise<void> | undefined;
    // Owner cleanup must end the session synchronously before its releasing callback returns.
    const onClosed = vi.fn(async () => {
      if (onClosed.mock.calls.length === 1) reentered = session!.teardown("re-entered from onClosed");
    });
    session = await openPluginProtocolSession(sessionSpec(child.link, hostApi, onClosed));
    await end(session);
    await reentered;
    await settle();
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(child.terminated).toHaveLength(terminations);
  });

  it("terminates a live child exactly once, runs onClosed once, and is idempotent", async () => {
    const child = processLink("runtime");
    const { hostApi, liveWatchers } = watchedHostApi();
    const onClosed = vi.fn(async () => undefined);
    const session = await openPluginProtocolSession(sessionSpec(child.link, hostApi, onClosed));
    await session.teardown("torn down");
    await session.teardown("torn down again");
    expect(child.terminated).toEqual(["torn down"]);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(liveWatchers()).toBe(0);
    await expect(session.instance.handlers.speak!()).rejects.toThrow("torn down");
  });

  it("ends a child whose signal could not be delivered, and settles exited only on its exit", async () => {
    const child = processLink("runtime");
    const { hostApi } = watchedHostApi();
    const onClosed = vi.fn(async () => undefined);
    const session = await openPluginProtocolSession(sessionSpec(child.link, hostApi, onClosed));
    const exited = observe(session.channel.exited);
    child.fault("kill EPERM");
    await settle();
    expect(exited()).toBe(false);
    expect(child.terminated).toEqual(["kill EPERM"]);
    expect(onClosed).not.toHaveBeenCalled();
    child.exit("child exited code=null signal=SIGKILL");
    await expect(session.channel.exited).resolves.toBe("child exited code=null signal=SIGKILL");
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(child.terminated).toHaveLength(1);
  });

  it("stops the instance with one stop frame and then exactly one terminate", async () => {
    const child = processLink("runtime");
    const { hostApi } = watchedHostApi();
    const onClosed = vi.fn(async () => undefined);
    const session = await openPluginProtocolSession(sessionSpec(child.link, hostApi, onClosed));
    await session.instance.stop!();
    expect(child.sent.filter((frame) => frame.method === PLUGIN_INSTANCE_METHODS.stop)).toHaveLength(1);
    expect(child.terminated).toEqual([`[out-of-process-plugin] ${PLUGIN_ID}: stopped`]);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});

describe("cancellation", () => {
  it("rejects with the abort reason while construct is pending, and drops a late reply", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let constructFrame: Frame | undefined;
      const child = processLink((frame) => {
        if (frame.method === PLUGIN_INSTANCE_METHODS.construct) constructFrame = frame;
      });
      const { hostApi, liveWatchers } = watchedHostApi();
      const onClosed = vi.fn(async () => undefined);
      const controller = new AbortController();
      const reason = new Error("the validator was cancelled");
      const started = Date.now();
      const opening = openPluginProtocolSession(
        sessionSpec(child.link, hostApi, onClosed, controller.signal),
      );
      setTimeout(() => controller.abort(reason), 50);
      await expect(opening).rejects.toBe(reason);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(child.terminated).toEqual(["the validator was cancelled"]);
      expect(onClosed).toHaveBeenCalledTimes(1);
      expect(liveWatchers()).toBe(0);

      // Ignore replies arriving after abort.
      expect(constructFrame).toBeDefined();
      child.reply({ jsonrpc: "2.0", id: constructFrame!.id, result: CONSTRUCTED });
      await settle();
      expect(onClosed).toHaveBeenCalledTimes(1);
      expect(child.terminated).toHaveLength(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("tears down before any frame is written when the signal is already aborted", async () => {
    const child = processLink("runtime");
    const { hostApi } = watchedHostApi();
    const onClosed = vi.fn(async () => undefined);
    const reason = new Error("cancelled before it began");
    await expect(
      openPluginProtocolSession(sessionSpec(child.link, hostApi, onClosed, AbortSignal.abort(reason))),
    ).rejects.toBe(reason);
    await settle();
    expect(child.sent).toEqual([]);
    expect(child.terminated).toEqual(["cancelled before it began"]);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});

describe("the bound table is the session's whole authority", () => {
  it("advertises the table's members and refuses a worker the table's envelope does not cover", async () => {
    const child = processLink((frame, reply) => {
      if (frame.method === PLUGIN_INSTANCE_METHODS.construct) {
        reply({ jsonrpc: "2.0", id: frame.id, result: CONSTRUCTED });
      }
    });
    const { hostApi, spawnWorker } = watchedHostApi();
    const spec = sessionSpec(child.link, hostApi, async () => undefined);
    const session = await openPluginProtocolSession(spec);
    const construct = child.sent.find((frame) => frame.method === PLUGIN_INSTANCE_METHODS.construct);
    const { hostProtocol } = construct!.params as { hostProtocol: { capabilities: string[] } };
    expect(hostProtocol.capabilities).toEqual(hostProtocolCapabilities(spec.table));
    expect(session.capabilities).toEqual(hostProtocol.capabilities);

    const request = (id: string, allowWritePaths: string[]): void =>
      child.reply({
        jsonrpc: "2.0",
        id,
        method: "ave/host/spawnWorker",
        params: { spec: { workerId: id, command: "/usr/bin/true", allowWritePaths } },
      });
    const replyTo = (id: string): Frame | undefined => child.sent.find((frame) => frame.id === id);

    request("outside", ["/Users/example/Documents"]);
    await vi.waitFor(() => expect(replyTo("outside")).toBeDefined());
    expect(replyTo("outside")).toMatchObject({ error: { data: { code: "effect-boundary-denied" } } });
    expect(spawnWorker).not.toHaveBeenCalled();

    request("inside", [`/plugins/${PLUGIN_ID}/data/work`]);
    await vi.waitFor(() => expect(replyTo("inside")).toBeDefined());
    expect(replyTo("inside")).toHaveProperty("result");
    expect(spawnWorker).toHaveBeenCalledTimes(1);
    await session.teardown("case over");
  });
});
