// Worker stdio control v1, host side: one strict, bounded JSON-RPC 2.0 channel over a delegated worker's stdin and stdout.
// The channel carries no socket, port or loopback address; stdout is reserved for frames, so a stray log line is a violation, not data.
// Requests are never replayed: an incarnation that ends settles every pending call with `worker-incarnation-ended`.
import type { Readable, Writable } from "node:stream";

import { frameMessage, StdioFrameDecoder } from "../mcp/stdio-framing.js";
import {
  WORKER_CONTROL_FRAME_BYTES_MAX,
  WORKER_CONTROL_METHOD,
  WorkerControlError,
  type PluginWorkerExitReason,
  type WorkerControlRemoteError,
  type WorkerControlRequestHandler,
  type WorkerControlRequestOptions,
} from "../plugins/public-contract.js";
import { createLogger } from "../lib/logger.js";
import { errorMessage } from "../shared/error-message.js";
import { describeNonJson } from "../shared/json-representable.js";

export const WORKER_CONTROL_PROTOCOL = "ave-worker-stdio-control";
export const WORKER_CONTROL_VERSION = "1";
/** Outstanding requests allowed in each direction. */
export const WORKER_CONTROL_IN_FLIGHT_MAX = 64;
/** Bytes the host queues toward one worker's stdin before refusing new sends. */
const WORKER_CONTROL_QUEUE_BYTES_MAX = 2 * (WORKER_CONTROL_FRAME_BYTES_MAX + 1);
/** Worker notifications held until the plugin registers a listener; beyond this the worker is stopped. */
export const WORKER_CONTROL_UNCLAIMED_NOTIFICATIONS_MAX = 256;
/** Bytes of worker requests and notifications waiting for the plugin's handler or first listener; beyond this the worker is stopped with `output-overflow`. */
export const WORKER_CONTROL_UNCLAIMED_BYTES_MAX = WORKER_CONTROL_QUEUE_BYTES_MAX;
const log = createLogger("worker-stdio-control");
const WORKER_CONTROL_HOST_METHODS = {
  hello: "$/ave/hello",
  cancel: "$/ave/cancel",
  shutdown: "$/ave/shutdown",
} as const;
const RPC_REQUEST_CANCELLED = -32800;
const RPC_INTERNAL_ERROR = -32603;
const HELLO_ID = 0;
/** Longest string request id either side may use. */
export const WORKER_CONTROL_ID_STRING_MAX = 128;

/** A stdio-control worker never completed the host's hello. Wire code `worker-control-failed`. */
export class WorkerControlFailedError extends Error {
  readonly code = "worker-control-failed";
  constructor(message: string) {
    super(message);
    this.name = "WorkerControlFailedError";
  }
}

/** Why the channel ended, as the worker's exit reason reports it. */
export type WorkerControlEndReason = Extract<PluginWorkerExitReason, "control-violation" | "output-overflow">;

type FrameId = string | number;
type JsonRecord = Record<string, unknown>;

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  /** A cancelled request stays counted until the worker's late response arrives. */
  cancelled: boolean;
  detach?: () => void;
}

interface UnclaimedRequest {
  readonly id: FrameId;
  readonly method: string;
  readonly params: unknown;
  readonly bytes: number;
}

function unclaimedBytesOf(method: string, params: unknown): number {
  return method.length + (params === undefined ? 0 : JSON.stringify(params).length);
}

/** A plugin listener that throws must not become an uncaught exception in the host; the worker is not at fault. */
function deliverNotification(listener: (method: string, params: unknown) => void, method: string, params: unknown): void {
  try {
    listener(method, params);
  } catch (error) {
    log.warn(`[worker-stdio-control] a notification listener threw on '${method}': ${errorMessage(error)}`);
  }
}

function isFrameId(value: unknown): value is FrameId {
  if (typeof value === "string") return value.length > 0 && value.length <= WORKER_CONTROL_ID_STRING_MAX;
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function idKey(id: FrameId): string {
  return typeof id === "number" ? `n:${id}` : `s:${id}`;
}

function onlyKeys(frame: JsonRecord, allowed: readonly string[]): boolean {
  return Object.keys(frame).every((key) => allowed.includes(key));
}

function isRemoteError(value: unknown): value is WorkerControlRemoteError {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as JsonRecord;
  return onlyKeys(record, ["code", "message", "data"]) && Number.isSafeInteger(record.code)
    && typeof record.message === "string";
}

/** Plugin-side misuse is a programming error, reported synchronously with the reason. */
function assertWorkerControlCall(method: string, params: unknown): void {
  if (typeof method !== "string" || !WORKER_CONTROL_METHOD.test(method)) {
    throw new TypeError(
      `[worker-stdio-control] method '${String(method)}' must match ${String(WORKER_CONTROL_METHOD)}`,
    );
  }
  const nonJson = describeNonJson(params, "params");
  if (nonJson) throw new TypeError(`[worker-stdio-control] ${nonJson}`);
}

/**
 * One worker's control channel. Construct it with {@link openWorkerStdioControl}, which completes the hello first.
 * `onEnd` fires once when the worker broke the protocol or overflowed; the owner then stops the process.
 */
export class WorkerStdioControl {
  private readonly decoder = new StdioFrameDecoder(WORKER_CONTROL_FRAME_BYTES_MAX, { strict: true });
  private nextId = HELLO_ID + 1;
  private readonly outgoing = new Map<string, PendingRequest>();
  private readonly incoming = new Map<string, AbortController>();
  private readonly unclaimedRequests: UnclaimedRequest[] = [];
  private unclaimedNotifications: Array<{ method: string; params: unknown; bytes: number }> = [];
  /** Approximate JSON bytes held in the two unclaimed queues. */
  private unclaimedBytes = 0;
  private requestHandler: WorkerControlRequestHandler | undefined;
  private readonly notificationListeners: Array<(method: string, params: unknown) => void> = [];
  private hello: { resolve: () => void; reject: (error: Error) => void } | undefined;
  private ended = false;

  constructor(
    private readonly stdin: Writable,
    private readonly stdout: Readable,
    private readonly onEnd: (reason: WorkerControlEndReason, detail: string) => void,
  ) {
    this.stdout.on("data", this.onData);
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** @internal Sends the hello and settles when the worker answers it, or rejects on a violation. */
  greet(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.violate(`no answer to ${WORKER_CONTROL_HOST_METHODS.hello} within ${timeoutMs}ms`), timeoutMs);
      this.hello = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      this.write({
        jsonrpc: "2.0",
        id: HELLO_ID,
        method: WORKER_CONTROL_HOST_METHODS.hello,
        params: {
          protocol: WORKER_CONTROL_PROTOCOL,
          versions: [WORKER_CONTROL_VERSION],
          frameBytesMax: WORKER_CONTROL_FRAME_BYTES_MAX,
        },
      }).catch((error: unknown) => this.violate(`hello could not be written: ${errorMessage(error)}`));
    });
  }

  request(method: string, params?: unknown, options: WorkerControlRequestOptions = {}): Promise<unknown> {
    assertWorkerControlCall(method, params);
    if (this.ended) return Promise.reject(ended());
    if (options.signal?.aborted) return Promise.reject(cancelled(method));
    if (this.outgoing.size >= WORKER_CONTROL_IN_FLIGHT_MAX) {
      return Promise.reject(new WorkerControlError(
        "worker-backpressure",
        `[worker-stdio-control] ${WORKER_CONTROL_IN_FLIGHT_MAX} requests are already waiting for this worker`,
      ));
    }
    const id = this.nextId++;
    const frame = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
    const refusal = this.refuseFrame(frame);
    if (refusal) return Promise.reject(refusal);
    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject, cancelled: false };
      this.outgoing.set(idKey(id), pending);
      const signal = options.signal;
      if (signal) {
        const onAbort = (): void => {
          if (pending.cancelled || !this.outgoing.has(idKey(id))) return;
          pending.cancelled = true;
          reject(cancelled(method));
          this.writeBounded({ jsonrpc: "2.0", method: WORKER_CONTROL_HOST_METHODS.cancel, params: { id } });
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.detach = () => signal.removeEventListener("abort", onAbort);
      }
      this.write(frame).catch(() => {
        // A failed write means the pipe is gone; the exit settles this request with incarnation-ended.
      });
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    assertWorkerControlCall(method, params);
    if (this.ended) return Promise.reject(ended());
    const frame = { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
    const refusal = this.refuseFrame(frame);
    if (refusal) return Promise.reject(refusal);
    return this.write(frame).catch(() => {
      throw ended();
    });
  }

  onRequest(handler: WorkerControlRequestHandler): void {
    if (typeof handler !== "function") throw new TypeError("[worker-stdio-control] onRequest needs a function");
    if (this.requestHandler) throw new Error("[worker-stdio-control] a request handler is already registered");
    this.requestHandler = handler;
    for (const request of this.unclaimedRequests.splice(0)) {
      this.unclaimedBytes -= request.bytes;
      this.runHandler(request);
    }
  }

  onNotification(listener: (method: string, params: unknown) => void): void {
    if (typeof listener !== "function") throw new TypeError("[worker-stdio-control] onNotification needs a function");
    this.notificationListeners.push(listener);
    const queued = this.unclaimedNotifications;
    this.unclaimedNotifications = [];
    for (const { method, params, bytes } of queued) {
      this.unclaimedBytes -= bytes;
      deliverNotification(listener, method, params);
    }
  }

  /** Orderly stop: tell the worker, then close its stdin. Every pending call settles now; none is replayed. */
  close(): void {
    if (this.ended) return;
    // The shutdown frame is a courtesy: a worker that stopped reading gets no frame queued behind its backlog, only the EOF and the kill that follow.
    const shutdown = frameMessage({ jsonrpc: "2.0", method: WORKER_CONTROL_HOST_METHODS.shutdown });
    if (this.stdin.writableLength + shutdown.length <= WORKER_CONTROL_QUEUE_BYTES_MAX) {
      try {
        this.stdin.write(shutdown, () => {});
      } catch {
        // The pipe may already be gone with the process.
      }
    }
    this.finish(ended());
    try {
      this.stdin.end();
    } catch {
      // The pipe may already be gone with the process.
    }
  }

  /** The process is gone: settle what remains. */
  processEnded(): void {
    this.finish(ended());
  }

  /** Stop reading the worker's stdout until {@link resumeInput}: the pipe fills and the worker blocks on its own writes. */
  pauseInput(): void {
    if (!this.ended) this.stdout.pause();
  }

  resumeInput(): void {
    if (!this.ended) this.stdout.resume();
  }

  private finish(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.stdout.off("data", this.onData);
    // Keep draining so a still-living worker cannot block on a full pipe while it is being stopped.
    this.stdout.resume();
    this.hello?.reject(new WorkerControlFailedError(error.message));
    this.hello = undefined;
    for (const pending of this.outgoing.values()) {
      pending.detach?.();
      if (!pending.cancelled) pending.reject(error);
    }
    this.outgoing.clear();
    for (const controller of this.incoming.values()) controller.abort(error);
    this.incoming.clear();
    this.unclaimedRequests.length = 0;
    this.unclaimedNotifications = [];
    this.unclaimedBytes = 0;
  }

  private violate(detail: string, reason: WorkerControlEndReason = "control-violation"): void {
    if (this.ended) return;
    // finish() rejects a pending hello with this detail as a WorkerControlFailedError.
    this.finish(new WorkerControlError("worker-incarnation-ended", `[worker-stdio-control] ${detail}`));
    this.onEnd(reason, detail);
  }

  private refuseFrame(frame: unknown): WorkerControlError | undefined {
    const bytes = frameMessage(frame).length;
    if (bytes - 1 > WORKER_CONTROL_FRAME_BYTES_MAX) {
      return new WorkerControlError(
        "payload-too-large",
        `[worker-stdio-control] a ${bytes - 1}-byte frame exceeds the ${WORKER_CONTROL_FRAME_BYTES_MAX}-byte limit`,
      );
    }
    if (this.stdin.writableLength + bytes > WORKER_CONTROL_QUEUE_BYTES_MAX) {
      return new WorkerControlError(
        "worker-backpressure",
        "[worker-stdio-control] the worker is not reading its stdin; the bounded queue is full",
      );
    }
    return undefined;
  }

  private write(frame: unknown): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.stdin.write(frameMessage(frame), (error) => (error ? reject(error) : resolve()));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Write a frame the host owes the worker (a response or a cancel). A worker that has stopped reading its stdin cannot be
   * owed more than the queue bound: the channel ends instead of buffering in the host. */
  private writeBounded(frame: JsonRecord): void {
    const bytes = frameMessage(frame).length;
    if (this.stdin.writableLength + bytes > WORKER_CONTROL_QUEUE_BYTES_MAX) {
      this.violate("the worker is not reading its stdin");
      return;
    }
    void this.write(frame).catch(() => {});
  }

  private readonly onData = (chunk: Buffer): void => {
    if (this.ended) return;
    let frames: JsonRecord[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      this.violate(`stdout carried something other than a frame: ${errorMessage(error)}`);
      return;
    }
    for (const frame of frames) {
      if (this.ended) return;
      this.receive(frame);
    }
  };

  private receive(frame: JsonRecord): void {
    if (frame.jsonrpc !== "2.0") return this.violate("a frame without jsonrpc \"2.0\"");
    if (this.hello) return this.receiveHello(frame);
    if (typeof frame.method === "string") {
      if ("id" in frame) return this.receiveRequest(frame);
      return this.receiveNotification(frame);
    }
    if ("method" in frame) return this.violate("a frame whose method is not a string");
    return this.receiveResponse(frame);
  }

  private receiveHello(frame: JsonRecord): void {
    const result = frame.result as JsonRecord | undefined;
    if (frame.id !== HELLO_ID || !onlyKeys(frame, ["jsonrpc", "id", "result"]) || result === null
      || typeof result !== "object" || Array.isArray(result) || !onlyKeys(result, ["protocol", "version"])
      || result.protocol !== WORKER_CONTROL_PROTOCOL || result.version !== WORKER_CONTROL_VERSION) {
      return this.violate(
        `the first frame must answer ${WORKER_CONTROL_HOST_METHODS.hello} with `
          + `{ protocol: "${WORKER_CONTROL_PROTOCOL}", version: "${WORKER_CONTROL_VERSION}" }`,
      );
    }
    const hello = this.hello!;
    this.hello = undefined;
    hello.resolve();
  }

  private receiveRequest(frame: JsonRecord): void {
    const { id, method, params } = frame as { id: unknown; method: string; params?: unknown };
    if (!onlyKeys(frame, ["jsonrpc", "id", "method", "params"]) || !isFrameId(id)) {
      return this.violate("a request with an invalid id or an unknown field");
    }
    if (!WORKER_CONTROL_METHOD.test(method)) return this.violate(`a request for method '${method}', which a worker may not send`);
    if (this.incoming.has(idKey(id))) return this.violate(`request id ${JSON.stringify(id)} is already outstanding`);
    if (this.incoming.size >= WORKER_CONTROL_IN_FLIGHT_MAX) {
      return this.violate(`more than ${WORKER_CONTROL_IN_FLIGHT_MAX} requests outstanding toward the plugin`);
    }
    // Count it now so the in-flight bound covers requests waiting for a handler too.
    this.incoming.set(idKey(id), new AbortController());
    if (this.requestHandler) {
      this.runHandler({ id, method, params, bytes: 0 });
      return;
    }
    const bytes = unclaimedBytesOf(method, params);
    if (!this.holdUnclaimed(bytes)) return;
    this.unclaimedRequests.push({ id, method, params, bytes });
  }

  private runHandler(request: UnclaimedRequest): void {
    const controller = this.incoming.get(idKey(request.id));
    if (!controller) return;
    const handler = this.requestHandler!;
    void Promise.resolve()
      .then(() => handler(request.method, request.params, controller.signal))
      .then(
        (result) => this.respond(request.id, controller, { result: result === undefined ? null : result }),
        (error: unknown) => this.respond(request.id, controller, { error: remoteErrorOf(error) }),
      );
  }

  private respond(id: FrameId, controller: AbortController, outcome: { result: unknown } | { error: WorkerControlRemoteError }): void {
    if (this.ended || this.incoming.get(idKey(id)) !== controller) return;
    this.incoming.delete(idKey(id));
    let body: { result: unknown } | { error: WorkerControlRemoteError } = controller.signal.aborted
      ? { error: { code: RPC_REQUEST_CANCELLED, message: "the worker cancelled this request" } }
      : outcome;
    if ("result" in body) {
      const nonJson = describeNonJson(body.result, "result");
      if (nonJson) body = { error: { code: RPC_INTERNAL_ERROR, message: `the plugin answered with ${nonJson}` } };
    }
    let frame: JsonRecord = { jsonrpc: "2.0", id, ...body };
    if (frameMessage(frame).length - 1 > WORKER_CONTROL_FRAME_BYTES_MAX) {
      frame = { jsonrpc: "2.0", id, error: { code: RPC_INTERNAL_ERROR, message: "the plugin's answer exceeds the frame limit" } };
    }
    this.writeBounded(frame);
  }

  private receiveNotification(frame: JsonRecord): void {
    const { method, params } = frame as { method: string; params?: unknown };
    if (!onlyKeys(frame, ["jsonrpc", "method", "params"])) return this.violate("a notification with an unknown field");
    if (method === WORKER_CONTROL_HOST_METHODS.cancel) {
      const target = (params as JsonRecord | undefined)?.id;
      if (params === null || typeof params !== "object" || !onlyKeys(params as JsonRecord, ["id"]) || !isFrameId(target)) {
        return this.violate(`${WORKER_CONTROL_HOST_METHODS.cancel} must name { id }`);
      }
      // Cancelling a request that already settled is a race, not a violation.
      this.incoming.get(idKey(target))?.abort(new WorkerControlError("worker-request-cancelled", "the worker cancelled this request"));
      return;
    }
    if (!WORKER_CONTROL_METHOD.test(method)) return this.violate(`a notification for method '${method}', which a worker may not send`);
    if (this.notificationListeners.length === 0) {
      if (this.unclaimedNotifications.length >= WORKER_CONTROL_UNCLAIMED_NOTIFICATIONS_MAX) {
        return this.violate(
          `more than ${WORKER_CONTROL_UNCLAIMED_NOTIFICATIONS_MAX} notifications arrived before the plugin listened`,
          "output-overflow",
        );
      }
      const bytes = unclaimedBytesOf(method, params);
      if (!this.holdUnclaimed(bytes)) return;
      this.unclaimedNotifications.push({ method, params, bytes });
      return;
    }
    for (const listener of this.notificationListeners) deliverNotification(listener, method, params);
  }

  private holdUnclaimed(bytes: number): boolean {
    if (this.unclaimedBytes + bytes > WORKER_CONTROL_UNCLAIMED_BYTES_MAX) {
      this.violate(`more than ${WORKER_CONTROL_UNCLAIMED_BYTES_MAX} bytes arrived before the plugin claimed them`, "output-overflow");
      return false;
    }
    this.unclaimedBytes += bytes;
    return true;
  }

  private receiveResponse(frame: JsonRecord): void {
    const { id } = frame;
    const hasResult = "result" in frame;
    const hasError = "error" in frame;
    if (!isFrameId(id) || hasResult === hasError || !onlyKeys(frame, ["jsonrpc", "id", "result", "error"])
      || (hasError && !isRemoteError(frame.error))) {
      return this.violate("a response must carry an id and exactly one of result and a well-formed error");
    }
    const pending = this.outgoing.get(idKey(id));
    if (!pending) return this.violate(`a response for id ${JSON.stringify(id)}, which the host never sent or already settled`);
    this.outgoing.delete(idKey(id));
    pending.detach?.();
    if (pending.cancelled) return;
    if (hasError) {
      const remote = frame.error as WorkerControlRemoteError;
      pending.reject(new WorkerControlError("worker-request-failed", remote.message, remote));
    } else {
      pending.resolve(frame.result);
    }
  }
}

function ended(): WorkerControlError {
  return new WorkerControlError("worker-incarnation-ended", "[worker-stdio-control] the worker incarnation ended; nothing is replayed");
}

function cancelled(method: string): WorkerControlError {
  return new WorkerControlError("worker-request-cancelled", `[worker-stdio-control] request '${method}' was cancelled`);
}

/** A handler's own WorkerControlError keeps its remote shape exactly, so relays pass errors through unchanged. */
function remoteErrorOf(error: unknown): WorkerControlRemoteError {
  if (error instanceof WorkerControlError && error.remote) return error.remote;
  if (error instanceof WorkerControlError && error.code === "worker-request-cancelled") {
    return { code: RPC_REQUEST_CANCELLED, message: error.message };
  }
  return { code: RPC_INTERNAL_ERROR, message: errorMessage(error) };
}

/**
 * Attach the channel and complete the hello. Rejects with {@link WorkerControlFailedError} when the worker does not
 * answer, answers wrongly or writes anything else first; the owner must then stop the process and await its exit.
 */
export async function openWorkerStdioControl(io: {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly helloMs: number;
  readonly onEnd: (reason: WorkerControlEndReason, detail: string) => void;
}): Promise<WorkerStdioControl> {
  const control = new WorkerStdioControl(io.stdin, io.stdout, io.onEnd);
  await control.greet(io.helloMs);
  return control;
}
