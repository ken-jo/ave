/** Own framing, call settlement and one child termination sequence; faults remain distinct from observed exit. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { createLogger } from "../../lib/logger.js";
import {
  classifyMultiplexedMessage,
  FramedMessageStream,
  PendingCallTable,
  type MultiplexedMessage,
} from "./child-stream-multiplex.js";
import {
  HostApiDispatcher,
  runOutsideInvocation,
  type HostApiDispatcherOptions,
  type InvocationContextRunner,
} from "./host-api-dispatcher.js";
import type { HostApiNotification, HostApiRequest } from "./host-api-wire.js";
import {
  PLUGIN_INSTANCE_METHODS,
  type PluginInstanceMethod,
} from "./plugin-instance-wire.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import {
  INVOCATION_META,
  MCP_PROTOCOL_VERSION,
  META_CLIENT_CAPABILITIES,
  META_PROTOCOL_VERSION,
} from "../../mcp/protocol-constants.js";

const log = createLogger("plugin-child-transport");

/** Keep a bounded settled-invocation cache for late work; evicted tokens refuse and active calls are never dropped. */
export const SETTLED_INVOCATIONS_MAX = 1024;

/** Bound unresolved calls even after callers detach. */
export const LIVE_INVOCATIONS_MAX = 64;

interface JsonRpcErrorBody {
  readonly code: number;
  readonly message: string;
  readonly data?: { readonly code?: unknown };
}

/** Preserve child JSON-RPC codes and error data so callers can distinguish protocol refusal from plugin failure. */
class PluginChildRequestError extends Error {
  readonly code: number;
  readonly boundaryCode: string | undefined;
  readonly body: JsonRpcErrorBody;

  constructor(method: string, body: JsonRpcErrorBody) {
    super(`[plugin-child-transport] ${method}: ${body.message}`);
    this.name = "PluginChildRequestError";
    this.code = body.code;
    this.boundaryCode = typeof body.data?.code === "string" ? body.data.code : undefined;
    this.body = body;
  }
}

export type PluginChildProbeReply =
  | { readonly result: unknown }
  | { readonly error: JsonRpcErrorBody };

/** All MCP requests share one metadata producer. */
export type PluginMcpRequestMethod =
  | "server/discover"
  | "tools/list"
  | "tools/call"
  | "resources/read";

const PLUGIN_MCP_REQUEST_METHODS: ReadonlySet<string> = new Set<PluginMcpRequestMethod>([
  "server/discover",
  "tools/list",
  "tools/call",
  "resources/read",
]);

const PLUGIN_INSTANCE_METHOD_SET: ReadonlySet<string> = new Set<string>(
  Object.values(PLUGIN_INSTANCE_METHODS),
);

/** Every MCP request needs required metadata; use stable protocol identity rather than release-specific app versions. */
export function pluginChildRequestMeta(): Record<string, unknown> {
  return {
    [META_PROTOCOL_VERSION]: MCP_PROTOCOL_VERSION,
    [META_CLIENT_CAPABILITIES]: {},
  };
}

export interface ChildLink {
  readonly input: Readable;
  readonly output: Writable;
  /** Start termination once; the link owns SIGTERM and escalation without transport retries. */
  terminate(reason: string): void;
  /** onGone means terminal exit or failed spawn with no process, never a fault on a live child. */
  onGone(handler: (reason: string) => void): void;
  /** Live-process errors report through onFault until actual exit. */
  onFault(handler: (reason: string) => void): void;
}

export interface PluginChildTransportOptions
  extends Omit<HostApiDispatcherOptions, "notifications" | "shutdownChild" | "invocations"> {
  readonly link: ChildLink;
}

export class PluginChildTransport {
  private readonly stream: FramedMessageStream;
  private readonly pending = new PendingCallTable<unknown>();
  private readonly dispatcher: HostApiDispatcher;
  private readonly link: ChildLink;
  private readonly pluginId: string;
  private closedReason: string | undefined;
  /** Mark termination started before calling the link because signal faults can reenter synchronously. */
  private terminating = false;
  private exitReason: string | undefined;
  private resolveExited!: (reason: string) => void;
  /** Only observed terminal exit settles exited; close, timeout and fault do not. */
  readonly exited: Promise<string> = new Promise((resolve) => {
    this.resolveExited = resolve;
  });
  readonly terminationFaults: string[] = [];
  /** Resolve child invocation tokens to captured host gate, ledger and origin context. */
  private readonly liveInvocations = new Map<string, InvocationContextRunner>();
  /** Retain bounded settled contexts for late work; release all when the channel closes. */
  private readonly settledInvocations = new Map<string, InvocationContextRunner>();

  constructor(options: PluginChildTransportOptions) {
    this.link = options.link;
    this.dispatcher = new HostApiDispatcher({
      ...options,
      isActive: () => this.closedReason === undefined && options.isActive(),
      invocations: {
        resolve: (token) => this.liveInvocations.get(token) ?? this.settledInvocations.get(token),
        toolCallsInFlight: () => this.liveInvocations.size,
      },
      notifications: {
        deliver: (notification) => this.sendToChild(notification),
      },
      // Apply the shutdown-handler bound with grace so the host reports timeout before child termination.
      shutdownChild: async (subscriptionId) => {
        await this.request(
          PLUGIN_INSTANCE_METHODS.shutdown,
          { subscriptionId },
          TOOL_TIMEOUT_POLICY.pluginShutdownHandlerMs + TOOL_TIMEOUT_POLICY.pluginShutdownKillGraceMs,
        );
      },
    });
    this.pluginId = options.pluginId;
    this.stream = new FramedMessageStream(
      options.link.input,
      options.link.output,
      // Read pipe traffic outside spawn invocation context; restore only the request token context.
      (message) => runOutsideInvocation(() => this.route(message)),
      // Framing overflow kills the channel because subsequent boundaries cannot be trusted.
      (reason) => this.close(`[plugin-child-transport] ${reason}`),
      (dropped) => {
        log.warn(
          { pluginId: options.pluginId, ...dropped },
          "dropped a notification too large to frame",
        );
      },
    );
  }

  /** Attach exit and fault handlers before construct so setup failures reject its first request. */
  start(): void {
    this.link.onGone((reason) => this.peerGone(reason));
    this.link.onFault((reason) => this.fault(reason));
    this.stream.start();
  }

  /** Lifecycle calls carry existing caller bounds; do not add competing timeouts. */
  async request(
    method: PluginInstanceMethod,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (!PLUGIN_INSTANCE_METHOD_SET.has(method)) {
      throw new Error(
        `[plugin-child-transport] '${String(method)}' is not an ave/instance method; `
          + "MCP requests go through requestMcp",
      );
    }
    return await this.send(method, params, timeoutMs);
  }

  /** Stamp metadata once and preserve caller fields; tool calls use the existing ceiling cancellation. */
  async requestMcp(
    method: PluginMcpRequestMethod,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (!PLUGIN_MCP_REQUEST_METHODS.has(method)) {
      throw new Error(`[plugin-child-transport] '${String(method)}' is not an MCP request this host sends`);
    }
    if (Object.prototype.hasOwnProperty.call(params, "_meta")) {
      throw new Error(
        `[plugin-child-transport] '${method}' params carry their own _meta; `
          + "the transport is the only producer of MCP request metadata",
      );
    }
    if (method !== "tools/call") {
      return await this.send(method, { ...params, _meta: pluginChildRequestMeta() }, timeoutMs);
    }
    if (this.closedReason !== undefined) throw new Error(this.closedReason);
    if (this.liveInvocations.size >= LIVE_INVOCATIONS_MAX) {
      throw new Error(
        `[plugin-child-transport] plugin '${this.pluginId}' has too many tool calls in flight; `
          + "restart the plugin to clear unresolved calls",
      );
    }
    // Capture invocation context in the actual caller async chain.
    const token = randomUUID();
    const invocation: InvocationContextRunner = AsyncLocalStorage.snapshot();
    this.liveInvocations.set(token, invocation);
    try {
      return await this.send(
        method,
        { ...params, _meta: { ...pluginChildRequestMeta(), [INVOCATION_META]: token } },
        timeoutMs,
      );
    } finally {
      this.liveInvocations.delete(token);
      this.retainSettled(token, invocation);
    }
  }

  /** Retain settled contexts only while the channel can receive requests. */
  private retainSettled(token: string, invocation: InvocationContextRunner): void {
    if (this.closedReason !== undefined) return;
    this.settledInvocations.set(token, invocation);
    if (this.settledInvocations.size > SETTLED_INVOCATIONS_MAX) {
      const oldest = this.settledInvocations.keys().next();
      if (!oldest.done) this.settledInvocations.delete(oldest.value);
    }
  }

  private releaseInvocations(): void {
    this.liveInvocations.clear();
    this.settledInvocations.clear();
  }

  /** Probe preserves raw success or error replies; a closed channel still rejects. */
  async probe(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<PluginChildProbeReply> {
    if (PLUGIN_INSTANCE_METHOD_SET.has(method) || PLUGIN_MCP_REQUEST_METHODS.has(method)) {
      throw new Error(
        `[plugin-child-transport] probe refuses '${method}'; it has its own request path`,
      );
    }
    try {
      return { result: await this.send(method, params ?? {}, undefined) };
    } catch (error) {
      if (error instanceof PluginChildRequestError) return { error: error.body };
      throw error;
    }
  }

  private async send(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number | undefined,
  ): Promise<unknown> {
    if (this.closedReason !== undefined) throw new Error(this.closedReason);
    const id = randomUUID();
    const settled = this.pending.register(id, timeoutMs, () => {
      // Terminate a child that outlives its request bound rather than leave unwatched plugin code running.
      this.close(`[plugin-child-transport] '${method}' timed out after ${String(timeoutMs)}ms`);
    });
    try {
      this.stream.send({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      // An unwritten oversized request cannot receive a reply.
      this.pending.fail(id, error as Error);
    }
    return await settled;
  }

  sendToChild(notification: HostApiNotification): void {
    if (this.closedReason !== undefined) return;
    this.stream.send(notification);
  }

  /** Close is idempotent; mark termination before fallible callbacks that can reenter. */
  close(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    this.terminating = true;
    // Release invocation contexts before signal or subscription cleanup can fail.
    this.releaseInvocations();
    this.logPartialFrame();
    try {
      this.link.terminate(reason);
    } finally {
      this.pending.rejectAll(reason);
      this.dispatcher.childGone();
    }
  }

  /** Observed exit performs close cleanup without signaling an already-gone child. */
  peerGone(reason: string): void {
    if (this.exitReason === undefined) {
      this.exitReason = reason;
      this.resolveExited(reason);
    }
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    this.releaseInvocations();
    this.logPartialFrame();
    this.pending.rejectAll(reason);
    this.dispatcher.childGone();
  }

  /** Record faults during termination without starting a second signal sequence. */
  fault(reason: string): void {
    if (this.exitReason !== undefined) return;
    if (!this.terminating) {
      this.close(reason);
      return;
    }
    this.terminationFaults.push(reason);
    log.warn(
      { pluginId: this.pluginId, reason },
      "the child faulted while its termination was in progress",
    );
  }

  /** Drop partial frames on close while distinguishing truncated output from a clean boundary. */
  private logPartialFrame(): void {
    if (this.stream.pendingBytes > 0) {
      log.debug(
        { pluginId: this.pluginId, pendingBytes: this.stream.pendingBytes },
        "channel closed with a partial frame unread",
      );
    }
  }

  private route(message: MultiplexedMessage): void {
    // Keep the existing inactive reply for late host requests while refusing
    // effects through the dispatcher's liveness predicate during native drain.
    if (this.closedReason !== undefined && classifyMultiplexedMessage(message) !== "host-request") return;
    switch (classifyMultiplexedMessage(message)) {
      case "response": {
        const id = String(message.id);
        if (message.error !== undefined) {
          this.pending.fail(
            id,
            new PluginChildRequestError(id, message.error as JsonRpcErrorBody),
          );
          return;
        }
        this.pending.settle(id, message.result);
        return;
      }
      case "host-request":
        void this.dispatcher
          .handle(message as unknown as HostApiRequest)
          .then((reply) => this.stream.send(reply));
        return;
      case "notification":
        this.dispatcher.handleNotification(message as unknown as HostApiNotification);
        return;
      default:
        // The host is only a client on these pipes; report server-directed or unknown frames without answering.
        return;
    }
  }
}
