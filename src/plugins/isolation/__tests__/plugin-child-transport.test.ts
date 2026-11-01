/** The transport owns framing, call settlement and one termination sequence; faults are not terminal exits. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { PassThrough } from "node:stream";
import { frameMessage, StdioFrameDecoder } from "../../../mcp/stdio-framing.js";
import { INVOCATION_META, RPC_METHOD_NOT_FOUND } from "../../../mcp/protocol-constants.js";
import { servePluginChild } from "../plugin-child-main.js";
import {
  defineHostApiPath,
  createServiceHostApiPaths,
  HOSTAPI_DISPATCH_TABLE,
  HostApiDispatcher,
} from "../host-api-dispatcher.js";
import { encodeHostFetchInit, FRAME_BYTES_MAX, HOST_PROTOCOL_NOTIFICATIONS, hostApiMethodOf } from "../host-api-wire.js";
import {
  PluginChildTransport,
  pluginChildRequestMeta,
  LIVE_INVOCATIONS_MAX,
  SETTLED_INVOCATIONS_MAX,
  type ChildLink,
} from "../plugin-child-transport.js";
import { observe, settle } from "./stream-turns.js";

/** Capture dispatcher warnings for dropped frames. */
const dispatcherWarn = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/logger.js")>();
  return {
    ...actual,
    createLogger: (module: string) => {
      const logger = actual.createLogger(module);
      if (module !== "host-api-dispatcher") return logger;
      return Object.assign(Object.create(logger) as typeof logger, { warn: dispatcherWarn });
    },
  };
});

type Frame = Record<string, unknown>;

interface LinkHandlers {
  gone: Array<(reason: string) => void>;
  fault: Array<(reason: string) => void>;
}

/** Use paired pipes with recorded termination and manually reported exits or faults. */
function recordedLink(): {
  link: ChildLink;
  childToHost: PassThrough;
  sent: Frame[];
  terminated: string[];
  fireGone: (reason: string) => void;
  fireFault: (reason: string) => void;
} {
  const hostToChild = new PassThrough();
  const childToHost = new PassThrough();
  const sent: Frame[] = [];
  const decoder = new StdioFrameDecoder(FRAME_BYTES_MAX);
  hostToChild.on("data", (chunk: Buffer) => sent.push(...decoder.push(chunk)));
  const terminated: string[] = [];
  const handlers: LinkHandlers = { gone: [], fault: [] };
  return {
    link: {
      input: childToHost,
      output: hostToChild,
      terminate: (reason) => void terminated.push(reason),
      onGone: (handler) => void handlers.gone.push(handler),
      onFault: (handler) => void handlers.fault.push(handler),
    },
    childToHost,
    sent,
    terminated,
    fireGone: (reason) => {
      for (const handler of handlers.gone) handler(reason);
    },
    fireFault: (reason) => {
      for (const handler of handlers.fault) handler(reason);
    },
  };
}

function transportOver(link: ChildLink): PluginChildTransport {
  const transport = new PluginChildTransport({
    pluginId: "transportprobe",
    isActive: () => true,
    log: () => undefined,
    reportUnknownField: () => undefined,
    link,
  });
  transport.start();
  return transport;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the transport is the one producer of MCP request metadata", () => {
  it("refuses new host effects while a closed child is still draining", async () => {
    const rig = recordedLink();
    const log = vi.fn();
    const transport = new PluginChildTransport({
      pluginId: "transportprobe", isActive: () => true, log, reportUnknownField: () => {}, link: rig.link,
    });
    transport.start();
    transport.close("revoked");
    rig.childToHost.write(frameMessage({ jsonrpc: "2.0", id: "late", method: "ave/host/logEvent",
      params: { level: "info", message: "late effect" } }));
    await settle();
    expect(log).not.toHaveBeenCalled();
    expect(rig.sent).toEqual([expect.objectContaining({ id: "late", error: expect.objectContaining({
      data: expect.objectContaining({ code: "plugin-inactive" }),
    }) })]);
    expect(rig.terminated).toEqual(["revoked"]);
    rig.fireGone("native process stopped");
  });
  it("stamps exactly the protocol version and empty client capabilities on an MCP request", async () => {
    const { link, sent } = recordedLink();
    const transport = transportOver(link);
    void transport
      .requestMcp("tools/call", { name: "speak", arguments: { text: "hi" } })
      .catch(() => undefined);
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "tools/call" });
    const params = sent[0]!.params as Record<string, unknown>;
    // tools/call carries a fresh invocation token in addition to required protocol metadata.
    const { "ave/invocation": invocation, ...s1 } = params._meta as Record<string, unknown>;
    expect(invocation).toMatch(/^[0-9a-f-]{36}$/u);
    expect(s1).toEqual({
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    });
    expect(s1).toEqual(pluginChildRequestMeta());
    expect(params).toMatchObject({ name: "speak", arguments: { text: "hi" } });
    transport.close("case over");
  });

  it("refuses an MCP method through request", async () => {
    const { link, sent } = recordedLink();
    const transport = transportOver(link);
    // @ts-expect-error -- `request` takes ave/instance methods only.
    await expect(transport.request("tools/call", { name: "speak" })).rejects.toThrow(
      /'tools\/call' is not an ave\/instance method/,
    );
    await settle();
    expect(sent).toEqual([]);
    transport.close("case over");
  });

  it("refuses an MCP request whose caller supplied its own _meta", async () => {
    const { link, sent } = recordedLink();
    const transport = transportOver(link);
    await expect(
      transport.requestMcp("tools/call", { name: "speak", _meta: { "io.modelcontextprotocol/protocolVersion": "1999-01-01" } }),
    ).rejects.toThrow(/carry their own _meta/);
    await settle();
    expect(sent).toEqual([]);
    transport.close("case over");
  });

  it("probes one method verbatim and answers with the child's error, refusing the methods with their own path", async () => {
    const hostToChild = new PassThrough();
    const childToHost = new PassThrough();
    const service = servePluginChild(hostToChild, childToHost);
    const transport = transportOver({
      input: childToHost,
      output: hostToChild,
      terminate: () => service.hostGone(),
      onGone: () => undefined,
      onFault: () => undefined,
    });
    await expect(transport.probe("ave/instance/construct")).rejects.toThrow(/probe refuses/);
    await expect(transport.probe("tools/list")).rejects.toThrow(/probe refuses/);
    const reply = await transport.probe("ave/host/nope");
    expect(reply).toEqual({ error: expect.objectContaining({ code: RPC_METHOD_NOT_FOUND }) });
    transport.close("case over");
  });
});

describe("an observed exit is not a requested termination", () => {
  it("rejects what was pending with the exit reason, releases the dispatcher once, and terminates nothing", async () => {
    const childGone = vi.spyOn(HostApiDispatcher.prototype, "childGone");
    const { link, terminated, fireGone } = recordedLink();
    const transport = transportOver(link);
    const pending = transport.request("ave/instance/start", {});
    fireGone("child exited code=0 signal=null");
    await expect(pending).rejects.toThrow("child exited code=0 signal=null");
    await expect(transport.exited).resolves.toBe("child exited code=0 signal=null");
    expect(childGone).toHaveBeenCalledTimes(1);
    expect(terminated).toEqual([]);
    transport.close("stopped after it left");
    expect(terminated).toEqual([]);
    expect(childGone).toHaveBeenCalledTimes(1);
  });

  it("terminates a child whose request outlived its deadline, exactly once", async () => {
    const { link, terminated } = recordedLink();
    const transport = transportOver(link);
    await expect(transport.request("ave/instance/start", {}, 20)).rejects.toThrow(/exceeded 20ms/);
    expect(terminated).toHaveLength(1);
    expect(terminated[0]).toMatch(/'ave\/instance\/start' timed out after 20ms/);
  });

  it("terminates a child that broke the framing, exactly once", async () => {
    const { link, childToHost, terminated } = recordedLink();
    const transport = transportOver(link);
    const pending = transport.request("ave/instance/start", {});
    childToHost.write(Buffer.alloc(FRAME_BYTES_MAX + 1, 0x78));
    await expect(pending).rejects.toThrow(/exceeded .* bytes/);
    expect(terminated).toHaveLength(1);
  });
});

describe("a live child's fault", () => {
  it("starts the termination and fails what was pending", async () => {
    const { link, terminated, fireFault } = recordedLink();
    const transport = transportOver(link);
    const pending = transport.request("ave/instance/start", {});
    const exited = observe(transport.exited);
    fireFault("kill EPERM");
    await expect(pending).rejects.toThrow("kill EPERM");
    expect(terminated).toEqual(["kill EPERM"]);
    await settle();
    // A fault starts termination but does not report child exit.
    expect(exited()).toBe(false);
  });

  it("does nothing once the child's exit was observed", () => {
    const { link, terminated, fireGone, fireFault } = recordedLink();
    const transport = transportOver(link);
    fireGone("child exited code=0 signal=null");
    fireFault("kill ESRCH");
    expect(terminated).toEqual([]);
    expect(transport.terminationFaults).toEqual([]);
  });
});

describe("a refused signal does not recurse", () => {
  const GRACE_MS = 3_000;

  /** Model synchronous signal refusal during a single SIGTERM/escalation sequence. */
  function refusingLink(): {
    link: ChildLink;
    counts: { terminate: number; maxDepth: number; timersArmed: number; sigkill: number };
    framesAfterStart: () => number;
  } {
    const hostToChild = new PassThrough();
    const childToHost = new PassThrough();
    const faultHandlers: Array<(reason: string) => void> = [];
    let frames = 0;
    const counts = { terminate: 0, maxDepth: 0, timersArmed: 0, sigkill: 0 };
    let depth = 0;
    const refuse = (signal: string): void => {
      for (const handler of faultHandlers) handler(`kill ${signal} EPERM`);
    };
    hostToChild.on("data", () => void (frames += 1));
    return {
      link: {
        input: childToHost,
        output: hostToChild,
        terminate: () => {
          depth += 1;
          counts.terminate += 1;
          counts.maxDepth = Math.max(counts.maxDepth, depth);
          refuse("SIGTERM");
          counts.timersArmed += 1;
          setTimeout(() => {
            counts.sigkill += 1;
            refuse("SIGKILL");
          }, GRACE_MS);
          depth -= 1;
        },
        onGone: () => undefined,
        onFault: (handler) => void faultHandlers.push(handler),
      },
      counts,
      framesAfterStart: () => frames,
    };
  }

  async function runSequence(start: (transport: PluginChildTransport, fault: (reason: string) => void) => void) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { link, counts, framesAfterStart } = refusingLink();
    let fault: (reason: string) => void = () => undefined;
    const transport = transportOver({
      ...link,
      onFault: (handler) => {
        fault = handler;
        link.onFault(handler);
      },
    });
    const pending = transport.request("ave/instance/start", {});
    const rejected = expect(pending).rejects.toThrow();
    const exited = observe(transport.exited);
    await settle();
    const framesBefore = framesAfterStart();
    start(transport, fault);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    await vi.advanceTimersByTimeAsync(2 * GRACE_MS);
    await rejected;
    expect(framesAfterStart()).toBe(framesBefore);
    return { transport, counts, exited };
  }

  it("started by a fault: one terminate, one timer, one SIGKILL step, both refusals recorded", async () => {
    const { transport, counts, exited } = await runSequence((_transport, fault) => {
      fault("the child faulted");
    });
    expect(counts).toEqual({ terminate: 1, maxDepth: 1, timersArmed: 1, sigkill: 1 });
    expect(transport.terminationFaults).toEqual(["kill SIGTERM EPERM", "kill SIGKILL EPERM"]);
    expect(exited()).toBe(false);
  });

  it("started by a teardown: the same counts", async () => {
    const { transport, counts, exited } = await runSequence((target) => {
      target.close("torn down");
    });
    expect(counts).toEqual({ terminate: 1, maxDepth: 1, timersArmed: 1, sigkill: 1 });
    expect(transport.terminationFaults).toEqual(["kill SIGTERM EPERM", "kill SIGKILL EPERM"]);
    expect(exited()).toBe(false);
  });
});

const marker = new AsyncLocalStorage<string>();

interface InvocationRig {
  transport: PluginChildTransport;
  sent: Frame[];
  seen: Array<string | undefined>;
  logged: Array<string | undefined>;
  /** Deliver frames in link-creation context, matching real pipes. */
  deliver: (frame: Frame) => void;
  fireGone: (reason: string) => void;
  fireFault: (reason: string) => void;
}

/** Construct inside a marker to test spawn-context isolation. */
function invocationRig(options: { pluginId?: string; teardown?: () => void; terminate?: () => void } = {}): InvocationRig {
  const { link, childToHost, sent, fireGone, fireFault } = recordedLink();
  const seen: InvocationRig["seen"] = [];
  const logged: InvocationRig["logged"] = [];
  return marker.run("spawned-in", () => {
    const transport = new PluginChildTransport({
      pluginId: options.pluginId ?? "transportprobe",
      isActive: () => true,
      log: () => void logged.push(marker.getStore()),
      reportUnknownField: () => undefined,
      link: options.terminate === undefined ? link : { ...link, terminate: options.terminate },
      table: {
        ...HOSTAPI_DISPATCH_TABLE,
        raiseAlert: defineHostApiPath("raiseAlert", async () => {
          seen.push(marker.getStore());
          return { status: "raised", alertId: "alert" } as never;
        }),
        onEvent: defineHostApiPath("onEvent", async (_call, scope) => {
          scope.adopt("events", () => options.teardown?.());
          return { handleId: "events" };
        }),
        hostFetch: createServiceHostApiPaths(
          { hostFetch: async () => new Response("ok") } as unknown as Parameters<typeof createServiceHostApiPaths>[0],
          { read: [], write: [] },
        ).hostFetch,
      },
    });
    transport.start();
    const deliver = AsyncResource.bind((frame: Frame) => void childToHost.write(frameMessage(frame)));
    return { transport, sent, seen, logged, deliver, fireGone, fireFault };
  });
}

async function callTools(rig: InvocationRig, count: number, offset = 0): Promise<{ frames: Frame[]; replies: Promise<unknown>[] }> {
  const before = rig.sent.length;
  const replies = Array.from({ length: count }, (_, index) =>
    marker.run(`call-${String(index + offset)}`, () =>
      rig.transport.requestMcp("tools/call", { name: "speak", arguments: {} })));
  await settle();
  const frames = rig.sent.slice(before).filter((frame) => frame.method === "tools/call");
  expect(frames).toHaveLength(count);
  return { frames, replies };
}

/** Check retained contexts even after channel closure. */
function invocationCounts(transport: PluginChildTransport): { live: number; settled: number } {
  const tables = transport as unknown as {
    liveInvocations: Map<string, unknown>;
    settledInvocations: Map<string, unknown>;
  };
  return { live: tables.liveInvocations.size, settled: tables.settledInvocations.size };
}

function tokenOf(frame: Frame): string {
  return ((frame.params as Record<string, unknown>)._meta as Record<string, string>)[INVOCATION_META]!;
}

async function raiseAlertFromChild(rig: InvocationRig, id: string, token?: string): Promise<Frame> {
  rig.deliver({
    jsonrpc: "2.0",
    id,
    method: hostApiMethodOf("raiseAlert"),
    params: {
      input: { kind: "reply", key: id },
      ...(token === undefined ? {} : { _meta: { [INVOCATION_META]: token } }),
    },
  });
  await settle();
  expect(rig.sent.some((frame) => frame.id === id)).toBe(true);
  return rig.sent.find((frame) => frame.id === id)!;
}

describe("a tools/call's invocation, as the child's hostApi requests reach it", () => {
  it("still runs a request in its call's context after the call has settled", async () => {
    const rig = invocationRig();
    const { frames, replies } = await callTools(rig, 1);
    rig.deliver({ jsonrpc: "2.0", id: frames[0]!.id as string, result: { content: [] } });
    await replies[0];
    const reply = await raiseAlertFromChild(rig, "late", tokenOf(frames[0]!));
    expect(reply).toMatchObject({ result: { status: "raised" } });
    expect(rig.seen).toEqual(["call-0"]);
    rig.transport.close("case over");
  });

  it("runs a request that names no invocation in none, not in the context the child was spawned in", async () => {
    const rig = invocationRig();
    const reply = await raiseAlertFromChild(rig, "background");
    expect(reply).toMatchObject({ result: { status: "raised" } });
    expect(rig.seen).toEqual([undefined]);
    rig.transport.close("case over");
  });

  it("forwards what the child sends unasked outside the context the child was spawned in", async () => {
    const rig = invocationRig();
    rig.deliver({
      jsonrpc: "2.0",
      method: HOST_PROTOCOL_NOTIFICATIONS.log,
      params: { message: "hello" },
    });
    await vi.waitFor(() => expect(rig.logged).toHaveLength(1));
    expect(rig.logged).toEqual([undefined]);
    rig.transport.close("case over");
  });

  it("runs a tokenless request outside its own caller's context too, whoever hands it to the dispatcher", async () => {
    const seen: Array<string | undefined> = [];
    const dispatcher = new HostApiDispatcher({
      pluginId: "transportprobe",
      isActive: () => true,
      notifications: { deliver: () => undefined },
      shutdownChild: async () => undefined,
      log: () => undefined,
      reportUnknownField: () => undefined,
      table: {
        ...HOSTAPI_DISPATCH_TABLE,
        raiseAlert: defineHostApiPath("raiseAlert", async () => {
          seen.push(marker.getStore());
          return { status: "raised", alertId: "alert" } as never;
        }),
      },
    });
    const reply = await marker.run("caller", () => dispatcher.handle({
      jsonrpc: "2.0",
      id: "direct",
      method: hostApiMethodOf("raiseAlert"),
      params: { input: { kind: "reply", key: "direct" } },
    } as never));
    expect(reply).toMatchObject({ result: { status: "raised" } });
    expect(seen).toEqual([undefined]);
    dispatcher.childGone();
  });

  it("refuses a request naming a token the connection never issued", async () => {
    const rig = invocationRig();
    const reply = await raiseAlertFromChild(rig, "forged", "never-issued");
    expect(reply.error).toMatchObject({ data: { code: "argument-marshalling-rejected" } });
    expect(rig.seen).toEqual([]);
    rig.transport.close("case over");
  });

  it("drops the oldest settled invocation past the bound, refusing it rather than running it ungated", async () => {
    const rig = invocationRig();
    const frames: Frame[] = [];
    for (let index = 0; index <= SETTLED_INVOCATIONS_MAX; index += 1) {
      const call = await callTools(rig, 1, index);
      frames.push(call.frames[0]!);
      rig.deliver({ jsonrpc: "2.0", id: call.frames[0]!.id as string, result: { content: [] } });
      await call.replies[0];
    }
    const evicted = await raiseAlertFromChild(rig, "evicted", tokenOf(frames[0]!));
    expect(evicted.error).toMatchObject({ data: { code: "argument-marshalling-rejected" } });
    const kept = await raiseAlertFromChild(rig, "kept", tokenOf(frames[1]!));
    expect(kept).toMatchObject({ result: { status: "raised" } });
    expect(rig.seen).toEqual(["call-1"]);
    rig.transport.close("case over");
  });

  it("keeps a live call resolvable while later settled calls overflow retention", async () => {
    const rig = invocationRig();
    const live = await callTools(rig, 1);
    const rejected = expect(live.replies[0]).rejects.toThrow("case over");
    try {
      let oldest: Frame | undefined;
      for (let index = 0; index <= SETTLED_INVOCATIONS_MAX; index += 1) {
        const call = await callTools(rig, 1, index + 1);
        oldest ??= call.frames[0];
        rig.deliver({ jsonrpc: "2.0", id: call.frames[0]!.id as string, result: { content: [] } });
        await call.replies[0];
      }
      expect(invocationCounts(rig.transport)).toEqual({ live: 1, settled: SETTLED_INVOCATIONS_MAX });
      const late = await raiseAlertFromChild(rig, "live-write", tokenOf(live.frames[0]!));
      expect(late).toMatchObject({ result: { status: "raised" } });
      const evicted = await raiseAlertFromChild(rig, "settled-write", tokenOf(oldest!));
      expect(evicted.error).toMatchObject({ data: { code: "argument-marshalling-rejected" } });
      expect(rig.seen).toEqual(["call-0"]);
    } finally {
      rig.transport.close("case over");
      await rejected;
    }
  });

  it("refuses excess live calls without evicting an admitted invocation", async () => {
    const pluginId = "blockedprobe";
    const rig = invocationRig({ pluginId });
    const held = await callTools(rig, LIVE_INVOCATIONS_MAX);
    const pending = Promise.allSettled(held.replies);
    let failure: unknown;
    const overflow = rig.transport.requestMcp("tools/call", { name: "speak", arguments: {} })
      .catch((error: unknown) => { failure = error; });
    try {
      await settle();
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toMatch(/too many tool calls in flight/);
      expect(String(failure)).toContain(pluginId);
      expect(String(failure)).toMatch(/restart the plugin/);
      expect(rig.sent.filter((frame) => frame.method === "tools/call")).toHaveLength(LIVE_INVOCATIONS_MAX);
      expect(invocationCounts(rig.transport)).toEqual({ live: LIVE_INVOCATIONS_MAX, settled: 0 });
      const first = await raiseAlertFromChild(rig, "first-live", tokenOf(held.frames[0]!));
      expect(first).toMatchObject({ result: { status: "raised" } });
      expect(rig.seen).toEqual(["call-0"]);
      rig.deliver({ jsonrpc: "2.0", id: held.frames[0]!.id as string, result: { content: [] } });
      await held.replies[0];
      const next = rig.transport.requestMcp("tools/call", { name: "speak", arguments: {} });
      const nextRejected = expect(next).rejects.toThrow("case over");
      await settle();
      expect(invocationCounts(rig.transport)).toEqual({ live: LIVE_INVOCATIONS_MAX, settled: 1 });
      rig.transport.close("case over");
      await nextRejected;
    } finally {
      rig.transport.close("case over");
      await pending;
      await overflow;
    }
  });

  it.each(["close", "peer-gone", "fault", "timeout"] as const)("releases settled and live snapshots on %s", async (ending) => {
    const rig = invocationRig();
    const calls = await callTools(rig, 2);
    const rejected = expect(calls.replies[1]).rejects.toThrow();
    rig.deliver({ jsonrpc: "2.0", id: calls.frames[0]!.id as string, result: { content: [] } });
    await calls.replies[0];
    expect(invocationCounts(rig.transport)).toEqual({ live: 1, settled: 1 });
    if (ending === "peer-gone") rig.fireGone("child crashed");
    else if (ending === "fault") rig.fireFault("pipe failed");
    else if (ending === "timeout") {
      await expect(rig.transport.request("ave/instance/start", {}, 20)).rejects.toThrow(/exceeded 20ms/);
    } else rig.transport.close("retired for restart");
    expect(invocationCounts(rig.transport)).toEqual({ live: 0, settled: 0 });
    await rejected;
    expect(invocationCounts(rig.transport)).toEqual({ live: 0, settled: 0 });
  });

  it.each(["close", "peer-gone"] as const)("releases snapshots before a subscription teardown throws on %s", async (ending) => {
    const rig = invocationRig({ teardown: () => { throw new Error("subscription cleanup failed"); } });
    const calls = await callTools(rig, 2);
    const rejected = expect(calls.replies[1]).rejects.toThrow();
    rig.deliver({ jsonrpc: "2.0", id: calls.frames[0]!.id as string, result: { content: [] } });
    await calls.replies[0];
    rig.deliver({ jsonrpc: "2.0", id: "subscribe", method: hostApiMethodOf("onEvent"), params: { eventType: "probe.event", handler: "events" } });
    await vi.waitFor(() => expect(rig.sent.some((frame) => frame.id === "subscribe")).toBe(true));
    expect(rig.sent.find((frame) => frame.id === "subscribe")).toMatchObject({ result: { handleId: "events" } });
    try {
      expect(() => ending === "close" ? rig.transport.close("retired") : rig.fireGone("crashed"))
        .toThrow("subscription cleanup failed");
      expect(invocationCounts(rig.transport)).toEqual({ live: 0, settled: 0 });
    } finally {
      await rejected;
    }
  });

  it("releases snapshots and rejects pending calls even when termination throws", async () => {
    const rig = invocationRig({ terminate: () => { throw new Error("termination failed"); } });
    const calls = await callTools(rig, 2);
    const pending = observe(calls.replies[1]!);
    rig.deliver({ jsonrpc: "2.0", id: calls.frames[0]!.id as string, result: { content: [] } });
    await calls.replies[0];
    expect(() => rig.transport.close("retired")).toThrow("termination failed");
    await settle();
    expect(pending()).toBe(true);
    expect(invocationCounts(rig.transport)).toEqual({ live: 0, settled: 0 });
    await expect(calls.replies[1]).rejects.toThrow("retired");
  });

  it.each(["foreign-plugin", "previous-generation"] as const)("refuses a token from a %s connection", async (source) => {
    const issuer = invocationRig({ pluginId: "issuer" });
    const recipient = invocationRig({ pluginId: source === "previous-generation" ? "issuer" : "recipient" });
    const call = await callTools(issuer, 1);
    const pending = expect(call.replies[0]).rejects.toThrow();
    try {
      const token = tokenOf(call.frames[0]!);
      const reply = await raiseAlertFromChild(recipient, "replay", token);
      expect(reply.error).toMatchObject({ data: { code: "argument-marshalling-rejected" } });
      if (source === "previous-generation") {
        issuer.transport.close("restarted");
        const afterClose = await raiseAlertFromChild(recipient, "replay-after-close", token);
        expect(afterClose.error).toMatchObject({ data: { code: "argument-marshalling-rejected" } });
      }
      expect(recipient.seen).toEqual([]);
    } finally {
      issuer.transport.close("case over");
      recipient.transport.close("case over");
      await pending;
    }
  });

  it("accepts older child metadata that does not use the host invocation key", async () => {
    const rig = invocationRig();
    const call = await callTools(rig, 1);
    const pending = expect(call.replies[0]).rejects.toThrow();
    try {
      rig.deliver({
        jsonrpc: "2.0", id: "legacy", method: hostApiMethodOf("raiseAlert"),
        params: { input: { kind: "reply", key: "legacy" }, _meta: { progressToken: "older-progress", "sdk.example/invocation": "older-correlation" } },
      });
      await vi.waitFor(() => expect(rig.sent.some((frame) => frame.id === "legacy")).toBe(true));
      expect(rig.sent.find((frame) => frame.id === "legacy")).toMatchObject({ result: { status: "raised" } });
      expect(rig.seen).toEqual([undefined]);
    } finally {
      rig.transport.close("case over");
      await pending;
    }
  });

  it("bounds tokenless-write diagnostics per path and excludes argument values", async () => {
    dispatcherWarn.mockClear();
    const rig = invocationRig();
    const call = await callTools(rig, 1);
    const pending = expect(call.replies[0]).rejects.toThrow();
    try {
      for (let index = 0; index < 100; index += 1) {
        const reply = await raiseAlertFromChild(rig, `secret-argument-${String(index)}`);
        expect(reply).toMatchObject({ result: { status: "raised" } });
      }
      expect(dispatcherWarn).toHaveBeenCalledTimes(1);
      expect(dispatcherWarn.mock.calls[0]![0]).toEqual({ pluginId: "transportprobe", path: "raiseAlert", toolCallsInFlight: 1 });
      expect(JSON.stringify(dispatcherWarn.mock.calls)).not.toContain("secret-argument");
    } finally {
      rig.transport.close("case over");
      await pending;
    }
  });

  it("records inline-gated fetch writes without logging their URL, headers or body", async () => {
    dispatcherWarn.mockClear();
    const rig = invocationRig();
    const call = await callTools(rig, 1);
    const pending = expect(call.replies[0]).rejects.toThrow();
    try {
      for (const method of ["GET", "HEAD", "OPTIONS", "post", "PATCH"]) {
        rig.deliver({
          jsonrpc: "2.0", id: method, method: hostApiMethodOf("hostFetch"),
          params: { input: "https://example.test/?token=url-secret", init: await encodeHostFetchInit({ method, headers: { Authorization: "header-secret" }, body: "body-secret" }, "fetch diagnostic") },
        });
        await vi.waitFor(() => expect(rig.sent.some((frame) => frame.id === method)).toBe(true));
        expect(rig.sent.find((frame) => frame.id === method)).toMatchObject({ result: { status: 200 } });
        expect(dispatcherWarn).toHaveBeenCalledTimes(method === "post" || method === "PATCH" ? 1 : 0);
      }
      expect(dispatcherWarn.mock.calls[0]![0]).toEqual({ pluginId: "transportprobe", path: "hostFetch", toolCallsInFlight: 1 });
      expect(JSON.stringify(dispatcherWarn.mock.calls)).not.toMatch(/url-secret|header-secret|body-secret/);
    } finally {
      rig.transport.close("case over");
      await pending;
    }
  });

  it("records a gated write that names no invocation while a tool call is in flight", async () => {
    dispatcherWarn.mockClear();
    const rig = invocationRig();
    await raiseAlertFromChild(rig, "idle");
    expect(dispatcherWarn).not.toHaveBeenCalled();
    const { frames, replies } = await callTools(rig, 1);
    await raiseAlertFromChild(rig, "during");
    expect(dispatcherWarn).toHaveBeenCalledTimes(1);
    expect(dispatcherWarn.mock.calls[0]![0]).toEqual({
      pluginId: "transportprobe",
      path: "raiseAlert",
      toolCallsInFlight: 1,
    });
    rig.deliver({ jsonrpc: "2.0", id: frames[0]!.id as string, result: { content: [] } });
    await replies[0];
    await raiseAlertFromChild(rig, "after");
    expect(dispatcherWarn).toHaveBeenCalledTimes(1);
    rig.transport.close("case over");
  });
});
