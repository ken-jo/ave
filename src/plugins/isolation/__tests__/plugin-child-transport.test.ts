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
import { PassThrough } from "node:stream";
import { StdioFrameDecoder } from "../../../mcp/stdio-framing.js";
import { RPC_METHOD_NOT_FOUND } from "../../../mcp/protocol-constants.js";
import { servePluginChild } from "../plugin-child-main.js";
import { HostApiDispatcher } from "../host-api-dispatcher.js";
import { FRAME_BYTES_MAX } from "../host-api-wire.js";
import {
  PluginChildTransport,
  pluginChildRequestMeta,
  type ChildLink,
} from "../plugin-child-transport.js";
import { observe, settle } from "./stream-turns.js";

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
    expect(params._meta).toEqual({
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    });
    expect(Object.keys(params._meta as object)).toHaveLength(2);
    expect(params._meta).toEqual(pluginChildRequestMeta());
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
