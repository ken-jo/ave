// Multiplex one bounded JSON-RPC stream per direction; duplicate decoders can misroute frames.
// This module must remain safe to import in the child.
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

export type MultiplexedMessage = Record<string, unknown>;

/** Distinguish MCP, instance and reverse host requests because each has a different handler. */
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

function isParamsObject(params: unknown): boolean {
  return typeof params === "object" && params !== null && !Array.isArray(params);
}

/** Use one decoder per direction and report oversized outbound notifications through the owner. */
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

  get pendingBytes(): number {
    return this.decoder.pendingBytes;
  }

  start(): void {
    if (this.started) throw new Error("[child-stream-multiplex] already started");
    this.started = true;
    const onData = (chunk: Buffer): void => {
      if (this.violated) return;
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

  /** Write each complete frame once so concurrent writers cannot interleave its bytes. */
  send(message: unknown): void {
    if (this.violated) return;
    const frame = frameMessage(message);
    if (frame.length - 1 <= FRAME_BYTES_MAX) {
      this.write(frame);
      return;
    }
    const dropped = droppedNotificationOf(message, frame.length - 1);
    if (dropped) {
      this.onDroppedNotification(dropped);
      return;
    }
    this.write(frameMessage(refuseOversizedFrame(message, frame.length - 1)));
  }

  /** Prebuilt MCP frames obey the same outbound size limit. */
  forward(frame: Buffer): void {
    if (this.violated) return;
    if (frame.length - 1 <= FRAME_BYTES_MAX) {
      this.write(frame);
      return;
    }
    // Parse prebuilt frames only to recover their request ID.
    const message: unknown = JSON.parse(frame.toString("utf-8"));
    this.write(frameMessage(refuseOversizedFrame(message, frame.length - 1)));
  }

  /** Forward a prebuilt frame, then call `ready` only once the output has drained (or closed). A caller that
   * awaits `ready` before its next frame keeps at most one of its frames queued, so a burst of large results
   * waits upstream instead of reaching {@link OUTBOUND_QUEUE_BYTES_MAX}; the bound itself is unchanged. */
  forwardPaced(frame: Buffer, ready: () => void): void {
    this.forward(frame);
    if (this.violated || !this.output.writableNeedDrain || this.output.destroyed) {
      ready();
      return;
    }
    const resume = (): void => {
      this.output.off("drain", resume);
      this.output.off("close", resume);
      ready();
    };
    this.output.on("drain", resume);
    this.output.on("close", resume);
  }

  /** Synchronous protocol producers cannot await drain. Refuse a stalled peer
   * before its writable queue grows without bound; never drop a request silently. */
  private write(frame: Buffer): void {
    if (this.output.writableLength + frame.length > OUTBOUND_QUEUE_BYTES_MAX) {
      this.violated = true;
      this.onViolation("Plugin output queue exceeds limit");
      return;
    }
    this.output.write(frame);
  }
}

/** Headroom beside queued maximal frames for the small replies, notifications and cancellations that keep flowing. */
const OUTBOUND_QUEUE_HEADROOM_BYTES = 8 * 1024 * 1024;

/**
 * Bytes one direction may queue for a peer that has not yet read them, per connection.
 *
 * Two maximal frames (each `FRAME_BYTES_MAX` plus its newline) so two concurrent largest
 * replies still pass a slow-but-draining peer, plus fixed headroom for control traffic.
 * About 100 MB with the current frame limit, against roughly 183 MB for the earlier four-frame
 * bound. A queue past it means the peer has stopped reading for longer than any permitted
 * burst, so the channel ends as a violation instead of buffering without limit. This is
 * enforced on every plugin connection, confined or native, and is stricter than the
 * unbounded queue before it.
 */
export const OUTBOUND_QUEUE_BYTES_MAX = 2 * (FRAME_BYTES_MAX + 1) + OUTBOUND_QUEUE_HEADROOM_BYTES;

/** Report oversized notifications to their owner. */
export interface DroppedNotification {
  readonly method: string;
  readonly subscriptionId?: string;
  readonly byteLength: number;
  readonly limit: number;
}

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

/** Oversized replies must answer the original call with refusal; oversized requests throw to their local caller. */
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

interface PendingCall<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout | undefined;
}

/** Peer loss must reject every pending call in each direction. */
export class PendingCallTable<T> {
  private readonly pending = new Map<string, PendingCall<T>>();
  private closedReason: string | undefined;

  get openCount(): number {
    return this.pending.size;
  }

  /** Leave tool calls without a boundary timeout while host approval is pending; lifecycle callers supply their existing bounds. */
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

  /** Reject pending and future calls when the peer is gone. */
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
