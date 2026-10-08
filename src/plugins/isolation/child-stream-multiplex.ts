/**
 * One framed stdio stream, both directions of one JSON-RPC 2.0 session
 * (`docs/blueprints/plugin-process-isolation.md` §5.2,
 * `docs/design/plugin-hostapi-protocol.md` §3.1).
 *
 * The host owns the child's pipes, and both halves of the protocol share them:
 * MCP and `ave/instance/*` requests travel host→child, `ave/host/*` requests
 * travel child→host, and notifications travel both ways. §5.2 chose a spawned
 * stdio child precisely BECAUSE its argv can be wrapped by ASRT, so a second
 * channel (a socket, an extra descriptor) would have to be carried through the
 * sandbox wrap as well.
 *
 * Every frame is JSON-RPC, so {@link classifyMultiplexedMessage} discriminates
 * on JSON-RPC fields only: a `method` with an `id` is a request, routed by its
 * namespace; a `method` without one is a notification; an `id` with `result` or
 * `error` is a response, matched against the pending table of the direction it
 * arrived on. The `ave/` prefix is what keeps the Ave methods apart from every
 * name MCP defines. A frame matching none of these is `unknown` and is DROPPED
 * by both sides rather than guessed at — guessing is how a malformed frame
 * becomes a call to the wrong handler.
 *
 * ELECTRON-FREE BY CONSTRUCTION: the child imports this.
 */
import type { Readable, Writable } from "node:stream";
import { frameMessage, StdioFrameDecoder } from "../../mcp/stdio-framing.js";
import { errorMessage } from "../../shared/error-message.js";
import {
  FRAME_BYTES_MAX,
  HostApiBoundaryError,
  isHostApiMethod,
  toHostApiRpcError,
} from "./host-api-wire.js";
import { isPluginInstanceMethod } from "./plugin-instance-wire.js";

/** A decoded frame, before anyone has decided what it is. */
export type MultiplexedMessage = Record<string, unknown>;

/**
 * What one frame is.
 *
 * `mcp-request` and `instance-request` are split because they are answered by
 * DIFFERENT handlers in the child — the `PluginMcpServer` and the lifecycle
 * handler — and routing them from one place is what keeps the child from
 * needing a second decoder. `host-request` is the reverse direction's request,
 * answered only by the host.
 */
export type MultiplexedKind =
  | "mcp-request"
  | "instance-request"
  | "host-request"
  | "notification"
  | "response"
  | "unknown";

export function classifyMultiplexedMessage(
  message: MultiplexedMessage,
): MultiplexedKind {
  const { method, id } = message;
  if (typeof method === "string") {
    if (id === undefined) {
      return method.startsWith("notifications/") && isParamsObject(message.params)
        ? "notification"
        : "unknown";
    }
    // A request whose id JSON-RPC does not allow could not be answered anyway.
    if (typeof id !== "string" && typeof id !== "number") return "unknown";
    if (isPluginInstanceMethod(method)) return "instance-request";
    if (isHostApiMethod(method)) return "host-request";
    return "mcp-request";
  }
  if (
    (typeof id === "string" || typeof id === "number")
    && ("result" in message || "error" in message)
  ) {
    return "response";
  }
  return "unknown";
}

/** A notification's params must be an object; anything else is not one. */
function isParamsObject(params: unknown): boolean {
  return typeof params === "object" && params !== null && !Array.isArray(params);
}

/**
 * A framed message stream over one pair of Node streams.
 *
 * ONE decoder per direction, which is the reason this is a class and not two
 * loose functions: attaching a second decoder to the same `Readable` would give
 * two consumers two independent views of the same bytes, and a partial frame
 * would then be reassembled twice.
 *
 * `onViolation` is how the owner learns the peer broke the framing — a line
 * past {@link FRAME_BYTES_MAX}. It is called once, reading stops, and ending
 * the channel is the owner's to do: the host kills the child, the child treats
 * the host as gone.
 *
 * `onDroppedNotification` is how the owner learns THIS side dropped a
 * notification too large to frame, so it can say so in its own log (see
 * {@link FramedMessageStream.send}).
 */
export class FramedMessageStream {
  private readonly decoder = new StdioFrameDecoder(FRAME_BYTES_MAX);
  private started = false;
  private violated = false;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly onMessage: (message: MultiplexedMessage) => void,
    private readonly onViolation: (reason: string) => void,
    private readonly onDroppedNotification: (dropped: DroppedNotification) => void,
  ) {}

  /** Bytes of a frame that started arriving and never ended. */
  get pendingBytes(): number {
    return this.decoder.pendingBytes;
  }

  start(): void {
    if (this.started) throw new Error("[child-stream-multiplex] already started");
    this.started = true;
    const onData = (chunk: Buffer): void => {
      let messages: Array<Record<string, unknown>>;
      try {
        messages = this.decoder.push(chunk);
      } catch (error) {
        if (this.violated) return;
        this.violated = true;
        this.input.off("data", onData);
        this.onViolation(errorMessage(error));
        return;
      }
      for (const message of messages) this.onMessage(message);
    };
    this.input.on("data", onData);
  }

  /**
   * Write one whole frame.
   *
   * Every writer on this side funnels through here so a frame is always one
   * `write` call, and one line: two writers can interleave whole frames but
   * never splice one line into another.
   *
   * The line bound is enforced HERE as well as by the reader, because the
   * reader's only answer to an over-long line is to end the channel, so a peer
   * that stays inside the protocol never trips the other end's kill — it is
   * left for a peer that skipped this check. What happens instead depends on
   * who is waiting:
   *
   *  - a reply is sent as a `payload-too-large` error for the same call, so its
   *    caller fails and nothing else does;
   *  - a request throws that error to its caller;
   *  - a notification is DROPPED and reported to the owner. Nobody waits for
   *    one, and what sends it — an event listener, `context.log`, a snapshot
   *    push — never throws in-process, so a throw here would surface in code
   *    that has no reason to expect one.
   */
  send(message: unknown): void {
    const frame = frameMessage(message);
    if (frame.length - 1 <= FRAME_BYTES_MAX) {
      this.output.write(frame);
      return;
    }
    const dropped = droppedNotificationOf(message, frame.length - 1);
    if (dropped) {
      this.onDroppedNotification(dropped);
      return;
    }
    this.output.write(frameMessage(refuseOversizedFrame(message, frame.length - 1)));
  }

  /**
   * Write a frame another writer already built — the child's MCP server, which
   * frames its own responses. Held to the same bound as {@link send}.
   */
  forward(frame: Buffer): void {
    if (frame.length - 1 <= FRAME_BYTES_MAX) {
      this.output.write(frame);
      return;
    }
    // Parsed only on this path: the id of the call it answers is inside.
    const message: unknown = JSON.parse(frame.toString("utf-8"));
    this.output.write(frameMessage(refuseOversizedFrame(message, frame.length - 1)));
  }
}

/** A notification {@link FramedMessageStream.send} did not write, for its owner's log. */
export interface DroppedNotification {
  /** The notification's method. */
  readonly method: string;
  /** The subscription it was for, when it was for one. */
  readonly subscriptionId?: string;
  readonly byteLength: number;
  readonly limit: number;
}

/** Describe `message` as a dropped notification, or `undefined` when it is not one. */
function droppedNotificationOf(message: unknown, lineBytes: number): DroppedNotification | undefined {
  const candidate = (message ?? {}) as MultiplexedMessage;
  if (classifyMultiplexedMessage(candidate) !== "notification") return undefined;
  const subscriptionId = (candidate.params as Record<string, unknown>).subscriptionId;
  return {
    method: String(candidate.method),
    ...(typeof subscriptionId === "string" ? { subscriptionId } : {}),
    byteLength: lineBytes,
    limit: FRAME_BYTES_MAX,
  };
}

/**
 * What an over-long message is sent as instead, or the error its writer gets.
 *
 * A REPLY becomes a refusal of the call it answers: the caller is waiting on
 * that id, and an error it can read is the difference between one failed call
 * and a peer that waits forever. A request has a caller on THIS side, so it
 * throws to that caller instead.
 */
function refuseOversizedFrame(message: unknown, lineBytes: number): unknown {
  const refusal = new HostApiBoundaryError(
    "payload-too-large",
    `[child-stream-multiplex] a ${lineBytes}-byte message exceeds the ${FRAME_BYTES_MAX}-byte frame limit`,
    { byteLength: lineBytes, limit: FRAME_BYTES_MAX },
  );
  const candidate = (message ?? {}) as MultiplexedMessage;
  if (classifyMultiplexedMessage(candidate) !== "response") throw refusal;
  return {
    jsonrpc: "2.0",
    id: candidate.id,
    error: toHostApiRpcError({
      code: refusal.code,
      name: refusal.name,
      message: refusal.message,
      detail: refusal.detail,
    }),
  };
}

/** A request awaiting its reply. */
interface PendingCall<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout | undefined;
}

/**
 * Correlate outbound requests with inbound replies, and fail every one of them
 * when the peer goes away.
 *
 * Both sides need this, each for the requests it sends, keyed by the JSON-RPC
 * `id` it allocated — so it is generic rather than written twice. {@link rejectAll} is the reason it exists at all: a pending call whose
 * peer died must REJECT, because a promise that never settles is exactly the
 * hung host this whole boundary is supposed to make impossible.
 */
export class PendingCallTable<T> {
  private readonly pending = new Map<string, PendingCall<T>>();
  private closedReason: string | undefined;

  get openCount(): number {
    return this.pending.size;
  }

  /**
   * Register a call.
   *
   * `timeoutMs` is optional and is left UNSET for tool calls on purpose: a
   * gated hostApi write can block on a human for as long as the human takes
   * (§7.5), and a boundary deadline there would abandon a call the host is
   * still servicing. The lifecycle requests, whose host-side bounds already
   * exist, pass their own.
   */
  register(
    key: string,
    timeoutMs: number | undefined,
    onTimeout: (key: string) => void,
  ): Promise<T> {
    if (this.closedReason !== undefined) {
      return Promise.reject(new Error(this.closedReason));
    }
    if (this.pending.has(key)) {
      return Promise.reject(
        new Error(`[child-stream-multiplex] duplicate pending call '${key}'`),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.pending.delete(key);
              onTimeout(key);
              reject(
                new Error(
                  `[child-stream-multiplex] call '${key}' exceeded ${timeoutMs}ms`,
                ),
              );
            }, timeoutMs);
      // `unref` so a pending deadline cannot by itself keep the host alive.
      timer?.unref?.();
      this.pending.set(key, { resolve, reject, timer });
    });
  }

  settle(key: string, value: T): boolean {
    const call = this.pending.get(key);
    if (!call) return false;
    this.pending.delete(key);
    if (call.timer) clearTimeout(call.timer);
    call.resolve(value);
    return true;
  }

  fail(key: string, error: Error): boolean {
    const call = this.pending.get(key);
    if (!call) return false;
    this.pending.delete(key);
    if (call.timer) clearTimeout(call.timer);
    call.reject(error);
    return true;
  }

  /** The peer is gone. Every pending call rejects and no new one is accepted. */
  rejectAll(reason: string): number {
    this.closedReason = reason;
    const calls = [...this.pending.values()];
    this.pending.clear();
    for (const call of calls) {
      if (call.timer) clearTimeout(call.timer);
      call.reject(new Error(reason));
    }
    return calls.length;
  }
}
