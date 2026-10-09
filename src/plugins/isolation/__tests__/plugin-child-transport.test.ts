/**
 * The host end of a plugin child's pipes, on its own
 * (`docs/design/plugin-hostapi-protocol.md` §9.7, S1).
 *
 * Three things the transport owns and nothing above it can repair:
 *
 *  - It is the one producer of MCP request metadata on this channel, and
 *    `request` cannot become a second path for an MCP method.
 *  - An observed exit is not a requested termination: a child that left on
 *    its own is released and never terminated.
 *  - It starts the link's termination sequence at most once, and a fault that
 *    arrives while that sequence runs — synchronously from inside `terminate`,
 *    as a refused `kill()` reports — is recorded, never answered with a
 *    second `terminate`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { PassThrough } from "node:stream";
import { frameMessage, StdioFrameDecoder } from "../../../mcp/stdio-framing.js";
import { INVOCATION_META, RPC_METHOD_NOT_FOUND } from "../../../mcp/protocol-constants.js";
import { servePluginChild } from "../plugin-child-main.js";
import {
  defineHostApiPath,
  HOSTAPI_DISPATCH_TABLE,
  HostApiDispatcher,
} from "../host-api-dispatcher.js";
import { FRAME_BYTES_MAX, HOST_PROTOCOL_NOTIFICATIONS, hostApiMethodOf } from "../host-api-wire.js";
import {
  PluginChildTransport,
  pluginChildRequestMeta,
  SETTLED_INVOCATIONS_MAX,
  type ChildLink,
} from "../plugin-child-transport.js";
import { observe, settle } from "./stream-turns.js";

/** The dispatcher's own warnings, so a case can see the decision 63 record. */
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

/** The link's own handlers, so a case can report an exit or a fault. */
interface LinkHandlers {
  gone: Array<(reason: string) => void>;
  fault: Array<(reason: string) => void>;
}

/**
 * A link over two in-memory pipes whose `terminate` is recorded and whose
 * exit and faults the case fires by hand.
 */
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
    // A tools/call also names the host invocation it serves, by a fresh
    // opaque token (see INVOCATION_META); every other key is the S1 metadata.
    const { "ave/invocation": invocation, ...s1 } = params._meta as Record<string, unknown>;
    expect(invocation).toMatch(/^[0-9a-f-]{36}$/u);
    expect(s1).toEqual({
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    });
    expect(s1).toEqual(pluginChildRequestMeta());
    // The caller's params cross beside it, untouched.
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
    // A close after the exit has nothing left to end.
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
    // A fault ends the child; it is not the child's exit.
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

  /**
   * A link that models production's sequence: `terminate` sends SIGTERM and
   * arms ONE escalation timer, and each signal is refused — reported as a
   * fault synchronously, from inside the call that sent it, as Node emits a
   * refused `kill()`'s `error`.
   */
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
    // Nothing else crossed once the sequence began.
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

/** A store the host side enters around a call, standing in for the invocation's. */
const marker = new AsyncLocalStorage<string>();

interface InvocationRig {
  transport: PluginChildTransport;
  sent: Frame[];
  /** What `raiseAlert`'s implementation saw: the marker it ran under. */
  seen: Array<string | undefined>;
  /** The marker each `context.log` from the child was forwarded under. */
  logged: Array<string | undefined>;
  /** Write a frame from the "child", delivered in the context the link was made in. */
  deliver: (frame: Frame) => void;
}

/**
 * A transport made inside a marker, as a child spawned from inside a tool
 * call is, whose frames arrive in that context, as a real pipe's do.
 */
function invocationRig(): InvocationRig {
  const { link, childToHost, sent } = recordedLink();
  const seen: InvocationRig["seen"] = [];
  const logged: InvocationRig["logged"] = [];
  return marker.run("spawned-in", () => {
    const transport = new PluginChildTransport({
      pluginId: "transportprobe",
      isActive: () => true,
      log: () => void logged.push(marker.getStore()),
      reportUnknownField: () => undefined,
      link,
      table: {
        ...HOSTAPI_DISPATCH_TABLE,
        raiseAlert: defineHostApiPath("raiseAlert", async () => {
          seen.push(marker.getStore());
          return { status: "raised", alertId: "alert" } as never;
        }),
      },
    });
    transport.start();
    const deliver = AsyncResource.bind((frame: Frame) => void childToHost.write(frameMessage(frame)));
    return { transport, sent, seen, logged, deliver };
  });
}

/** Send `count` tools/calls, each under its own marker, and return their frames in order. */
async function callTools(rig: InvocationRig, count: number): Promise<{ frames: Frame[]; replies: Promise<unknown>[] }> {
  const before = rig.sent.length;
  const replies = Array.from({ length: count }, (_, index) =>
    marker.run(`call-${String(index)}`, () =>
      rig.transport.requestMcp("tools/call", { name: "speak", arguments: {} })));
  await settle();
  const frames = rig.sent.slice(before).filter((frame) => frame.method === "tools/call");
  expect(frames).toHaveLength(count);
  return { frames, replies };
}

function tokenOf(frame: Frame): string {
  return ((frame.params as Record<string, unknown>)._meta as Record<string, string>)[INVOCATION_META]!;
}

/** The child calls `raiseAlert`, naming `token` or none, and the host's reply. */
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
  await vi.waitFor(() => expect(rig.sent.some((frame) => frame.id === id)).toBe(true));
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
    const { frames, replies } = await callTools(rig, SETTLED_INVOCATIONS_MAX + 1);
    for (const frame of frames) {
      rig.deliver({ jsonrpc: "2.0", id: frame.id as string, result: { content: [] } });
    }
    await Promise.all(replies);
    const evicted = await raiseAlertFromChild(rig, "evicted", tokenOf(frames[0]!));
    expect(evicted.error).toMatchObject({ data: { code: "argument-marshalling-rejected" } });
    const kept = await raiseAlertFromChild(rig, "kept", tokenOf(frames[1]!));
    expect(kept).toMatchObject({ result: { status: "raised" } });
    expect(rig.seen).toEqual(["call-1"]);
    rig.transport.close("case over");
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
