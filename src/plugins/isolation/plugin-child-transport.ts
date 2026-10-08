/**
 * The host end of one plugin child's pipes
 * (`docs/blueprints/plugin-process-isolation.md` §5.2).
 *
 * It owns exactly one thing: turning a pair of streams into the two halves of
 * the protocol that run over them — outbound requests (the five lifecycle
 * methods of `plugin-instance-wire.ts` through {@link PluginChildTransport.request},
 * the MCP requests through {@link PluginChildTransport.requestMcp}, and the one
 * verbatim frame of {@link PluginChildTransport.probe}) and inbound `ave/host/*`
 * traffic, which it hands to a {@link HostApiDispatcher}.
 *
 * STREAM-INJECTED, not process-owning. The spawn, the ASRT wrap and the
 * managed-child registration live in `out-of-process-plugin.ts`; this class
 * takes a {@link ChildLink}. That split is what lets the protocol be exercised
 * over in-memory paired streams — the pattern `stdio-server-loop`'s own tests
 * use — while the confinement is exercised against a real process, instead of
 * one slow test having to prove both.
 *
 * A DEAD CHILD IS A FAILED CALL, never a hung one. Every pending request
 * rejects when the pipes close, and every host-side subscription the child
 * opened is released. That is the whole recovery §2.4 promises: today a hung
 * in-process handler detaches and holds a generation lease forever; here the
 * process dies and the lease goes with it.
 *
 * AN OBSERVED EXIT IS NOT A REQUESTED TERMINATION. A child that left on its own
 * ({@link ChildLink.onGone}) is released without being terminated
 * ({@link PluginChildTransport.peerGone}); the host ending a child
 * ({@link PluginChildTransport.close}) starts the link's one termination
 * sequence, and the transport starts it at most once in its lifetime.
 */
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
  type HostApiDispatcherOptions,
} from "./host-api-dispatcher.js";
import type { HostApiNotification, HostApiRequest } from "./host-api-wire.js";
import {
  PLUGIN_INSTANCE_METHODS,
  type PluginInstanceMethod,
} from "./plugin-instance-wire.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import {
  MCP_PROTOCOL_VERSION,
  META_CLIENT_CAPABILITIES,
  META_PROTOCOL_VERSION,
} from "../../mcp/protocol-constants.js";

const log = createLogger("plugin-child-transport");

/** A JSON-RPC error as it arrives from the child. */
interface JsonRpcErrorBody {
  readonly code: number;
  readonly message: string;
  readonly data?: { readonly code?: unknown };
}

/**
 * A failed request to the child, with the child's own JSON-RPC code preserved.
 *
 * The code is kept because the child distinguishes "the plugin is not
 * constructed yet" from "your method does not exist" from "the handler threw",
 * and collapsing all three into one message would leave the host unable to tell
 * a protocol mistake from a plugin bug. `boundaryCode` is the boundary's own
 * refusal code when the error carries one (`payload-too-large` for a result
 * too large to frame), so a caller can tell a refused call from a failed one.
 * `body` is the error exactly as it crossed, which is what
 * {@link PluginChildTransport.probe} answers with.
 */
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

/** What {@link PluginChildTransport.probe} answers: the reply's `result` or its `error`. */
export type PluginChildProbeReply =
  | { readonly result: unknown }
  | { readonly error: JsonRpcErrorBody };

/**
 * The MCP requests the host sends a plugin child.
 *
 * Exactly the four the out-of-process arm and the validator use. Each of them
 * goes through {@link PluginChildTransport.requestMcp}, which is the one place
 * the per-request MCP metadata is produced.
 */
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

/**
 * The `_meta` every MCP request on a plugin child's pipes carries.
 *
 * MCP `2026-07-28` makes both keys mandatory on every request, and a server
 * MUST refuse a request missing either with `-32602`. `clientCapabilities` is
 * empty because the host serves no server-to-client MCP request on these pipes
 * (see the `default` arm of the transport's router), so declaring one would
 * promise a surface this channel does not have. `clientInfo` is omitted: it is
 * a self-reported SHOULD that must not change behaviour, and an app version in
 * every request would make the goldens move at each release.
 */
export function pluginChildRequestMeta(): Record<string, unknown> {
  return {
    [META_PROTOCOL_VERSION]: MCP_PROTOCOL_VERSION,
    [META_CLIENT_CAPABILITIES]: {},
  };
}

/** The child's pipes plus the one thing only its owner can do: end it. */
export interface ChildLink {
  /** Framed messages FROM the child (its stdout). */
  readonly input: Readable;
  /** Framed messages TO the child (its stdin). */
  readonly output: Writable;
  /**
   * Start the link's whole termination sequence for the child.
   *
   * Called by {@link PluginChildTransport.close} and by nothing else, and at
   * most once per transport, so the transport never has to know whether it is
   * holding a real process or a pair of in-memory streams. A process link's
   * sequence escalates on its own (SIGTERM, then one SIGKILL after a grace
   * period); the transport never retries it.
   */
  terminate(reason: string): void;
  /**
   * The child no longer exists: the process exited, or a spawn produced no
   * process at all.
   *
   * TERMINAL ONLY. A fault on a child that is still running — a signal that
   * could not be delivered — is {@link onFault}, never this: reporting it here
   * would release a live process as if it were gone.
   */
  onGone(handler: (reason: string) => void): void;
  /**
   * Something went wrong with a child that still exists — for a process, an
   * `error` event while it has a pid, which Node emits when a signal could
   * not be delivered.
   *
   * Required, so a link that forgot the split fails to compile instead of
   * folding its faults into {@link onGone}. A link with no process to fault
   * registers the handler and never calls it.
   */
  onFault(handler: (reason: string) => void): void;
}

export interface PluginChildTransportOptions
  extends Omit<HostApiDispatcherOptions, "notifications" | "shutdownChild"> {
  readonly link: ChildLink;
}

export class PluginChildTransport {
  private readonly stream: FramedMessageStream;
  private readonly pending = new PendingCallTable<unknown>();
  private readonly dispatcher: HostApiDispatcher;
  private readonly link: ChildLink;
  private readonly pluginId: string;
  /** Why the channel stopped carrying calls: a requested close or an observed exit. */
  private closedReason: string | undefined;
  /**
   * Whether the link's termination sequence was ever started.
   *
   * Kept apart from {@link closedReason} because an observed exit closes the
   * channel without terminating anything, and set BEFORE `link.terminate` is
   * called, because a refused signal reports its fault synchronously from
   * inside that call.
   */
  private terminating = false;
  /** The exit the link reported, once it has. */
  private exitReason: string | undefined;
  private resolveExited!: (reason: string) => void;
  /**
   * Settles with the reason the link's `onGone` reported, and on nothing else.
   *
   * A deadline, a fault or a close does not settle it: each ends the child,
   * and this settles when that child's exit is then observed.
   */
  readonly exited: Promise<string> = new Promise((resolve) => {
    this.resolveExited = resolve;
  });
  /** Faults a live child reported while its termination sequence was running. */
  readonly terminationFaults: string[] = [];

  constructor(options: PluginChildTransportOptions) {
    this.link = options.link;
    this.dispatcher = new HostApiDispatcher({
      ...options,
      notifications: {
        deliver: (notification) => this.sendToChild(notification),
      },
      // Bounded by the per-handler limit the host's shutdown runner applies,
      // and enforced here as that runner cannot: a child whose handler
      // overruns it is killed by the request deadline. The deadline sits a
      // grace past the runner's, so the runner reports the overrun first and
      // the kill follows it.
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
      (message) => this.route(message),
      // A child that broke the framing is killed like one that stopped
      // answering: nothing it writes after an unbounded line can be trusted to
      // start on a line boundary.
      (reason) => this.close(`[plugin-child-transport] ${reason}`),
      (dropped) => {
        log.warn(
          { pluginId: options.pluginId, ...dropped },
          "dropped a notification too large to frame",
        );
      },
    );
  }

  /**
   * Begin reading, and start listening for the child going away or faulting.
   *
   * The handlers are attached HERE rather than at the first request: a child
   * that dies while it is still constructing must fail the construct call, and
   * construct is the first request there is.
   */
  start(): void {
    this.link.onGone((reason) => this.peerGone(reason));
    this.link.onFault((reason) => this.fault(reason));
    this.stream.start();
  }

  /**
   * Send one `ave/instance/*` request and await the child's reply.
   *
   * Instance methods only, with their params verbatim: they are Ave methods,
   * and the MCP metadata rule is MCP's. Any other method is an internal
   * contract violation and is refused, so this cannot become a second path for
   * an MCP request that would then cross without its metadata.
   *
   * `timeoutMs` is left UNSET by callers whose wait is already bounded on the
   * host side — a `start()` sits under `runStartWithTimeout`. Passing one here
   * in addition would put a second, quieter deadline on the same operation and
   * make which of them fired a matter of milliseconds.
   */
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

  /**
   * Send one MCP request with the metadata MCP requires, and await the reply.
   *
   * The one producer of that metadata on this channel. A caller-supplied
   * `_meta` is refused rather than merged: no caller sets one, and a merge
   * would make the producer's keys overridable. `timeoutMs` follows the rule
   * {@link request} states — a tool call sits under `runWithCeiling`.
   */
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
    return await this.send(method, { ...params, _meta: pluginChildRequestMeta() }, timeoutMs);
  }

  /**
   * Send one request verbatim and answer with the child's reply, error or not.
   *
   * For the unknown-method check, where the error IS the answer. It refuses
   * the methods {@link request} and {@link requestMcp} own, so it cannot become
   * a third path for either. A closed channel still rejects: that is not a
   * reply from the child.
   */
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
      // A request that outlived its deadline means the child stopped answering.
      // Killing it is the recovery, not an escalation: the alternative is a
      // confined process running plugin code that nothing is waiting for.
      this.close(`[plugin-child-transport] '${method}' timed out after ${String(timeoutMs)}ms`);
    });
    try {
      this.stream.send({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      // Refused before it was written (a request too large to frame), so no
      // reply will ever come for it.
      this.pending.fail(id, error as Error);
    }
    return await settled;
  }

  /** Push a host-originated notification to the child. */
  sendToChild(notification: HostApiNotification): void {
    if (this.closedReason !== undefined) return;
    this.stream.send(notification);
  }

  /**
   * The host ends the child: a request deadline, a fatal framing error, a
   * fault on a live child, or the session's teardown.
   *
   * Idempotent, because those can race each other and the child's own exit.
   * `terminating` is set before `link.terminate` is called: a refused signal
   * re-enters {@link fault} from inside that call, and must find the sequence
   * already running.
   */
  close(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    this.terminating = true;
    this.logPartialFrame();
    this.link.terminate(reason);
    this.pending.rejectAll(reason);
    this.dispatcher.childGone();
  }

  /**
   * The child is gone on its own. Everything {@link close} does except
   * `link.terminate`, which has nothing left to end.
   *
   * The exit is recorded even after a close, because it is what settles
   * {@link exited}.
   */
  peerGone(reason: string): void {
    if (this.exitReason === undefined) {
      this.exitReason = reason;
      this.resolveExited(reason);
    }
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    this.logPartialFrame();
    this.pending.rejectAll(reason);
    this.dispatcher.childGone();
  }

  /**
   * A live child faulted. Starts the one termination sequence if none is
   * running; with one running, the fault is recorded and nothing else happens
   * — the sequence's own escalation is the retry, and a second `terminate`
   * would start a second sequence.
   */
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

  /**
   * A frame cut off by the close is dropped with the channel. Said here,
   * quietly, so a child that died mid-write is distinguishable from one that
   * went away between messages.
   */
  private logPartialFrame(): void {
    if (this.stream.pendingBytes > 0) {
      log.debug(
        { pluginId: this.pluginId, pendingBytes: this.stream.pendingBytes },
        "channel closed with a partial frame unread",
      );
    }
  }

  private route(message: MultiplexedMessage): void {
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
        // An MCP request, an instance request, or an unrecognised frame. The
        // host is a client on these pipes and never a server, so a frame in the
        // server direction is a confused child — dropped, not answered, because
        // answering would mean implementing a surface the host does not have.
        return;
    }
  }
}
